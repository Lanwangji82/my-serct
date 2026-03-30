from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Callable

from ...adapters.providers.data_provider_store import (
    get_data_provider_settings,
    is_llm_analysis_enabled,
    request_llm_chat,
)
from ...adapters.providers.intelligence_providers import (
    AShareIntelligenceProvider,
    CryptoIntelligenceProvider,
    FeedStatus,
)
from ...adapters.providers.news_intelligence_provider import GoogleNewsGroupingProvider
from ...adapters.search.semantic_retriever import LocalSemanticRetriever


OVERVIEW_CACHE_KEY = "intelligence:overview"

EVENT_TYPE_KEYWORDS: dict[str, dict[str, tuple[str, ...]]] = {
    "a_share": {
        "earnings": ("业绩", "财报", "年报", "季报", "快报", "预增", "预减"),
        "announcement": ("公告", "披露", "停牌", "复牌"),
        "policy": ("政策", "证监会", "国务院", "央行", "发改委", "监管"),
        "industry_cycle": ("景气", "需求", "涨价", "产能", "订单"),
        "mna": ("并购", "重组", "收购", "资产注入"),
        "buyback": ("回购", "增持", "减持"),
        "penalty": ("处罚", "立案", "问询", "风险警示"),
        "flow_signal": ("龙虎榜", "资金", "异动", "涨停", "跌停"),
    },
    "crypto": {
        "listing": ("上线", "上所", "listing", "launch"),
        "delisting": ("下架", "delist", "下线"),
        "funding": ("融资", "募资", "funding", "raise"),
        "unlock": ("解锁", "unlock", "vesting"),
        "governance": ("治理", "提案", "投票", "governance"),
        "security": ("攻击", "漏洞", "被盗", "security", "exploit", "hack"),
        "regulation": ("监管", "sec", "compliance", "执法"),
        "etf_institution": ("etf", "机构", "fund", "asset manager"),
        "onchain_activity": ("链上", "活跃", "地址数", "tvl", "staking"),
    },
}

EVENT_TYPE_LABELS = {
    "earnings": "业绩",
    "announcement": "公告",
    "policy": "政策",
    "industry_cycle": "行业景气",
    "mna": "并购重组",
    "buyback": "回购增持",
    "penalty": "监管处罚",
    "flow_signal": "资金异动",
    "listing": "上所",
    "delisting": "下架",
    "funding": "融资",
    "unlock": "解锁",
    "governance": "治理提案",
    "security": "安全事件",
    "regulation": "监管",
    "etf_institution": "ETF/机构",
    "onchain_activity": "链上活跃变化",
    "general": "市场事件",
}

POSITIVE_EVENT_TYPES = {"earnings", "policy", "industry_cycle", "mna", "buyback", "listing", "funding", "etf_institution"}
NEGATIVE_EVENT_TYPES = {"penalty", "delisting", "security", "regulation", "unlock"}

GARBLED_TEXT_REPLACEMENTS = {
    "甯傚満缁撹": "市场结论",
    "鍏虫敞鐒︾偣": "关注焦点",
    "涓婚鑴夌粶": "主题脉络",
    "瑙傚療鏂瑰悜": "观察方向",
    "鍔犲瘑": "加密",
    "A鑲": "A股",
    "LLM 鏂伴椈鍒嗘瀽": "LLM 新闻分析",
    "鏆傛棤涓荤嚎": "暂无主线",
    "鍋忓己": "偏强",
    "鍋忓急": "偏弱",
    "鍒嗗寲": "分化",
    "椤哄娍璺熻釜": "顺势跟踪",
    "绛夊緟纭": "等待确认",
    "椋庨櫓鍋忓ソ鏀剁缉": "风险偏好收缩",
}

MARKET_LABELS = {
    "a_share": "A股",
    "crypto": "加密",
}


