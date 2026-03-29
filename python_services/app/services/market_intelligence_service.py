from __future__ import annotations

import html
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable

try:
    from ..adapters.data_provider_store import (
        get_data_provider_settings,
        is_llm_analysis_enabled,
        request_llm_chat,
        request_tushare_api,
    )
except ImportError:
    from adapters.data_provider_store import (
        get_data_provider_settings,
        is_llm_analysis_enabled,
        request_llm_chat,
        request_tushare_api,
    )


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuantX/0.1"
OVERVIEW_CACHE_KEY = "intelligence:overview"
DEFAULT_TIMEOUT = 12
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

A_SHARE_INDEX_SPECS = (
    {"ts_code": "000001.SH", "symbol": "000001", "label": "上证指数"},
    {"ts_code": "399001.SZ", "symbol": "399001", "label": "深证成指"},
    {"ts_code": "399006.SZ", "symbol": "399006", "label": "创业板指"},
    {"ts_code": "000300.SH", "symbol": "000300", "label": "沪深300"},
)

A_SHARE_WATCH_SPECS = (
    {"ts_code": "000001.SZ", "symbol": "000001", "label": "平安银行"},
    {"ts_code": "600519.SH", "symbol": "600519", "label": "贵州茅台"},
    {"ts_code": "300750.SZ", "symbol": "300750", "label": "宁德时代"},
    {"ts_code": "601127.SH", "symbol": "601127", "label": "赛力斯"},
)

A_SHARE_ETF_SPECS = (
    {"symbol": "510300", "label": "沪深300ETF", "secid": "1.510300"},
    {"symbol": "159915", "label": "创业板ETF", "secid": "0.159915"},
    {"symbol": "512480", "label": "半导体ETF", "secid": "1.512480"},
    {"symbol": "159928", "label": "消费ETF", "secid": "0.159928"},
)

A_SHARE_THEME_PULSE_SPECS = (
    {"symbol": "512480", "label": "半导体", "secid": "1.512480", "summary": "观察芯片与先进制造主线强弱。"},
    {"symbol": "159915", "label": "成长风格", "secid": "0.159915", "summary": "观察成长股风险偏好。"},
    {"symbol": "516160", "label": "储能", "secid": "1.516160", "summary": "观察锂电与储能链轮动。"},
    {"symbol": "562500", "label": "机器人", "secid": "1.562500", "summary": "观察机器人与自动化主线。"},
)

CRYPTO_SPECS = (
    {"symbol": "BTCUSDT", "label": "BTC"},
    {"symbol": "ETHUSDT", "label": "ETH"},
    {"symbol": "SOLUSDT", "label": "SOL"},
    {"symbol": "BNBUSDT", "label": "BNB"},
)

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
    "免费领",
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


@dataclass(frozen=True)
class FeedStatus:
    source_id: str
    label: str
    ok: bool
    detail: str
    updated_at: int


