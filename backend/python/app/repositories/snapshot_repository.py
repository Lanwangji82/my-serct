from __future__ import annotations

from typing import Any

from .platform_repository import PlatformRepository


class SnapshotRepository:
    def __init__(self, repository: PlatformRepository) -> None:
        self.repository = repository

    def get_market_catalog(self) -> dict[str, Any] | None:
        item = self.repository.find_one("marketSnapshots", {"snapshotType": "market_catalog"})
        return item.get("payload") if item else None

    def save_market_catalog(self, payload: dict[str, Any], *, updated_at: int) -> None:
        self.repository.upsert_one(
            "marketSnapshots",
            {
                "id": "market-catalog",
                "snapshotType": "market_catalog",
                "updatedAt": updated_at,
                "payload": payload,
            },
        )

    def get_market_series(
        self,
        *,
        market: str,
        exchange_id: str | None,
        market_type: str | None,
        symbol: str,
        interval: str,
        limit: int,
    ) -> dict[str, Any] | None:
        item = self.repository.find_one(
            "marketSnapshots",
            {
                "snapshotType": "market_series",
                "market": market,
                "exchangeId": exchange_id or "-",
                "marketType": market_type or "-",
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
            },
        )
        return item.get("payload") if item else None

    def save_market_series(
        self,
        *,
        market: str,
        exchange_id: str | None,
        market_type: str | None,
        symbol: str,
        interval: str,
        limit: int,
        payload: dict[str, Any],
        updated_at: int,
    ) -> None:
        normalized_exchange = exchange_id or "-"
        normalized_market_type = market_type or "-"
        self.repository.upsert_one(
            "marketSnapshots",
            {
                "id": f"market-series:{market}:{normalized_exchange}:{normalized_market_type}:{symbol}:{interval}:{limit}",
                "snapshotType": "market_series",
                "market": market,
                "exchangeId": normalized_exchange,
                "marketType": normalized_market_type,
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
                "updatedAt": updated_at,
                "payload": payload,
            },
        )

    def get_intelligence_overview(self) -> dict[str, Any] | None:
        item = self.repository.find_one("intelligenceSnapshots", {"snapshotType": "overview"})
        return item.get("payload") if item else None

    def save_intelligence_overview(self, payload: dict[str, Any], *, updated_at: int) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": "intelligence-overview",
                "snapshotType": "overview",
                "updatedAt": updated_at,
                "payload": payload,
            },
        )

    def save_news_groups(
        self,
        *,
        market: str,
        groups: list[dict[str, Any]],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"news-groups:{market}",
                "snapshotType": "news_groups",
                "market": market,
                "updatedAt": updated_at,
                "payload": groups,
            },
        )

    def get_news_groups(self, *, market: str) -> list[dict[str, Any]] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "news_groups", "market": market},
        )
        return item.get("payload") if item else None

    def save_exchange_events(
        self,
        *,
        market: str,
        events: list[dict[str, Any]],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"exchange-events:{market}",
                "snapshotType": "exchange_events",
                "market": market,
                "updatedAt": updated_at,
                "payload": events,
            },
        )

    def get_exchange_events(self, *, market: str) -> list[dict[str, Any]] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "exchange_events", "market": market},
        )
        return item.get("payload") if item else None

    def save_llm_digests(
        self,
        *,
        market: str,
        digests: list[dict[str, Any]],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"llm-digests:{market}",
                "snapshotType": "llm_digests",
                "market": market,
                "updatedAt": updated_at,
                "payload": digests,
            },
        )

    def get_llm_digests(self, *, market: str) -> list[dict[str, Any]] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "llm_digests", "market": market},
        )
        return item.get("payload") if item else None

    def save_news_items(
        self,
        *,
        market: str,
        items: list[dict[str, Any]],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"news-items:{market}",
                "snapshotType": "news_items",
                "market": market,
                "updatedAt": updated_at,
                "payload": items,
            },
        )

    def get_news_items(self, *, market: str) -> list[dict[str, Any]] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "news_items", "market": market},
        )
        return item.get("payload") if item else None

    def save_news_events(
        self,
        *,
        market: str,
        events: list[dict[str, Any]],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"news-events:{market}",
                "snapshotType": "news_events",
                "market": market,
                "updatedAt": updated_at,
                "payload": events,
            },
        )

    def get_news_events(self, *, market: str) -> list[dict[str, Any]] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "news_events", "market": market},
        )
        return item.get("payload") if item else None

    def save_briefs(
        self,
        *,
        market: str,
        briefs: dict[str, Any],
        updated_at: int,
    ) -> None:
        self.repository.upsert_one(
            "intelligenceSnapshots",
            {
                "id": f"briefs:{market}",
                "snapshotType": "briefs",
                "market": market,
                "updatedAt": updated_at,
                "payload": briefs,
            },
        )

    def get_briefs(self, *, market: str) -> dict[str, Any] | None:
        item = self.repository.find_one(
            "intelligenceSnapshots",
            {"snapshotType": "briefs", "market": market},
        )
        return item.get("payload") if item else None

    def cleanup_snapshot_history(
        self,
        *,
        market_series_max_age_ms: int,
        intelligence_max_age_ms: int,
        now_ms: int,
    ) -> dict[str, int]:
        market_cutoff = now_ms - market_series_max_age_ms
        intelligence_cutoff = now_ms - intelligence_max_age_ms
        removed_market = self.repository.delete_many(
            "marketSnapshots",
            filter_query={
                "snapshotType": "market_series",
                "updatedAt": {"$lt": market_cutoff},
            },
        )
        removed_intelligence = self.repository.delete_many(
            "intelligenceSnapshots",
            filter_query={
                "snapshotType": {"$in": ["overview", "news_groups", "exchange_events", "llm_digests", "news_items", "news_events", "briefs"]},
                "updatedAt": {"$lt": intelligence_cutoff},
            },
        )
        return {
            "marketSnapshots": removed_market,
            "intelligenceSnapshots": removed_intelligence,
        }

    def build_snapshot_status(self) -> dict[str, Any]:
        return {
            "marketSnapshots": {
                "catalog": self.repository.count_collection(
                    "marketSnapshots",
                    filter_query={"snapshotType": "market_catalog"},
                ),
                "series": self.repository.count_collection(
                    "marketSnapshots",
                    filter_query={"snapshotType": "market_series"},
                ),
            },
            "intelligenceSnapshots": {
                "overview": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "overview"},
                ),
                "newsGroups": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "news_groups"},
                ),
                "exchangeEvents": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "exchange_events"},
                ),
                "llmDigests": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "llm_digests"},
                ),
                "newsItems": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "news_items"},
                ),
                "newsEvents": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "news_events"},
                ),
                "briefs": self.repository.count_collection(
                    "intelligenceSnapshots",
                    filter_query={"snapshotType": "briefs"},
                ),
            },
        }
