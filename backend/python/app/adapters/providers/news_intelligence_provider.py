from __future__ import annotations

import html
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable

from .intelligence_providers import DEFAULT_TIMEOUT, USER_AGENT, FeedStatus


GOOGLE_NEWS_LIMIT = 8
LLM_GROUP_LIMIT = 5

A_SHARE_THEME_KEYWORDS = {
    "政策驱动": ("证监会", "国务院", "政策", "财政", "刺激"),
    "AI算力": ("ai", "人工智能", "算力", "gpu", "大模型"),
    "半导体": ("半导体", "芯片", "晶圆", "封测"),
    "机器人": ("机器人", "自动化", "工业母机"),
    "新能源": ("新能源", "电池", "储能", "光伏"),
}

CRYPTO_THEME_KEYWORDS = {
    "比特币主线": ("bitcoin", "btc", "比特币"),
    "以太坊生态": ("ethereum", "eth", "layer 2", "rollup", "以太坊"),
    "交易所动态": ("binance", "okx", "coinbase", "交易所", "上线", "下线"),
    "监管与ETF": ("etf", "sec", "监管", "合规"),
    "山寨轮动": ("solana", "sol", "meme", "altcoin", "山寨"),
}

A_SHARE_NEWS_QUERIES = (
    {"group_id": "policy", "label": "政策风向", "query": "A股 证监会 政策 财联社 上证 沪深"},
    {"group_id": "industry", "label": "产业景气", "query": "A股 半导体 人工智能 储能 机器人"},
    {"group_id": "bluechip", "label": "龙头公司", "query": "A股 茅台 宁德时代 赛力斯 平安银行"},
)

CRYPTO_NEWS_QUERIES = (
    {"group_id": "exchange", "label": "交易所公告", "query": "Binance OKX 上线 下线 公告 交易所"},
    {"group_id": "btc", "label": "比特币主线", "query": "Bitcoin BTC ETF 宏观 利率"},
    {"group_id": "eth", "label": "以太坊生态", "query": "Ethereum ETH Layer 2 Rollup DeFi"},
)

NEWS_PROMO_KEYWORDS = (
    "开户链接",
    "返佣",
    "邀请码",
    "注册即送",
    "注册送彩金",
    "空投领取",
    "限时福利",
    "稳赚",
    "带单",
    "喊单",
    "高收益",
    "稳赚不赔",
    "免费提现",
    "下载app",
)

NEWS_SOURCE_BLOCKLIST = (
    "pr newswire",
    "globenewswire",
    "business wire",
    "accesswire",
    "newsfile",
    "benzinga",
)