class MarketIntelligenceService:
    def __init__(
        self,
        *,
        redis_cache: Any,
        now_ms: Callable[[], int],
        snapshot_repository: Any | None = None,
        refresh_scheduler: Any | None = None,
        a_share_provider: AShareIntelligenceProvider | None = None,
        crypto_provider: CryptoIntelligenceProvider | None = None,
        news_provider: GoogleNewsGroupingProvider | None = None,
        semantic_retriever: Any | None = None,
        overview_ttl_ms: int = 300_000,
    ) -> None:
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.snapshot_repository = snapshot_repository
        self.refresh_scheduler = refresh_scheduler
        self.a_share_provider = a_share_provider or AShareIntelligenceProvider(now_ms=now_ms)
        self.crypto_provider = crypto_provider or CryptoIntelligenceProvider(now_ms=now_ms)
        self.news_provider = news_provider or GoogleNewsGroupingProvider(
            now_ms=now_ms,
            llm_enabled_getter=lambda: False,
            llm_chat_requester=lambda _messages: "",
        )
        self.semantic_retriever = semantic_retriever or LocalSemanticRetriever(now_ms=now_ms)
        self.overview_ttl_ms = overview_ttl_ms

    def get_overview(self, force_refresh: bool = False) -> dict[str, Any]:
        if force_refresh:
            return self.refresh_overview()

        cached = self.redis_cache.get_json(OVERVIEW_CACHE_KEY)
        if cached is not None:
            return self._normalize_value(cached)

        if self.snapshot_repository is not None:
            snapshot = self.snapshot_repository.get_intelligence_overview()
            if snapshot is not None:
                normalized_snapshot = self._normalize_value(snapshot)
                self.redis_cache.set_json(OVERVIEW_CACHE_KEY, normalized_snapshot, self.overview_ttl_ms)
                if self.refresh_scheduler is not None:
                    self.refresh_scheduler.enqueue_intelligence_overview_refresh()
                return normalized_snapshot

        return self.refresh_overview()

    def refresh_overview(self) -> dict[str, Any]:
        payload = self._normalize_value(self._build_overview())
        self.redis_cache.set_json(OVERVIEW_CACHE_KEY, payload, self.overview_ttl_ms)
        if self.snapshot_repository is not None:
            self.snapshot_repository.save_intelligence_overview(payload, updated_at=self.now_ms())
            self._persist_intelligence_artifacts(payload)
        return payload

    def _persist_intelligence_artifacts(self, payload: dict[str, Any]) -> None:
        if self.snapshot_repository is None:
            return
        updated_at = int(payload.get("generatedAt") or self.now_ms())
        markets = payload.get("markets", []) or []
        for market in markets:
            market_key = str(market.get("market") or "")
            if not market_key:
                continue
            news_items = self._build_news_items(
                market_key=market_key,
                market=market,
                generated_at=updated_at,
            )
            news_events = self._build_news_events(
                market_key=market_key,
                market=market,
                generated_at=updated_at,
            )
            llm_digests = self._build_llm_digests(
                market_key=market_key,
                market=market,
                generated_at=updated_at,
                news_items=news_items,
                news_events=news_events,
            )
            search_documents = self._build_search_documents(
                market_key=market_key,
                market=market,
                generated_at=updated_at,
            )
            self.snapshot_repository.save_news_groups(
                market=market_key,
                groups=list(market.get("newsGroups") or []),
                updated_at=updated_at,
            )
            self.snapshot_repository.save_news_items(
                market=market_key,
                items=news_items,
                updated_at=updated_at,
            )
            self.snapshot_repository.save_news_events(
                market=market_key,
                events=news_events,
                updated_at=updated_at,
            )
            self.snapshot_repository.save_exchange_events(
                market=market_key,
                events=list(market.get("events") or []),
                updated_at=updated_at,
            )
            self.snapshot_repository.save_llm_digests(
                market=market_key,
                digests=llm_digests,
                updated_at=updated_at,
            )
            self.snapshot_repository.save_briefs(
                market=market_key,
                briefs=self._build_market_brief(
                    market_key=market_key,
                    market=market,
                    generated_at=updated_at,
                    digests=llm_digests,
                    events=news_events,
                ),
                updated_at=updated_at,
            )
            self.semantic_retriever.index_documents(
                namespace=f"market:{market_key}",
                documents=search_documents,
            )

    def get_market_artifacts(self, market: str) -> dict[str, Any]:
        if self.snapshot_repository is None:
            overview = self.get_overview()
            market_payload = next((item for item in overview.get("markets", []) if item.get("market") == market), None)
            if market_payload is None:
                return {
                    "market": market,
                    "generatedAt": self.now_ms(),
                    "newsGroups": [],
                    "newsItems": [],
                    "newsEvents": [],
                    "llmDigests": [],
                    "exchangeEvents": [],
                }
            generated_at = int(overview.get("generatedAt") or self.now_ms())
            return {
                "market": market,
                "generatedAt": generated_at,
                "newsGroups": list(market_payload.get("newsGroups") or []),
                "newsItems": self._build_news_items(market_key=market, market=market_payload, generated_at=generated_at),
                "newsEvents": self._build_news_events(market_key=market, market=market_payload, generated_at=generated_at),
                "llmDigests": self._build_llm_digests(market_key=market, market=market_payload, generated_at=generated_at),
                "brief": self._build_market_brief(market_key=market, market=market_payload, generated_at=generated_at),
                "exchangeEvents": list(market_payload.get("events") or []),
            }

        payload = {
            "market": market,
            "generatedAt": self.now_ms(),
            "newsGroups": self.snapshot_repository.get_news_groups(market=market) or [],
            "newsItems": self.snapshot_repository.get_news_items(market=market) or [],
            "newsEvents": self.snapshot_repository.get_news_events(market=market) or [],
            "llmDigests": self._normalize_digest_payload(self.snapshot_repository.get_llm_digests(market=market) or []),
            "brief": self._normalize_brief_payload(self.snapshot_repository.get_briefs(market=market) or {}),
            "exchangeEvents": self.snapshot_repository.get_exchange_events(market=market) or [],
        }
        return self._normalize_value(payload)

    def get_market_brief(self, market: str | None = None) -> dict[str, Any]:
        markets = [market] if market in {"a_share", "crypto"} else ["a_share", "crypto"]
        briefs = []
        for market_key in markets:
            if self.snapshot_repository is not None:
                brief = self.snapshot_repository.get_briefs(market=market_key)
                if brief:
                    briefs.append(self._normalize_brief_payload(brief))
                    continue
            overview = self.get_overview()
            market_payload = next((item for item in overview.get("markets", []) if item.get("market") == market_key), None)
            if market_payload is None:
                continue
            briefs.append(
                self._build_market_brief(
                    market_key=market_key,
                    market=market_payload,
                    generated_at=int(overview.get("generatedAt") or self.now_ms()),
                )
            )
        return {
            "market": market or "all",
            "generatedAt": max([int(item.get("generatedAt") or 0) for item in briefs] or [self.now_ms()]),
            "briefs": briefs,
        }

    def search_market_intelligence(
        self,
        *,
        query: str,
        market: str | None = None,
        limit: int = 8,
    ) -> dict[str, Any]:
        normalized_query = query.strip()
        if not normalized_query:
            return {"query": query, "market": market or "all", "items": []}

        markets = [market] if market in {"a_share", "crypto"} else ["a_share", "crypto"]
        documents: list[dict[str, Any]] = []
        for market_key in markets:
            artifacts = self.get_market_artifacts(market_key)
            documents.extend(self._build_search_documents_from_artifacts(market_key=market_key, artifacts=artifacts))
        namespace = f"market:{market}" if market in {"a_share", "crypto"} else ""
        result = self.semantic_retriever.search(query=query, namespace=namespace, documents=documents, limit=limit)
        return {
            "query": query,
            "market": market or "all",
            "mode": result.get("mode") or "hybrid_semantic",
            "items": result.get("items") or [],
        }

    def _build_llm_digests(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
        news_items: list[dict[str, Any]] | None = None,
        news_events: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        resolved_news_items = news_items if news_items is not None else self._build_news_items(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
        )
        resolved_news_events = news_events if news_events is not None else self._build_news_events(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
        )
        digests = self._build_system_llm_digests(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
            news_events=resolved_news_events,
        )
        if not is_llm_analysis_enabled():
            return digests
        llm_digest = self._build_llm_news_digest(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
            news_items=resolved_news_items,
            news_events=resolved_news_events,
        )
        if llm_digest is None:
            return digests
        return [llm_digest, *digests]

    def _build_system_llm_digests(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
        news_events: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        digests: list[dict[str, Any]] = []
        overview = market.get("overview", {}) or {}
        market_label = str(market.get("label") or market_key)
        top_event = news_events[0] if news_events else None
        if top_event:
            digests.append(
                {
                    "id": f"{market_key}:system:focus",
                    "market": market_key,
                    "marketLabel": market_label,
                    "kind": "system_focus",
                    "mode": "system",
                    "label": "系统焦点",
                    "summary": str(top_event.get("summary") or top_event.get("label") or ""),
                    "focus": str(top_event.get("label") or ""),
                    "risks": " / ".join(str(tag) for tag in (top_event.get("tags") or [])[:3]),
                    "action": "优先核对事件后续发酵与受影响标的。",
                    "count": int(top_event.get("count") or 0),
                    "generatedAt": generated_at,
                }
            )
        verdict = str(overview.get("verdict") or "")
        if verdict:
            digests.append(
                {
                    "id": f"{market_key}:overview",
                    "market": market_key,
                    "marketLabel": market_label,
                    "kind": "system_overview",
                    "mode": "system",
                    "label": "系统结论",
                    "summary": verdict,
                    "focus": str(overview.get("headline") or ""),
                    "risks": str(overview.get("commentary") or ""),
                    "action": "结合事件流与行情中心再确认节奏变化。",
                    "count": len(market.get("headlines", []) or []),
                    "generatedAt": generated_at,
                }
            )
        return digests

    def _build_llm_news_digest(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
        news_items: list[dict[str, Any]],
        news_events: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        headlines = [
            {
                "title": str(item.get("title") or ""),
                "summary": str(item.get("summary") or ""),
                "source": str(item.get("source") or ""),
                "tags": list(item.get("tags") or [])[:4],
                "publishedAt": int(item.get("publishedAt") or generated_at),
            }
            for item in news_items[:6]
        ]
        events = [
            {
                "label": str(event.get("label") or ""),
                "summary": str(event.get("summary") or ""),
                "count": int(event.get("count") or 0),
                "tags": list(event.get("tags") or [])[:4],
            }
            for event in news_events[:4]
        ]
        if not headlines and not events:
            return None
        market_label = str(market.get("label") or market_key)
        overview = market.get("overview", {}) or {}
        try:
            content = request_llm_chat(
                [
                    {
                        "role": "system",
                        "content": (
                            "你是量化交易工作台里的中文市场情报分析助手。"
                            "请只返回 JSON，格式为"
                            '{"summary":"...","focus":"...","risks":"...","action":"...","confidence":"high|medium|low"}。'
                            "要求基于新闻与事件做简洁分析，不要编造数据，不要输出 markdown。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "market": market_label,
                                "overview": {
                                    "headline": str(overview.get("headline") or ""),
                                    "verdict": str(overview.get("verdict") or ""),
                                },
                                "headlines": headlines,
                                "events": events,
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
                temperature=0.2,
                timeout=20,
            )
            payload = self._parse_llm_json(content)
            summary = str(payload.get("summary") or "").strip()
            if not summary:
                return None
            return {
                "id": f"{market_key}:llm:news-analysis",
                "market": market_key,
                "marketLabel": market_label,
                "kind": "llm_news_analysis",
                "mode": "llm",
                "label": "LLM 新闻分析",
                "summary": summary,
                "focus": str(payload.get("focus") or ""),
                "risks": str(payload.get("risks") or ""),
                "action": str(payload.get("action") or ""),
                "confidence": str(payload.get("confidence") or "medium"),
                "count": len(headlines),
                "generatedAt": generated_at,
            }
        except Exception:
            return None

    def _parse_llm_json(self, content: str) -> dict[str, Any]:
        raw = (content or "").strip()
        if not raw:
            return {}
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, flags=re.DOTALL)
        if fenced:
            raw = fenced.group(1)
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]
        try:
            payload = json.loads(raw)
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _build_market_brief(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
        digests: list[dict[str, Any]] | None = None,
        events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        digests = digests if digests is not None else self._build_llm_digests(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
        )
        events = events if events is not None else self._build_news_events(
            market_key=market_key,
            market=market,
            generated_at=generated_at,
        )
        top_event = events[0] if events else None
        top_digest = digests[0] if digests else None
        overview = market.get("overview", {}) or {}
        sections = [
            {
                "id": "verdict",
                "title": "市场结论",
                "content": str(overview.get("verdict") or overview.get("headline") or ""),
            },
            {
                "id": "focus",
                "title": "关注焦点",
                "content": str(top_event.get("summary") if top_event else top_digest.get("summary") if top_digest else ""),
            },
            {
                "id": "themes",
                "title": "主题脉络",
                "content": " / ".join(str(item.get("label") or "") for item in (market.get("themes", []) or [])[:3]),
            },
            {
                "id": "watch",
                "title": "观察方向",
                "content": " / ".join(str(item.get("label") or "") for item in (market.get("watchlist", []) or [])[:3]),
            },
        ]
        return self._normalize_brief_payload(
            {
            "market": market_key,
            "label": str(market.get("label") or market_key),
            "generatedAt": generated_at,
            "headline": str(overview.get("headline") or ""),
            "summary": str(top_digest.get("summary") if top_digest else overview.get("verdict") or ""),
            "sections": [section for section in sections if section["content"]],
            }
        )

    def _normalize_brief_payload(self, brief: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(brief or {})
        market_key = str(normalized.get("market") or "")
        normalized["label"] = MARKET_LABELS.get(market_key) or self._normalize_text(str(normalized.get("label") or ""))
        normalized["headline"] = self._normalize_text(str(normalized.get("headline") or ""))
        normalized["summary"] = self._normalize_text(str(normalized.get("summary") or ""))
        normalized["sections"] = [
            {
                **section,
                "title": self._normalize_text(str((section or {}).get("title") or "")),
                "content": self._normalize_text(str((section or {}).get("content") or "")),
            }
            for section in (normalized.get("sections") or [])
            if isinstance(section, dict)
        ]
        return normalized

    def _normalize_digest_payload(self, digests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for digest in digests or []:
            if not isinstance(digest, dict):
                continue
            normalized.append(
                {
                    **digest,
                    "marketLabel": MARKET_LABELS.get(str(digest.get("market") or "")) or self._normalize_text(str(digest.get("marketLabel") or "")),
                    "label": self._normalize_text(str(digest.get("label") or "")),
                    "summary": self._normalize_text(str(digest.get("summary") or "")),
                    "focus": self._normalize_text(str(digest.get("focus") or "")),
                    "risks": self._normalize_text(str(digest.get("risks") or "")),
                    "action": self._normalize_text(str(digest.get("action") or "")),
                }
            )
        return normalized

    def _normalize_text(self, value: str) -> str:
        normalized = value
        for source, target in GARBLED_TEXT_REPLACEMENTS.items():
            normalized = normalized.replace(source, target)
        return normalized.strip()

    def _normalize_value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._normalize_text(value)
        if isinstance(value, list):
            return [self._normalize_value(item) for item in value]
        if isinstance(value, dict):
            return {key: self._normalize_value(item) for key, item in value.items()}
        return value

    def _build_search_documents(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
    ) -> list[dict[str, Any]]:
        artifacts = {
            "newsItems": self._build_news_items(market_key=market_key, market=market, generated_at=generated_at),
            "newsEvents": self._build_news_events(market_key=market_key, market=market, generated_at=generated_at),
        }
        return self._build_search_documents_from_artifacts(market_key=market_key, artifacts=artifacts)

    def _build_search_documents_from_artifacts(
        self,
        *,
        market_key: str,
        artifacts: dict[str, Any],
    ) -> list[dict[str, Any]]:
        documents: list[dict[str, Any]] = []
        for item in artifacts.get("newsItems", []) or []:
            documents.append(
                {
                    "id": item.get("id"),
                    "text": " ".join([str(item.get("title") or ""), str(item.get("summary") or ""), " ".join(str(tag) for tag in item.get("tags") or [])]),
                    "metadata": {
                        "kind": "news",
                        "market": market_key,
                        "title": item.get("title"),
                        "summary": item.get("summary"),
                        "tags": item.get("tags") or [],
                        "source": item.get("source"),
                        "publishedAt": item.get("publishedAt"),
                        "url": item.get("url"),
                    },
                }
            )
        for event in artifacts.get("newsEvents", []) or []:
            documents.append(
                {
                    "id": event.get("id"),
                    "text": " ".join(
                        [
                            str(event.get("title") or event.get("label") or ""),
                            str(event.get("summary") or ""),
                            str(event.get("eventTypeLabel") or ""),
                            str(event.get("sentimentLabel") or ""),
                            " ".join(str(tag) for tag in event.get("tags") or []),
                            " ".join(str(asset.get("label") or asset.get("symbol") or "") for asset in event.get("assets") or []),
                        ]
                    ),
                    "metadata": {
                        "kind": "event",
                        "market": market_key,
                        "title": event.get("title") or event.get("label"),
                        "summary": event.get("summary"),
                        "tags": event.get("tags") or [],
                        "sources": event.get("sources") or [],
                        "publishedAt": event.get("publishedAt"),
                        "count": event.get("count") or 0,
                    },
                }
            )
        return documents

    def _build_news_items(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
    ) -> list[dict[str, Any]]:
        previous_items = self.snapshot_repository.get_news_items(market=market_key) if self.snapshot_repository is not None else []
        previous_map = {
            str(item.get("dedupeKey") or item.get("id") or ""): item
            for item in (previous_items or [])
            if item.get("dedupeKey") or item.get("id")
        }
        group_membership = self._build_group_membership(market)
        items: list[dict[str, Any]] = []
        for headline in market.get("headlines", []) or []:
            dedupe_key = self._headline_identity(headline)
            previous = previous_map.get(dedupe_key, {})
            published_at = int(headline.get("publishedAt") or generated_at)
            items.append(
                {
                    "id": str(headline.get("id") or dedupe_key),
                    "dedupeKey": dedupe_key,
                    "market": market_key,
                    "title": str(headline.get("title") or ""),
                    "source": str(headline.get("source") or ""),
                    "summary": str(headline.get("summary") or ""),
                    "url": str(headline.get("url") or ""),
                    "tags": list(headline.get("tags") or []),
                    "publishedAt": published_at,
                    "firstSeenAt": int(previous.get("firstSeenAt") or published_at),
                    "lastSeenAt": generated_at,
                    "sightings": int(previous.get("sightings") or 0) + 1,
                    "groupIds": group_membership.get(str(headline.get("id") or ""), []),
                    "freshness": "new" if not previous else "tracked",
                }
            )
        return items

    def _build_news_events(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        generated_at: int,
    ) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        news_items = self._build_news_items(market_key=market_key, market=market, generated_at=generated_at)
        for item in news_items:
            event_key = self._event_identity(item)
            event_type = self._event_type(market_key, item)
            assets = self._extract_event_assets(market_key=market_key, market=market, item=item)
            event = grouped.setdefault(
                event_key,
                {
                    "id": f"{market_key}:event:{event_key}",
                    "eventId": f"{market_key}:event:{event_key}",
                    "market": market_key,
                    "title": self._event_label(item, event_type),
                    "eventType": event_type,
                    "eventTypeLabel": EVENT_TYPE_LABELS.get(event_type, EVENT_TYPE_LABELS["general"]),
                    "sentiment": self._event_sentiment(event_type=event_type, item=item),
                    "sentimentLabel": "",
                    "assetMap": {},
                    "sectorOrTheme": self._sector_or_theme(item),
                    "summary": str(item.get("summary") or item.get("title") or ""),
                    "summaryLines": [],
                    "headlineIds": [],
                    "headlines": [],
                    "tags": set(),
                    "sources": set(),
                    "firstSeenAt": int(item.get("firstSeenAt") or generated_at),
                    "lastSeenAt": int(item.get("lastSeenAt") or generated_at),
                    "publishedAt": int(item.get("publishedAt") or generated_at),
                    "freshness": str(item.get("freshness") or "tracked"),
                },
            )
            event["headlineIds"].append(item["id"])
            event["headlines"].append(
                {
                    "id": item["id"],
                    "title": item["title"],
                    "source": item["source"],
                    "publishedAt": item["publishedAt"],
                    "url": item["url"],
                }
            )
            event["tags"].update(item.get("tags") or [])
            if item.get("source"):
                event["sources"].add(item["source"])
            for asset in assets:
                asset_key = str(asset.get("symbol") or asset.get("label") or "")
                if asset_key and asset_key not in event["assetMap"]:
                    event["assetMap"][asset_key] = asset
            event["firstSeenAt"] = min(int(event["firstSeenAt"]), int(item.get("firstSeenAt") or generated_at))
            event["lastSeenAt"] = max(int(event["lastSeenAt"]), int(item.get("lastSeenAt") or generated_at))
            event["publishedAt"] = max(int(event["publishedAt"]), int(item.get("publishedAt") or generated_at))
            if item.get("freshness") == "new":
                event["freshness"] = "new"

        rows: list[dict[str, Any]] = []
        previous_events = self.snapshot_repository.get_news_events(market=market_key) if self.snapshot_repository is not None else []
        market_context = self._market_execution_context(market)
        for event in grouped.values():
            assets = list(event["assetMap"].values())
            novelty = self._event_novelty(
                market_key=market_key,
                title=str(event["title"]),
                summary=str(event["summary"]),
                event_type=str(event["eventType"]),
                tags=sorted(event["tags"])[:6],
                assets=assets,
                previous_events=previous_events or [],
                freshness=str(event["freshness"]),
            )
            similar_events = self._find_similar_events(
                market_key=market_key,
                title=str(event["title"]),
                event_type=str(event["eventType"]),
                tags=sorted(event["tags"])[:6],
                assets=assets,
                previous_events=previous_events or [],
            )
            sentiment_label = self._sentiment_label(str(event["sentiment"]))
            summary_lines = self._event_summary_lines(
                title=str(event["title"]),
                summary=str(event["summary"]),
                tags=sorted(event["tags"])[:4],
                assets=assets,
            )
            importance_score = self._event_importance_score(
                count=len(event["headlineIds"]),
                freshness=str(event["freshness"]),
                event_type=str(event["eventType"]),
                assets=assets,
                novelty_label=str(novelty.get("label") or ""),
                similar_events=similar_events,
            )
            execution = self._event_execution_state(
                sentiment=str(event["sentiment"]),
                importance_score=importance_score,
                novelty_label=str(novelty.get("label") or ""),
                confidence=self._event_confidence(
                    count=len(event["headlineIds"]),
                    assets=len(event["assetMap"]),
                    freshness=str(event["freshness"]),
                ),
                market_context=market_context,
            )
            rows.append(
                {
                    "id": event["id"],
                    "eventId": event["eventId"],
                    "market": event["market"],
                    "title": event["title"],
                    "label": event["title"],
                    "summary": event["summary"],
                    "summaryLines": summary_lines,
                    "eventType": event["eventType"],
                    "eventTypeLabel": event["eventTypeLabel"],
                    "sentiment": event["sentiment"],
                    "sentimentLabel": sentiment_label,
                    "assets": assets[:6],
                    "sectorOrTheme": event["sectorOrTheme"],
                    "sourceList": sorted(event["sources"])[:6],
                    "publishTime": event["publishedAt"],
                    "eventTime": event["publishedAt"],
                    "confidence": self._event_confidence(count=len(event["headlineIds"]), assets=len(event["assetMap"]), freshness=str(event["freshness"])),
                    "importanceScore": importance_score,
                    "worthTracking": importance_score >= 55 or event["freshness"] == "new",
                    "observationState": "watch" if importance_score >= 75 else "track" if importance_score >= 55 else "observe",
                    "novelty": novelty,
                    "similarEvents": similar_events,
                    "execution": execution,
                    "count": len(event["headlineIds"]),
                    "headlineIds": event["headlineIds"],
                    "headlines": sorted(event["headlines"], key=lambda row: row["publishedAt"], reverse=True)[:4],
                    "tags": sorted(event["tags"])[:6],
                    "sources": sorted(event["sources"])[:4],
                    "firstSeenAt": event["firstSeenAt"],
                    "lastSeenAt": event["lastSeenAt"],
                    "publishedAt": event["publishedAt"],
                    "freshness": event["freshness"],
                }
            )
        rows.sort(key=lambda item: (-int(item["importanceScore"]), item["freshness"] != "new", -int(item["publishedAt"])))
        return rows[:12]

    def _build_group_membership(self, market: dict[str, Any]) -> dict[str, list[str]]:
        membership: dict[str, list[str]] = {}
        for group in market.get("newsGroups", []) or []:
            group_id = str(group.get("groupId") or "")
            if not group_id:
                continue
            for item in group.get("items", []) or []:
                item_id = str(item.get("id") or "")
                if not item_id:
                    continue
                membership.setdefault(item_id, []).append(group_id)
        return membership

    def _headline_identity(self, headline: dict[str, Any]) -> str:
        url = str(headline.get("url") or "").strip()
        if url:
            return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
        normalized_title = self._normalize_text(str(headline.get("title") or ""))
        source = self._normalize_text(str(headline.get("source") or ""))
        return hashlib.sha1(f"{normalized_title}|{source}".encode("utf-8")).hexdigest()[:16]

    def _event_identity(self, item: dict[str, Any]) -> str:
        tags = "-".join(sorted(str(tag) for tag in (item.get("tags") or [])[:3]))
        title_basis = " ".join(self._title_tokens(str(item.get("title") or ""))[:6])
        basis = tags or title_basis or str(item.get("dedupeKey") or item.get("id") or "")
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

    def _event_label(self, item: dict[str, Any], event_type: str | None = None) -> str:
        tags = [str(tag) for tag in (item.get("tags") or []) if str(tag).strip()]
        if tags:
            prefix = EVENT_TYPE_LABELS.get(event_type or "", "")
            base = " / ".join(tags[:2])
            return f"{prefix} / {base}" if prefix and prefix not in base else base
        return str(item.get("title") or "news_event")

    def _event_type(self, market_key: str, item: dict[str, Any]) -> str:
        haystack = " ".join(
            [
                str(item.get("title") or ""),
                str(item.get("summary") or ""),
                " ".join(str(tag) for tag in item.get("tags") or []),
            ]
        ).lower()
        for event_type, keywords in EVENT_TYPE_KEYWORDS.get(market_key, {}).items():
            if any(keyword.lower() in haystack for keyword in keywords):
                return event_type
        return "general"

    def _event_sentiment(self, *, event_type: str, item: dict[str, Any]) -> str:
        haystack = " ".join(
            [
                str(item.get("title") or ""),
                str(item.get("summary") or ""),
                " ".join(str(tag) for tag in item.get("tags") or []),
            ]
        ).lower()
        if event_type in NEGATIVE_EVENT_TYPES:
            return "bearish"
        if event_type in POSITIVE_EVENT_TYPES:
            return "bullish"
        bearish_keywords = ("下滑", "处罚", "风险", "警示", "调查", "流出", "attack", "hack", "down")
        bullish_keywords = ("增长", "增持", "突破", "获批", "流入", "合作", "上线", "funding", "approval")
        if any(keyword in haystack for keyword in bearish_keywords):
            return "bearish"
        if any(keyword in haystack for keyword in bullish_keywords):
            return "bullish"
        return "neutral"

    def _sentiment_label(self, sentiment: str) -> str:
        return {
            "bullish": "利多",
            "bearish": "利空",
            "neutral": "中性",
        }.get(sentiment, "中性")

    def _sector_or_theme(self, item: dict[str, Any]) -> str:
        tags = [str(tag) for tag in (item.get("tags") or []) if str(tag).strip()]
        return tags[0] if tags else ""

    def _extract_event_assets(
        self,
        *,
        market_key: str,
        market: dict[str, Any],
        item: dict[str, Any],
    ) -> list[dict[str, str]]:
        text = " ".join([str(item.get("title") or ""), str(item.get("summary") or "")])
        assets: list[dict[str, str]] = []
        seen: set[str] = set()
        for candidate in market.get("watchlist", []) or []:
            symbol = str(candidate.get("symbol") or "").strip()
            label = str(candidate.get("label") or "").strip()
            aliases = [symbol.lower(), label.lower()]
            if any(alias and alias in text.lower() for alias in aliases):
                key = symbol or label
                if key and key not in seen:
                    seen.add(key)
                    assets.append(
                        {
                            "kind": "equity" if market_key == "a_share" else "token",
                            "symbol": symbol or label,
                            "label": label or symbol,
                        }
                    )
        patterns = [r"\b[0-9]{6}\b"] if market_key == "a_share" else [r"\b[A-Z]{2,10}\b", r"\$[A-Z]{2,10}\b"]
        for pattern in patterns:
            for match in re.findall(pattern, text):
                symbol = match.replace("$", "")
                if symbol in seen:
                    continue
                seen.add(symbol)
                assets.append(
                    {
                        "kind": "equity" if market_key == "a_share" else "token",
                        "symbol": symbol,
                        "label": symbol,
                    }
                )
        return assets[:6]

    def _event_summary_lines(
        self,
        *,
        title: str,
        summary: str,
        tags: list[str],
        assets: list[dict[str, Any]],
    ) -> list[str]:
        lines = [summary.strip() or title.strip()]
        if tags:
            lines.append(f"分类线索：{' / '.join(tags[:3])}")
        if assets:
            lines.append(f"影响对象：{' / '.join(str(item.get('label') or item.get('symbol') or '') for item in assets[:4])}")
        return [line for line in lines if line][:3]

    def _event_importance_score(
        self,
        *,
        count: int,
        freshness: str,
        event_type: str,
        assets: list[dict[str, Any]],
        novelty_label: str,
        similar_events: list[dict[str, Any]],
    ) -> int:
        score = 35
        score += min(count * 8, 24)
        score += 12 if freshness == "new" else 0
        score += 10 if event_type in {"policy", "security", "regulation", "earnings", "etf_institution"} else 0
        score += min(len(assets) * 5, 15)
        if novelty_label == "new_signal":
            score += 10
        if novelty_label == "known_story":
            score -= 8
        if similar_events:
            score += min(len(similar_events) * 3, 9)
        return max(0, min(score, 100))

    def _event_confidence(self, *, count: int, assets: int, freshness: str) -> str:
        score = count + assets + (1 if freshness == "new" else 0)
        if score >= 5:
            return "high"
        if score >= 3:
            return "medium"
        return "low"

    def _market_execution_context(self, market: dict[str, Any]) -> dict[str, Any]:
        tiles = market.get("tiles", []) or []
        pulse = market.get("pulse", []) or []
        avg_change = sum(float(item.get("changePct") or 0) for item in tiles) / max(len(tiles), 1)
        strong_pulse = sum(1 for item in pulse if float(item.get("changePct") or 0) >= 1)
        return {
            "avgChange": avg_change,
            "strongPulse": strong_pulse,
            "riskHint": str((market.get("overview", {}) or {}).get("mood") or ""),
        }

    def _event_execution_state(
        self,
        *,
        sentiment: str,
        importance_score: int,
        novelty_label: str,
        confidence: str,
        market_context: dict[str, Any],
    ) -> dict[str, Any]:
        avg_change = float(market_context.get("avgChange") or 0)
        strong_pulse = int(market_context.get("strongPulse") or 0)
        if sentiment == "bullish" and importance_score >= 78 and novelty_label == "new_signal" and confidence == "high" and (avg_change > 0 or strong_pulse >= 1):
            return {
                "state": "actionable",
                "label": "可执行",
                "reason": "事件偏利多、重要度高、属于新信号，且当前盘面没有明显逆风。",
            }
        if importance_score >= 55 or novelty_label in {"new_signal", "incremental"}:
            return {
                "state": "track",
                "label": "跟踪",
                "reason": "事件已有一定重要度或存在增量信息，适合继续跟踪后续演化。",
            }
        return {
            "state": "observe",
            "label": "观察",
            "reason": "当前更像背景噪音或已知叙事，先观察不急于动作。",
        }

    def _event_novelty(
        self,
        *,
        market_key: str,
        title: str,
        summary: str,
        event_type: str,
        tags: list[str],
        assets: list[dict[str, Any]],
        previous_events: list[dict[str, Any]],
        freshness: str,
    ) -> dict[str, Any]:
        if freshness == "new":
            return {
                "label": "new_signal",
                "title": "新信号",
                "summary": "这是新进入事件流的信号，适合优先检查。",
                "score": 85,
            }
        title_tokens = set(self._title_tokens(title))
        asset_keys = {str(item.get("symbol") or item.get("label") or "") for item in assets}
        best_overlap = 0.0
        for previous in previous_events:
            if str(previous.get("eventType") or "") != event_type:
                continue
            prev_tokens = set(self._title_tokens(str(previous.get("title") or "")))
            prev_assets = {str(item.get("symbol") or item.get("label") or "") for item in (previous.get("assets") or [])}
            tag_overlap = len(set(tags) & set(str(tag) for tag in previous.get("tags") or []))
            token_overlap = len(title_tokens & prev_tokens)
            asset_overlap = len(asset_keys & prev_assets)
            overlap = token_overlap * 0.35 + tag_overlap * 0.25 + asset_overlap * 0.4
            best_overlap = max(best_overlap, overlap)
        if best_overlap >= 1.5:
            return {
                "label": "known_story",
                "title": "已知叙事",
                "summary": "这条消息和最近事件流高度重合，更像旧闻延续或重复发酵。",
                "score": 25,
            }
        return {
            "label": "incremental",
            "title": "增量更新",
            "summary": "这是已有叙事上的增量更新，值得继续跟踪但不算全新事件。",
            "score": 55,
        }

    def _find_similar_events(
        self,
        *,
        market_key: str,
        title: str,
        event_type: str,
        tags: list[str],
        assets: list[dict[str, Any]],
        previous_events: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        current_tokens = set(self._title_tokens(title))
        current_assets = {str(item.get("symbol") or item.get("label") or "") for item in assets}
        matches: list[dict[str, Any]] = []
        for previous in previous_events:
            if str(previous.get("market") or "") != market_key:
                continue
            if str(previous.get("eventType") or "") != event_type:
                continue
            prev_tokens = set(self._title_tokens(str(previous.get("title") or "")))
            prev_assets = {str(item.get("symbol") or item.get("label") or "") for item in (previous.get("assets") or [])}
            overlap = len(current_tokens & prev_tokens) + len(current_assets & prev_assets) * 2 + len(set(tags) & set(str(tag) for tag in previous.get("tags") or []))
            if overlap <= 0:
                continue
            matches.append(
                {
                    "id": str(previous.get("eventId") or previous.get("id") or ""),
                    "title": str(previous.get("title") or previous.get("label") or ""),
                    "sentimentLabel": str(previous.get("sentimentLabel") or ""),
                    "publishedAt": int(previous.get("publishTime") or previous.get("publishedAt") or 0),
                    "score": overlap,
                }
            )
        matches.sort(key=lambda item: (-int(item.get("score") or 0), -int(item.get("publishedAt") or 0)))
        return matches[:3]

    def _normalize_text(self, value: str) -> str:
        return re.sub(r"\s+", " ", value.strip().lower())

    def _title_tokens(self, value: str) -> list[str]:
        normalized = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", value.lower())
        return [token for token in normalized.split() if len(token) >= 2]

    def _build_overview(self) -> dict[str, Any]:
        now = self.now_ms()
        feed_status: list[FeedStatus] = []

        a_indices, a_watch, a_status = self.a_share_provider.fetch_market_data()
        a_pulse, a_pulse_status = self.a_share_provider.fetch_sector_pulse()
        a_theme_pulse, a_theme_status = self.a_share_provider.fetch_theme_pulse()
        c_assets, c_status = self.crypto_provider.fetch_assets()
        c_events, c_events_status = self.crypto_provider.fetch_event_feed()

        a_groups, a_news, a_news_statuses = self.news_provider.fetch_news_groups(
            "a_share",
            "news-a-share",
            self.news_provider.get_default_queries("a_share"),
        )
        c_groups, c_news, c_news_statuses = self.news_provider.fetch_news_groups(
            "crypto",
            "news-crypto",
            self.news_provider.get_default_queries("crypto"),
        )

        feed_status.extend(
            [a_status, a_pulse_status, a_theme_status, c_status, c_events_status, *a_news_statuses, *c_news_statuses]
        )
        feed_status.extend(self._build_provider_statuses())

        markets = [
            self._build_a_share_market(
                indices=a_indices,
                watchlist=a_watch,
                pulse=[*a_pulse, *a_theme_pulse],
                headlines=a_news,
                news_groups=a_groups,
                now=now,
            ),
            self._build_crypto_market(
                assets=c_assets,
                events=c_events,
                headlines=c_news,
                news_groups=c_groups,
                now=now,
            ),
        ]

        top_themes = sorted(
            [*markets[0]["themes"], *markets[1]["themes"]],
            key=lambda item: item["score"],
            reverse=True,
        )[:8]
        headlines = sorted([*a_news, *c_news], key=lambda item: item["publishedAt"], reverse=True)[:16]
        live_sources = sum(1 for item in feed_status if item.ok)

        return {
            "generatedAt": now,
            "live": live_sources > 0,
            "summary": {
                "headline": "已把 A股与加密新闻按主题分组聚合，统一展示盘面、热点、事件与观察清单。",
                "liveSources": live_sources,
                "totalSources": len(feed_status),
                "topTheme": top_themes[0]["label"] if top_themes else "暂无主线",
                "riskMode": self._build_risk_mode(markets),
            },
            "sources": [
                {
                    "sourceId": item.source_id,
                    "label": item.label,
                    "ok": item.ok,
                    "detail": item.detail,
                    "updatedAt": item.updated_at,
                }
                for item in feed_status
            ],
            "markets": markets,
            "topThemes": top_themes,
            "headlines": headlines,
        }

    def _build_provider_statuses(self) -> list[FeedStatus]:
        statuses: list[FeedStatus] = []
        providers = get_data_provider_settings()

        tushare = providers.get("tushare", {})
        if tushare.get("configured"):
            status = tushare.get("status", {})
            statuses.append(
                FeedStatus(
                    "tushare-pro",
                    "Tushare Pro",
                    bool(status.get("ok")),
                    str(status.get("message") or "已配置 Tushare Token。"),
                    int(status.get("checkedAt") or 0),
                )
            )

        llm = providers.get("llm", {})
        if llm.get("configured"):
            status = llm.get("status", {})
            statuses.append(
                FeedStatus(
                    "llm-analysis",
                    "LLM 新闻分析",
                    bool(status.get("ok")) if llm.get("enabled") else False,
                    str(status.get("message") or "未启用 LLM，将使用系统过滤。"),
                    int(status.get("checkedAt") or 0),
                )
            )
        return statuses

    def _build_a_share_market(
        self,
        *,
        indices: list[dict[str, Any]],
        watchlist: list[dict[str, Any]],
        pulse: list[dict[str, Any]],
        headlines: list[dict[str, Any]],
        news_groups: list[dict[str, Any]],
        now: int,
    ) -> dict[str, Any]:
        advancers = sum(1 for item in indices if item["changePct"] >= 0)
        avg = sum(item["changePct"] for item in indices) / max(len(indices), 1)
        mood = "偏强" if advancers >= max(len(indices) - 1, 1) else "分化"
        return {
            "market": "a_share",
            "label": "A股",
            "generatedAt": now,
            "overview": {
                "headline": f"A股核心指数平均涨跌 {avg:.2f}% ，当前盘面{mood}。",
                "mood": mood,
                "breadth": f"{advancers}/{len(indices)} 个核心指数上涨",
                "commentary": "这里整合了 Tushare 指数、ETF 脉冲、主题脉冲与分组新闻聚合。",
                "verdict": self._build_a_share_verdict(avg, advancers, pulse),
            },
            "tiles": indices,
            "themes": self.news_provider.build_themes(headlines, "a_share"),
            "watchlist": watchlist[:4],
            "pulse": pulse[:4],
            "events": [],
            "headlines": headlines[:10],
            "newsGroups": news_groups,
        }

    def _build_crypto_market(
        self,
        *,
        assets: list[dict[str, Any]],
        events: list[dict[str, Any]],
        headlines: list[dict[str, Any]],
        news_groups: list[dict[str, Any]],
        now: int,
    ) -> dict[str, Any]:
        positive = sum(1 for item in assets if item["changePct"] >= 0)
        avg = sum(item["changePct"] for item in assets) / max(len(assets), 1)
        mood = "偏强" if avg >= 0 else "偏弱"
        return {
            "market": "crypto",
            "label": "加密",
            "generatedAt": now,
            "overview": {
                "headline": f"主流加密资产 24h 平均涨跌 {avg:.2f}% ，共有 {positive}/{len(assets)} 个上涨。",
                "mood": mood,
                "breadth": f"{positive}/{len(assets)} 个主流资产上涨",
                "commentary": "这里整合了 24h 宽度、24h 趋势、交易所事件和分组新闻聚合。",
                "verdict": self._build_crypto_verdict(avg, positive, events),
            },
            "tiles": assets,
            "themes": self.news_provider.build_themes(headlines, "crypto"),
            "watchlist": [
                {
                    "symbol": item["symbol"],
                    "label": item["label"],
                    "signal": "顺势跟踪" if item["changePct"] >= 1 else "等待确认",
                    "reason": item["commentary"],
                    "changePct": item["changePct"],
                    "price": item["last"],
                }
                for item in sorted(assets, key=lambda row: abs(row["changePct"]), reverse=True)[:4]
            ],
            "pulse": [],
            "events": events,
            "headlines": headlines[:10],
            "newsGroups": news_groups,
        }

    def _build_a_share_verdict(
        self,
        average_change: float,
        advancers: int,
        pulse: list[dict[str, Any]],
    ) -> str:
        strong_pulse = sum(1 for item in pulse if float(item.get("changePct") or 0) >= 1)
        if average_change >= 0.8 and advancers >= 3 and strong_pulse >= 2:
            return "风险偏好抬升，指数与主题共振偏强。"
        if average_change >= 0 and advancers >= 2:
            return "指数保持承接，适合继续观察主线轮动。"
        return "指数分化偏谨慎，优先等主线确认后再加仓。"

    def _build_crypto_verdict(
        self,
        average_change: float,
        positive_assets: int,
        events: list[dict[str, Any]],
    ) -> str:
        attention_events = sum(1 for item in events if item.get("severity") == "attention")
        if average_change >= 1 and positive_assets >= 3 and attention_events == 0:
            return "加密盘面偏强，趋势和事件面暂时同向。"
        if average_change >= 0 and positive_assets >= 2:
            return "加密盘面仍有承接，但需要继续盯住交易所事件。"
        return "加密波动偏弱，事件风险权重高于追涨冲动。"

    def _build_risk_mode(self, markets: list[dict[str, Any]]) -> dict[str, str]:
        score = 0
        reasons: list[str] = []
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
            return {
                "label": "风险偏好开启",
                "hint": "A股与加密同时偏强，可以更积极关注强势主线。",
                "reasons": " / ".join(reasons),
            }
        if score <= -1:
            return {
                "label": "风险偏好收缩",
                "hint": "至少一个市场明显转弱，优先控制节奏与仓位。",
                "reasons": " / ".join(reasons),
            }
        return {
            "label": "风险偏好中性",
            "hint": "跨市场没有形成一致方向，更适合结构化跟踪。",
            "reasons": " / ".join(reasons),
        }