class MarketIntelligenceService:
    def __init__(self, *, redis_cache: Any, now_ms: Callable[[], int], overview_ttl_ms: int = 300_000) -> None:
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.overview_ttl_ms = overview_ttl_ms

    def get_overview(self, force_refresh: bool = False) -> dict[str, Any]:
        if not force_refresh:
            cached = self.redis_cache.get_json(OVERVIEW_CACHE_KEY)
            if cached is not None:
                return cached
        payload = self._build_overview()
        self.redis_cache.set_json(OVERVIEW_CACHE_KEY, payload, self.overview_ttl_ms)
        return payload

    def _build_overview(self) -> dict[str, Any]:
        now = self.now_ms()
        feed_status: list[FeedStatus] = []
        a_indices, a_watch, a_status = self._fetch_a_share_market_data()
        a_pulse, a_pulse_status = self._fetch_a_share_sector_pulse()
        a_theme_pulse, a_theme_status = self._fetch_a_share_theme_pulse()
        c_assets, c_status = self._fetch_crypto_assets()
        c_events, c_events_status = self._fetch_crypto_event_feed()
        a_groups, a_news, a_news_statuses = self._fetch_news_groups("a_share", "news-a-share", A_SHARE_NEWS_QUERIES)
        c_groups, c_news, c_news_statuses = self._fetch_news_groups("crypto", "news-crypto", CRYPTO_NEWS_QUERIES)
        feed_status.extend([a_status, a_pulse_status, a_theme_status, c_status, c_events_status, *a_news_statuses, *c_news_statuses])
        tushare = get_data_provider_settings().get("tushare", {})
        if tushare.get("configured"):
            status = tushare.get("status", {})
            feed_status.append(FeedStatus("tushare-pro", "Tushare Pro", bool(status.get("ok")), str(status.get("message") or "已配置 Token。"), int(status.get("checkedAt") or 0)))
        llm = get_data_provider_settings().get("llm", {})
        if llm.get("configured"):
            status = llm.get("status", {})
            feed_status.append(FeedStatus("llm-analysis", "LLM 新闻分析", bool(status.get("ok")) if llm.get("enabled") else False, str(status.get("message") or "未启用 LLM，使用系统规则过滤。"), int(status.get("checkedAt") or 0)))

        markets = [
            self._build_a_share_market(a_indices, a_watch, [*a_pulse, *a_theme_pulse], a_news, a_groups, now),
            self._build_crypto_market(c_assets, c_events, c_news, c_groups, now),
        ]
        top_themes = sorted([*markets[0]["themes"], *markets[1]["themes"]], key=lambda item: item["score"], reverse=True)[:8]
        headlines = sorted([*a_news, *c_news], key=lambda item: item["publishedAt"], reverse=True)[:16]
        live_sources = sum(1 for item in feed_status if item.ok)
        return {
            "generatedAt": now,
            "live": live_sources > 0,
            "summary": {
                "headline": "已把 A股 与加密新闻按主题分组聚合，统一展示盘面、热点、事件与观察清单。",
                "liveSources": live_sources,
                "totalSources": len(feed_status),
                "topTheme": top_themes[0]["label"] if top_themes else "暂无主线",
                "riskMode": self._build_risk_mode(markets),
            },
            "sources": [{"sourceId": item.source_id, "label": item.label, "ok": item.ok, "detail": item.detail, "updatedAt": item.updated_at} for item in feed_status],
            "markets": markets,
            "topThemes": top_themes,
            "headlines": headlines,
        }

    def _build_a_share_market(self, indices: list[dict[str, Any]], watchlist: list[dict[str, Any]], pulse: list[dict[str, Any]], headlines: list[dict[str, Any]], news_groups: list[dict[str, Any]], now: int) -> dict[str, Any]:
        advancers = sum(1 for item in indices if item["changePct"] >= 0)
        avg = sum(item["changePct"] for item in indices) / max(len(indices), 1)
        mood = "偏强" if advancers >= max(len(indices) - 1, 1) else "分化"
        return {
            "market": "a_share",
            "label": "A股",
            "generatedAt": now,
            "overview": {
                "headline": f"A股核心指数平均涨跌 {avg:.2f}% ，当前盘面 {mood}。",
                "mood": mood,
                "breadth": f"{advancers}/{len(indices)} 个核心指数上涨",
                "commentary": "这一栏整合了 Tushare 指数、ETF 脉冲、主题脉冲与分组新闻聚合。",
                "verdict": self._build_a_share_verdict(avg, advancers, pulse),
            },
            "tiles": indices,
            "themes": self._build_themes(headlines, A_SHARE_THEME_KEYWORDS),
            "watchlist": watchlist[:4],
            "pulse": pulse[:4],
            "events": [],
            "headlines": headlines[:10],
            "newsGroups": news_groups,
        }

    def _build_crypto_market(self, assets: list[dict[str, Any]], events: list[dict[str, Any]], headlines: list[dict[str, Any]], news_groups: list[dict[str, Any]], now: int) -> dict[str, Any]:
        positive = sum(1 for item in assets if item["changePct"] >= 0)
        avg = sum(item["changePct"] for item in assets) / max(len(assets), 1)
        mood = "偏强" if avg >= 0 else "偏弱"
        return {
            "market": "crypto",
            "label": "加密",
            "generatedAt": now,
            "overview": {
                "headline": f"主流加密资产 24h 平均涨跌 {avg:.2f}% ，共 {positive}/{len(assets)} 个上涨。",
                "mood": mood,
                "breadth": f"{positive}/{len(assets)} 个主流资产上涨",
                "commentary": "这一栏整合了 24h 宽度、4h 趋势、交易所事件和分组新闻聚合。",
                "verdict": self._build_crypto_verdict(avg, positive, events),
            },
            "tiles": assets,
            "themes": self._build_themes(headlines, CRYPTO_THEME_KEYWORDS),
            "watchlist": [{"symbol": item["symbol"], "label": item["label"], "signal": "顺势跟踪" if item["changePct"] >= 1 else "等待确认", "reason": item["commentary"], "changePct": item["changePct"], "price": item["last"]} for item in sorted(assets, key=lambda row: abs(row["changePct"]), reverse=True)[:4]],
            "pulse": [],
            "events": events,
            "headlines": headlines[:10],
            "newsGroups": news_groups,
        }

    def _fetch_a_share_market_data(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], FeedStatus]:
        tushare = get_data_provider_settings().get("tushare", {})
        if tushare.get("enabled") and tushare.get("configured"):
            try:
                trade_date = self._latest_trade_date()
                indices = self._fetch_tushare_index_rows(trade_date)
                watchlist = self._fetch_tushare_watchlist_rows(trade_date)
                if indices:
                    detail = f"已拉取 {len(indices)} 个指数"
                    if watchlist:
                        detail += f"，{len(watchlist)} 个观察标的"
                    return indices, watchlist, FeedStatus("tushare-index-daily", "Tushare 指数与观察清单", True, detail, self.now_ms())
            except Exception as exc:
                return self._fetch_a_share_fallback(f"Tushare 回退：{exc}")
        return self._fetch_a_share_fallback()

    def _fetch_a_share_fallback(self, error_detail: str | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], FeedStatus]:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=1.000001,0.399001,0.399006,1.000300"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            indices = [{"symbol": str(item.get("f12") or ""), "label": str(item.get("f14") or "A股指数"), "last": float(item.get("f2") or 0), "changePct": float(item.get("f3") or 0), "commentary": "指数偏强，风险偏好回暖。" if float(item.get("f3") or 0) >= 0 else "指数承压，短线情绪偏谨慎。", "trend": [], "trendLabel": "实时快照"} for item in diff]
            watchlist = [
                {"symbol": "000001", "label": "平安银行", "signal": "观察金融承接", "reason": "用于观察权重金融承接力度。", "changePct": 1.2, "price": 0},
                {"symbol": "600519", "label": "贵州茅台", "signal": "观察消费龙头", "reason": "用于观察消费白马是否稳住指数。", "changePct": 0.4, "price": 0},
                {"symbol": "300750", "label": "宁德时代", "signal": "观察新能源修复", "reason": "用于观察高弹性成长股风格温度。", "changePct": 1.8, "price": 0},
                {"symbol": "601127", "label": "赛力斯", "signal": "观察情绪主线", "reason": "用于观察高波动龙头带动情绪的能力。", "changePct": 3.6, "price": 0},
            ]
            detail = f"已拉取 {len(indices)} 个指数快照"
            if error_detail:
                detail += f"，{error_detail}"
            return indices, watchlist, FeedStatus("eastmoney-indices", "东方财富指数快照", True, detail, self.now_ms())
        except Exception as exc:
            indices = [
                {"symbol": "000001", "label": "上证指数", "last": 3913.72, "changePct": 0.63, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "399001", "label": "深证成指", "last": 13760.37, "changePct": 1.13, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "399006", "label": "创业板指", "last": 3295.88, "changePct": 0.71, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "000300", "label": "沪深300", "last": 4502.57, "changePct": 0.56, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
            ]
            watchlist = [
                {"symbol": "000001", "label": "平安银行", "signal": "观察金融承接", "reason": "使用缓存样本。", "changePct": 1.2, "price": 0},
                {"symbol": "600519", "label": "贵州茅台", "signal": "观察消费龙头", "reason": "使用缓存样本。", "changePct": 0.4, "price": 0},
            ]
            detail = str(exc)
            if error_detail:
                detail = f"{error_detail}; 东方财富回退失败：{detail}"
            return indices, watchlist, FeedStatus("eastmoney-indices", "东方财富指数快照", False, detail, self.now_ms())

    def _fetch_a_share_sector_pulse(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=1.510300,0.159915,1.512480,0.159928"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            pulse = []
            for index, item in enumerate(diff[: len(A_SHARE_ETF_SPECS)]):
                spec = A_SHARE_ETF_SPECS[index]
                change_pct = float(item.get("f3") or 0)
                pulse.append({"symbol": spec["symbol"], "label": spec["label"], "changePct": change_pct, "signal": "领涨" if change_pct >= 1 else ("承接" if change_pct >= 0 else "降温"), "reason": "用 ETF 快速感知板块宽度与风格轮动。"})
            pulse.sort(key=lambda row: abs(row["changePct"]), reverse=True)
            return pulse[:4], FeedStatus("eastmoney-etf-pulse", "ETF 脉冲", True, f"已拉取 {len(pulse[:4])} 条 ETF 脉冲", self.now_ms())
        except Exception as exc:
            fallback = [
                {"symbol": "510300", "label": "沪深300ETF", "changePct": 0.6, "signal": "承接", "reason": "使用回退脉冲视图。"},
                {"symbol": "159915", "label": "创业板ETF", "changePct": 1.2, "signal": "领涨", "reason": "使用回退脉冲视图。"},
                {"symbol": "512480", "label": "半导体ETF", "changePct": 1.6, "signal": "领涨", "reason": "使用回退脉冲视图。"},
                {"symbol": "159928", "label": "消费ETF", "changePct": -0.2, "signal": "降温", "reason": "使用回退脉冲视图。"},
            ]
            return fallback, FeedStatus("eastmoney-etf-pulse", "ETF 脉冲", False, str(exc), self.now_ms())

    def _fetch_a_share_theme_pulse(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        secids = ",".join(spec["secid"] for spec in A_SHARE_THEME_PULSE_SPECS)
        url = f"https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids={secids}"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            rows = []
            for index, item in enumerate(diff[: len(A_SHARE_THEME_PULSE_SPECS)]):
                spec = A_SHARE_THEME_PULSE_SPECS[index]
                change_pct = float(item.get("f3") or 0)
                rows.append({"symbol": spec["symbol"], "label": spec["label"], "changePct": change_pct, "signal": "加速" if change_pct >= 1.5 else ("承接" if change_pct >= 0 else "降温"), "reason": spec["summary"]})
            rows.sort(key=lambda row: abs(row["changePct"]), reverse=True)
            return rows[:4], FeedStatus("eastmoney-theme-pulse", "主题脉冲", True, f"已拉取 {len(rows[:4])} 条主题脉冲", self.now_ms())
        except Exception as exc:
            fallback = [
                {"symbol": "512480", "label": "半导体", "changePct": 1.7, "signal": "加速", "reason": "观察芯片与先进制造主线强弱。"},
                {"symbol": "159915", "label": "成长风格", "changePct": 1.1, "signal": "承接", "reason": "观察成长股风险偏好。"},
                {"symbol": "516160", "label": "储能", "changePct": 0.8, "signal": "承接", "reason": "观察锂电与储能链轮动。"},
                {"symbol": "562500", "label": "机器人", "changePct": -0.3, "signal": "降温", "reason": "观察机器人与自动化主线。"},
            ]
            return fallback, FeedStatus("eastmoney-theme-pulse", "主题脉冲", False, str(exc), self.now_ms())

    def _fetch_news_groups(self, market: str, source_prefix: str, queries: Iterable[dict[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[FeedStatus]]:
        groups: list[dict[str, Any]] = []
        combined: list[dict[str, Any]] = []
        statuses: list[FeedStatus] = []
        llm_enabled = is_llm_analysis_enabled()
        llm_group_status_added = False
        for query_spec in queries:
            items, status = self._fetch_google_news(source_id=f"{source_prefix}-{query_spec['group_id']}", label=f"新闻聚合·{query_spec['label']}", query=query_spec["query"], market=market)
            group_summary = items[0]["title"] if items else "暂无相关新闻"
            if llm_enabled and items:
                items, group_summary, llm_ok, llm_detail = self._apply_llm_group_filter(market, query_spec["label"], items)
                if not llm_group_status_added:
                    statuses.append(FeedStatus(f"{source_prefix}-llm", f"{'A股' if market == 'a_share' else '加密'} LLM 去噪", llm_ok, llm_detail, self.now_ms()))
                    llm_group_status_added = True
            statuses.append(status)
            groups.append({"groupId": query_spec["group_id"], "label": query_spec["label"], "count": len(items), "summary": group_summary, "items": items[:4]})
            combined.extend(items)
        return groups, self._dedupe_headlines(combined)[:12], statuses

    def _apply_llm_group_filter(self, market: str, group_label: str, items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str, bool, str]:
        try:
            prompt_items = [{"index": index, "title": item["title"], "source": item["source"], "summary": item["summary"]} for index, item in enumerate(items[:LLM_GROUP_LIMIT])]
            content = request_llm_chat(
                [
                    {"role": "system", "content": "你是中文金融资讯编辑。请从候选新闻中去掉广告、平台软文、无信息增量内容，只保留真正值得量化交易工作台关注的新闻。返回 JSON：{\"keep_indices\":[0,1],\"summary\":\"一句中文总结\"}。"},
                    {"role": "user", "content": json.dumps({"market": market, "group": group_label, "items": prompt_items}, ensure_ascii=False)},
                ]
            )
            payload = self._parse_llm_json(content)
            keep_indices = [int(index) for index in payload.get("keep_indices", []) if isinstance(index, int) or str(index).isdigit()]
            filtered = [items[index] for index in keep_indices if 0 <= index < len(items)]
            if not filtered:
                filtered = items[: min(3, len(items))]
            summary = str(payload.get("summary") or filtered[0]["title"])
            return filtered, summary, True, f"已启用 LLM 去噪，保留 {len(filtered)} 条。"
        except Exception as exc:
            return items[: min(4, len(items))], items[0]["title"], False, f"LLM 去噪失败，已回退系统过滤：{exc}"

    def _latest_trade_date(self) -> str:
        today = datetime.now().strftime("%Y%m%d")
        payload = request_tushare_api("trade_cal", params={"exchange": "SSE", "start_date": "20250101", "end_date": today, "is_open": "1"}, fields="exchange,cal_date,is_open")
        items = payload.get("data", {}).get("items", []) or []
        if not items:
            raise RuntimeError("Tushare 未返回交易日历。")
        return str(items[0][1])

    def _fetch_tushare_index_rows(self, trade_date: str) -> list[dict[str, Any]]:
        rows = []
        for spec in A_SHARE_INDEX_SPECS:
            payload = request_tushare_api("index_daily", params={"ts_code": spec["ts_code"], "end_date": trade_date, "limit": 10}, fields="ts_code,trade_date,close,pct_chg")
            fields = payload.get("data", {}).get("fields", []) or []
            items = payload.get("data", {}).get("items", []) or []
            if not items:
                continue
            index = {field: idx for idx, field in enumerate(fields)}
            latest = items[0]
            pct = self._field_float(latest, index, "pct_chg")
            rows.append({"symbol": spec["symbol"], "label": spec["label"], "last": self._field_float(latest, index, "close"), "changePct": pct, "commentary": "近期结构偏强。" if pct >= 0 else "短线回撤仍需观察。", "trend": [self._field_float(item, index, "close") for item in reversed(items[:10]) if self._field_float(item, index, "close") > 0], "trendLabel": "近10日趋势"})
        return rows

    def _fetch_tushare_watchlist_rows(self, trade_date: str) -> list[dict[str, Any]]:
        rows = []
        for spec in A_SHARE_WATCH_SPECS:
            payload = request_tushare_api("daily", params={"ts_code": spec["ts_code"], "trade_date": trade_date}, fields="ts_code,trade_date,close,pct_chg")
            fields = payload.get("data", {}).get("fields", []) or []
            items = payload.get("data", {}).get("items", []) or []
            if not items:
                continue
            index = {field: idx for idx, field in enumerate(fields)}
            latest = items[0]
            pct = self._field_float(latest, index, "pct_chg")
            rows.append({"symbol": spec["symbol"], "label": spec["label"], "signal": "顺势跟踪" if pct >= 2 else ("观察修复" if pct >= 0 else "等待企稳"), "reason": "用来补足指数之外的风格主线观察。", "changePct": pct, "price": self._field_float(latest, index, "close")})
        rows.sort(key=lambda item: abs(item["changePct"]), reverse=True)
        return rows[:4]

    def _fetch_crypto_assets(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        url = "https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22,%22BNBUSDT%22%5D"
        try:
            payload = json.loads(self._fetch_text(url))
            trend_map = self._fetch_crypto_trends()
            rows = []
            for item in payload:
                symbol = str(item.get("symbol") or "")
                pct = float(item.get("priceChangePercent") or 0)
                rows.append({"symbol": symbol, "label": symbol.replace("USDT", ""), "last": float(item.get("lastPrice") or 0), "changePct": pct, "quoteVolume": float(item.get("quoteVolume") or 0), "commentary": "价格与成交额同步走强。" if pct >= 0 else "回撤阶段更需要观察支撑位。", "trend": trend_map.get(symbol, []), "trendLabel": "近12根4h"})
            return rows, FeedStatus("binance-24h", "Binance 24h 行情", True, f"已拉取 {len(rows)} 个主流币", self.now_ms())
        except Exception as exc:
            fallback = [
                {"symbol": "BTCUSDT", "label": "BTC", "last": 66764.2, "changePct": 0.84, "quoteVolume": 1_200_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "ETHUSDT", "label": "ETH", "last": 3482.15, "changePct": 1.18, "quoteVolume": 730_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "SOLUSDT", "label": "SOL", "last": 181.34, "changePct": -0.42, "quoteVolume": 410_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "BNBUSDT", "label": "BNB", "last": 612.58, "changePct": 0.27, "quoteVolume": 360_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
            ]
            return fallback, FeedStatus("binance-24h", "Binance 24h 行情", False, str(exc), self.now_ms())

    def _fetch_crypto_trends(self) -> dict[str, list[float]]:
        trends: dict[str, list[float]] = {}
        for spec in CRYPTO_SPECS:
            try:
                payload = json.loads(self._fetch_text(f"https://api.binance.com/api/v3/klines?symbol={spec['symbol']}&interval=4h&limit=12"))
                trends[spec["symbol"]] = [float(item[4]) for item in payload if len(item) >= 5]
            except Exception:
                trends[spec["symbol"]] = []
        return trends

    def _fetch_crypto_event_feed(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        now = self.now_ms()
        try:
            rows = []
            status_payload = json.loads(self._fetch_text("https://api.binance.com/sapi/v1/system/status"))
            rows.append({"id": "binance-system-status", "exchange": "Binance", "title": "系统状态", "summary": str(status_payload.get("msg") or "system status"), "severity": "normal" if int(status_payload.get("status", 1)) == 0 else "attention", "publishedAt": now})
            try:
                root = ET.fromstring(self._fetch_text("https://www.binance.com/en/support/announcement/rss"))
                for item in root.findall(".//item")[:3]:
                    rows.append({"id": f"binance-ann-{abs(hash(item.findtext('link', default='')))}", "exchange": "Binance", "title": html.unescape(item.findtext("title", default="公告")).strip(), "summary": "来自 Binance 公告流。", "severity": "normal", "publishedAt": self._parse_pub_date(item.findtext("pubDate", default=""))})
            except Exception:
                rows.append({"id": "okx-watch", "exchange": "OKX", "title": "交易所观察", "summary": "继续关注 OKX 公告、维护与延迟波动。", "severity": "normal", "publishedAt": now - 60_000})
            rows.sort(key=lambda item: item["publishedAt"], reverse=True)
            return rows[:4], FeedStatus("exchange-events", "交易所事件流", True, f"已拉取 {len(rows[:4])} 条交易所事件", now)
        except Exception as exc:
            fallback = [
                {"id": "binance-system-status", "exchange": "Binance", "title": "系统状态", "summary": "系统状态接口不可用，当前使用回退事件监控。", "severity": "attention", "publishedAt": now},
                {"id": "okx-watch", "exchange": "OKX", "title": "交易所观察", "summary": "关注 OKX 公告与延迟变化带来的执行风险。", "severity": "normal", "publishedAt": now - 60_000},
                {"id": "announcement-watch", "exchange": "Binance", "title": "公告观察", "summary": "关注上币、下币与维护公告带来的事件驱动波动。", "severity": "normal", "publishedAt": now - 120_000},
            ]
            return fallback, FeedStatus("exchange-events", "交易所事件流", False, str(exc), now)

    def _fetch_google_news(self, *, source_id: str, label: str, query: str, market: str) -> tuple[list[dict[str, Any]], FeedStatus]:
        try:
            root = ET.fromstring(self._fetch_google_news_payload(query))
            items = []
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
            items = self._dedupe_headlines(items)
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
        rows = [
            ("政策与权重蓝筹仍是当前 A股 主线。", "QuantX Seed"),
            ("半导体、AI 算力与机器人仍值得持续观察。", "QuantX Seed"),
            ("消费与金融是判断指数承接的重要锚点。", "QuantX Seed"),
        ] if market == "a_share" else [
            ("比特币走势与交易所公告共同影响当前加密盘面。", "QuantX Seed"),
            ("Binance 与 OKX 的公告仍是最直接的事件风险输入。", "QuantX Seed"),
            ("ETH 与 SOL 的轮动会影响短线宽度。", "QuantX Seed"),
        ]
        return [{"id": f"{market}-fallback-{index}", "market": market, "title": title, "source": source, "publishedAt": now - index * 3_600_000, "url": "", "summary": title, "tags": self._extract_tags(title, market=market)[:4]} for index, (title, source) in enumerate(rows)]

    def _build_themes(self, headlines: list[dict[str, Any]], keyword_map: dict[str, tuple[str, ...]]) -> list[dict[str, Any]]:
        scored = []
        for label, keywords in keyword_map.items():
            matches = [item["title"] for item in headlines if any(keyword.lower() in item["title"].lower() for keyword in keywords)]
            if matches:
                scored.append({"id": label, "label": label, "score": len(matches), "summary": matches[0], "keywords": list(keywords[:4])})
        if scored:
            return sorted(scored, key=lambda item: item["score"], reverse=True)
        return [{"id": f"fallback-{index}", "label": "市场主题", "score": max(3 - index, 1), "summary": item["title"], "keywords": item.get("tags", [])} for index, item in enumerate(headlines[:3])]

    def _build_a_share_verdict(self, average_change: float, advancers: int, pulse: list[dict[str, Any]]) -> str:
        strong_pulse = sum(1 for item in pulse if float(item.get("changePct") or 0) >= 1)
        if average_change >= 0.8 and advancers >= 3 and strong_pulse >= 2:
            return "风险偏好抬升，指数与主题共振偏强。"
        if average_change >= 0 and advancers >= 2:
            return "指数保持承接，适合继续观察主线轮动。"
        return "指数分化偏谨慎，优先等主线确认后再加仓。"

    def _build_crypto_verdict(self, average_change: float, positive_assets: int, events: list[dict[str, Any]]) -> str:
        attention_events = sum(1 for item in events if item.get("severity") == "attention")
        if average_change >= 1 and positive_assets >= 3 and attention_events == 0:
            return "加密盘面偏强，趋势和事件面暂时同向。"
        if average_change >= 0 and positive_assets >= 2:
            return "加密盘面仍有承接，但需要继续盯住交易所事件。"
        return "加密波动偏弱，事件风险权重高于追涨冲动。"

    def _build_risk_mode(self, markets: list[dict[str, Any]]) -> dict[str, str]:
        score = 0
        reasons = []
        for market in markets:
            mood = str(market.get("overview", {}).get("mood") or "")
            label = str(market.get("label") or "")
            if mood == "偏强":
                score += 1
                reasons.append(f"{label}偏强")
            elif mood == "偏弱":
                score -= 1
                reasons.append(f"{label}偏弱")
            else:
                reasons.append(f"{label}分化")
        if score >= 2:
            return {"label": "风险偏好开启", "hint": "A股与加密同时偏强，可以更积极关注强势主线。", "reasons": "，".join(reasons)}
        if score <= -1:
            return {"label": "风险偏好收缩", "hint": "至少一个市场明显转弱，优先控制节奏与仓位。", "reasons": "，".join(reasons)}
        return {"label": "风险偏好中性", "hint": "跨市场没有形成一致方向，更适合结构化跟踪。", "reasons": "，".join(reasons)}

    def _dedupe_headlines(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        deduped: list[dict[str, Any]] = []
        for item in sorted(items, key=lambda row: row["publishedAt"], reverse=True):
            key = str(item.get("url") or item.get("title") or item.get("id"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped

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

    def _field_float(self, item: list[Any], field_index: dict[str, int], field: str) -> float:
        return float(item[field_index[field]] or 0) if field in field_index else 0.0

    def _fetch_text(self, url: str) -> str:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode("utf-8", errors="ignore")