class GoogleNewsGroupingProvider:
    def __init__(
        self,
        *,
        now_ms: Callable[[], int],
        llm_enabled_getter: Callable[[], bool],
        llm_chat_requester: Callable[[list[dict[str, str]]], str],
    ) -> None:
        self.now_ms = now_ms
        self.llm_enabled_getter = llm_enabled_getter
        self.llm_chat_requester = llm_chat_requester

    def fetch_news_groups(
        self,
        market: str,
        source_prefix: str,
        queries: Iterable[dict[str, str]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[FeedStatus]]:
        groups: list[dict[str, Any]] = []
        combined: list[dict[str, Any]] = []
        statuses: list[FeedStatus] = []
        llm_enabled = self.llm_enabled_getter()
        llm_group_status_added = False
        for query_spec in queries:
            items, status = self._fetch_google_news(
                source_id=f"{source_prefix}-{query_spec['group_id']}",
                label=f"新闻聚合·{query_spec['label']}",
                query=query_spec["query"],
                market=market,
            )
            group_summary = items[0]["title"] if items else "暂无相关新闻"
            if llm_enabled and items:
                items, group_summary, llm_ok, llm_detail = self._apply_llm_group_filter(
                    market,
                    query_spec["label"],
                    items,
                )
                if not llm_group_status_added:
                    statuses.append(
                        FeedStatus(
                            f"{source_prefix}-llm",
                            f"{'A股' if market == 'a_share' else '加密'} LLM 去噪",
                            llm_ok,
                            llm_detail,
                            self.now_ms(),
                        )
                    )
                    llm_group_status_added = True
            groups.append(
                {
                    "groupId": query_spec["group_id"],
                    "label": query_spec["label"],
                    "count": len(items),
                    "summary": group_summary,
                    "items": items[:4],
                }
            )
            combined.extend(items)
            statuses.append(status)
        return groups, self.dedupe_headlines(combined)[:12], statuses

    def build_themes(
        self,
        headlines: list[dict[str, Any]],
        market: str,
    ) -> list[dict[str, Any]]:
        keyword_map = A_SHARE_THEME_KEYWORDS if market == "a_share" else CRYPTO_THEME_KEYWORDS
        scored: list[dict[str, Any]] = []
        for label, keywords in keyword_map.items():
            matches = [item["title"] for item in headlines if any(keyword.lower() in item["title"].lower() for keyword in keywords)]
            if matches:
                scored.append(
                    {
                        "id": label,
                        "label": label,
                        "score": len(matches),
                        "summary": matches[0],
                        "keywords": list(keywords[:4]),
                    }
                )
        if scored:
            return sorted(scored, key=lambda item: item["score"], reverse=True)
        return [
            {
                "id": f"fallback-{index}",
                "label": "市场主题",
                "score": max(3 - index, 1),
                "summary": item["title"],
                "keywords": item.get("tags", []),
            }
            for index, item in enumerate(headlines[:3])
        ]

    def get_default_queries(self, market: str) -> tuple[dict[str, str], ...]:
        return A_SHARE_NEWS_QUERIES if market == "a_share" else CRYPTO_NEWS_QUERIES

    def dedupe_headlines(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        deduped: list[dict[str, Any]] = []
        for item in sorted(items, key=lambda row: row["publishedAt"], reverse=True):
            key = str(item.get("url") or item.get("title") or item.get("id"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped

    def _apply_llm_group_filter(
        self,
        market: str,
        group_label: str,
        items: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], str, bool, str]:
        try:
            prompt_items = [
                {
                    "index": index,
                    "title": item["title"],
                    "source": item["source"],
                    "summary": item["summary"],
                }
                for index, item in enumerate(items[:LLM_GROUP_LIMIT])
            ]
            content = self.llm_chat_requester(
                [
                    {
                        "role": "system",
                        "content": (
                            "你是中文金融资讯编辑。请从候选新闻中去掉广告、平台软文、"
                            "无信息增量内容，只保留真正值得量化交易工作台关注的新闻。"
                            "返回 JSON：{\"keep_indices\":[0,1],\"summary\":\"一句中文总结\"}"
                        ),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(
                            {"market": market, "group": group_label, "items": prompt_items},
                            ensure_ascii=False,
                        ),
                    },
                ]
            )
            payload = self._parse_llm_json(content)
            keep_indices = [
                int(index)
                for index in payload.get("keep_indices", [])
                if isinstance(index, int) or str(index).isdigit()
            ]
            filtered = [items[index] for index in keep_indices if 0 <= index < len(items)]
            if not filtered:
                filtered = items[: min(3, len(items))]
            summary = str(payload.get("summary") or filtered[0]["title"])
            return filtered, summary, True, f"已启用 LLM 去噪，保留 {len(filtered)} 条。"
        except Exception as exc:
            return (
                items[: min(4, len(items))],
                items[0]["title"],
                False,
                f"LLM 去噪失败，已回退系统过滤：{exc}",
            )

    def _fetch_google_news(
        self,
        *,
        source_id: str,
        label: str,
        query: str,
        market: str,
    ) -> tuple[list[dict[str, Any]], FeedStatus]:
        try:
            root = ET.fromstring(self._fetch_google_news_payload(query))
            items: list[dict[str, Any]] = []
            for item in root.findall(".//item")[:GOOGLE_NEWS_LIMIT]:
                title = html.unescape(item.findtext("title", default="")).strip()
                normalized_title, source_name = self._split_google_title(title)
                tags = self._extract_tags(normalized_title, market=market)
                candidate = {
                    "id": f"{market}-{abs(hash((normalized_title, item.findtext('link', default=''))))}",
                    "market": market,
                    "title": normalized_title,
                    "source": source_name or label,
                    "publishedAt": self._parse_pub_date(item.findtext("pubDate", default="")),
                    "url": item.findtext("link", default="").strip(),
                    "summary": self._summarize_title(normalized_title, tags),
                    "tags": tags[:4],
                }
                if self._should_keep_headline(candidate):
                    items.append(candidate)
            items = self.dedupe_headlines(items)
            return items, FeedStatus(source_id, label, True, f"已聚合 {len(items)} 条新闻", self.now_ms())
        except Exception as exc:
            return self._fallback_news(market), FeedStatus(source_id, label, False, str(exc), self.now_ms())

    def _fetch_google_news_payload(self, query: str) -> str:
        attempts = (
            f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
            f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=en-US&gl=US&ceid=US:en",
        )
        last_error: Exception | None = None
        for url in attempts:
            try:
                return self._fetch_text(url)
            except Exception as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise RuntimeError("Google News 拉取失败。")

    def _fallback_news(self, market: str) -> list[dict[str, Any]]:
        now = self.now_ms()
        rows = (
            [
                ("政策与权重蓝筹仍是当前 A 股主线。", "QuantX Seed"),
                ("半导体、AI 算力与机器人仍值得持续观察。", "QuantX Seed"),
                ("消费与金融是判断指数承接的重要锚点。", "QuantX Seed"),
            ]
            if market == "a_share"
            else [
                ("比特币走势与交易所公告共同影响当前加密盘面。", "QuantX Seed"),
                ("Binance 与 OKX 的公告仍是最直接的事件风险输入。", "QuantX Seed"),
                ("ETH 与 SOL 的轮动会影响短线宽度。", "QuantX Seed"),
            ]
        )
        return [
            {
                "id": f"{market}-fallback-{index}",
                "market": market,
                "title": title,
                "source": source,
                "publishedAt": now - index * 3_600_000,
                "url": "",
                "summary": title,
                "tags": self._extract_tags(title, market=market)[:4],
            }
            for index, (title, source) in enumerate(rows)
        ]

    def _should_keep_headline(self, item: dict[str, Any]) -> bool:
        title = str(item.get("title") or "").lower()
        summary = str(item.get("summary") or "").lower()
        source = str(item.get("source") or "").lower()
        text = f"{title} {summary}"
        if any(keyword.lower() in text for keyword in NEWS_PROMO_KEYWORDS):
            return False
        if any(blocked in source for blocked in NEWS_SOURCE_BLOCKLIST):
            return False
        if "sponsored" in text or "advertisement" in text or "promo" in text:
            return False
        return True

    def _parse_pub_date(self, value: str) -> int:
        if not value:
            return self.now_ms()
        try:
            return int(parsedate_to_datetime(value).timestamp() * 1000)
        except Exception:
            return self.now_ms()

    def _split_google_title(self, title: str) -> tuple[str, str]:
        if " - " not in title:
            return title, ""
        parts = title.rsplit(" - ", 1)
        return parts[0].strip(), parts[1].strip()

    def _extract_tags(self, title: str, *, market: str) -> list[str]:
        lowered = title.lower()
        keyword_map = A_SHARE_THEME_KEYWORDS if market == "a_share" else CRYPTO_THEME_KEYWORDS
        tags = [label for label, keywords in keyword_map.items() if any(keyword.lower() in lowered for keyword in keywords)]
        return tags or [token for token in title.replace(",", " ").replace(".", " ").split() if len(token) >= 2][:4]

    def _summarize_title(self, title: str, tags: list[str]) -> str:
        return f"{' / '.join(tags[:2]) if tags else '新闻聚合'}：{title}"

    def _parse_llm_json(self, content: str) -> dict[str, Any]:
        text = (content or "").strip()
        try:
            return json.loads(text)
        except Exception:
            pass
        if "```" in text:
            for block in text.split("```"):
                candidate = block.strip()
                if candidate.lower().startswith("json"):
                    candidate = candidate[4:].strip()
                if candidate.startswith("{") and candidate.endswith("}"):
                    return json.loads(candidate)
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise RuntimeError("LLM 返回内容不是可解析的 JSON。")

    def _fetch_text(self, url: str) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode("utf-8", errors="ignore")
