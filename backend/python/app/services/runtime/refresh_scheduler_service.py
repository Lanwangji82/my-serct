from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RefreshJobKind:
    MARKET_CATALOG: str = "refresh.market_catalog"
    MARKET_SERIES: str = "refresh.market_series"
    INTELLIGENCE_OVERVIEW: str = "refresh.intelligence.overview"


@dataclass(frozen=True)
class RefreshJobKey:
    MARKET_CATALOG: str = "market-catalog"
    INTELLIGENCE_OVERVIEW: str = "intelligence-overview"

    @staticmethod
    def market_series(*, market: str, exchange_id: str, market_type: str, symbol: str, interval: str, limit: int) -> str:
        return f"market-series:{market}:{exchange_id}:{market_type}:{symbol}:{interval}:{limit}"


class RefreshSchedulerService:
    def __init__(
        self,
        *,
        background_job_queue: Any,
        market_data_service,
        market_intelligence_service,
    ) -> None:
        self.background_job_queue = background_job_queue
        self.market_data_service = market_data_service
        self.market_intelligence_service = market_intelligence_service
        self.job_kind = RefreshJobKind()
        self.job_key = RefreshJobKey()
        self._job_stats: dict[str, dict[str, Any]] = {
            self.job_kind.MARKET_CATALOG: self._blank_job_stat(),
            self.job_kind.MARKET_SERIES: self._blank_job_stat(),
            self.job_kind.INTELLIGENCE_OVERVIEW: self._blank_job_stat(),
        }
        self._handlers = {
            self.job_kind.MARKET_CATALOG: self._handle_market_catalog,
            self.job_kind.MARKET_SERIES: self._handle_market_series,
            self.job_kind.INTELLIGENCE_OVERVIEW: self._handle_intelligence_overview,
        }

    def enqueue_market_catalog_refresh(self) -> bool:
        return self.background_job_queue.enqueue_unique(
            self.job_key.MARKET_CATALOG,
            {"kind": self.job_kind.MARKET_CATALOG},
            ttl_ms=30_000,
        )

    def enqueue_market_series_refresh(
        self,
        *,
        market: str,
        exchange_id: str | None,
        market_type: str | None,
        symbol: str,
        interval: str,
        limit: int,
    ) -> bool:
        normalized_exchange = exchange_id or "-"
        normalized_market_type = market_type or "-"
        return self.background_job_queue.enqueue_unique(
            self.job_key.market_series(
                market=market,
                exchange_id=normalized_exchange,
                market_type=normalized_market_type,
                symbol=symbol,
                interval=interval,
                limit=limit,
            ),
            {
                "kind": self.job_kind.MARKET_SERIES,
                "market": market,
                "exchangeId": normalized_exchange,
                "marketType": normalized_market_type,
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
            },
            ttl_ms=20_000,
        )

    def enqueue_intelligence_overview_refresh(self) -> bool:
        return self.background_job_queue.enqueue_unique(
            self.job_key.INTELLIGENCE_OVERVIEW,
            {"kind": self.job_kind.INTELLIGENCE_OVERVIEW},
            ttl_ms=30_000,
        )

    def warm_defaults(self) -> None:
        self.enqueue_market_catalog_refresh()
        self.enqueue_market_series_refresh(
            market="a_share",
            exchange_id=None,
            market_type=None,
            symbol="000001.SH",
            interval="1d",
            limit=800,
        )
        self.enqueue_market_series_refresh(
            market="crypto",
            exchange_id="binance",
            market_type="spot",
            symbol="BTC/USDT",
            interval="4h",
            limit=800,
        )
        self.enqueue_intelligence_overview_refresh()

    def process_next_job(self) -> bool:
        job = self.background_job_queue.pop()
        if not job:
            return False
        kind = str(job.get("kind") or "")
        handler = self._handlers.get(kind)
        if handler is None:
            self._record_job_result(kind or "unknown", ok=False, error="unknown-job-kind")
            return False
        try:
            handler(job)
            self._record_job_result(kind, ok=True)
        except Exception as exc:
            self._record_job_result(kind, ok=False, error=str(exc))
            raise
        return True

    def build_status(self) -> dict[str, Any]:
        return {
            "queue": self.background_job_queue.get_status(),
            "jobs": {
                kind: {
                    "kind": kind,
                    **stats,
                }
                for kind, stats in self._job_stats.items()
            },
        }

    def _handle_market_catalog(self, _job: dict[str, Any]) -> None:
        self.market_data_service.refresh_catalog()

    def _handle_market_series(self, job: dict[str, Any]) -> None:
        self.market_data_service.refresh_series(
            market=str(job.get("market") or "a_share"),
            symbol=str(job.get("symbol") or "000001.SH"),
            interval=str(job.get("interval") or "1d"),
            exchange_id=None if str(job.get("exchangeId") or "-") == "-" else str(job.get("exchangeId")),
            market_type=None if str(job.get("marketType") or "-") == "-" else str(job.get("marketType")),
            limit=int(job.get("limit") or 180),
        )

    def _handle_intelligence_overview(self, _job: dict[str, Any]) -> None:
        self.market_intelligence_service.refresh_overview()

    def _blank_job_stat(self) -> dict[str, Any]:
        return {
            "successCount": 0,
            "failureCount": 0,
            "lastRunAt": 0,
            "lastSuccessAt": 0,
            "lastFailureAt": 0,
            "lastError": "",
        }

    def _record_job_result(self, kind: str, *, ok: bool, error: str = "") -> None:
        stats = self._job_stats.setdefault(kind, self._blank_job_stat())
        now = self.market_intelligence_service.now_ms() if hasattr(self.market_intelligence_service, "now_ms") else 0
        stats["lastRunAt"] = now
        if ok:
            stats["successCount"] = int(stats["successCount"]) + 1
            stats["lastSuccessAt"] = now
            stats["lastError"] = ""
        else:
            stats["failureCount"] = int(stats["failureCount"]) + 1
            stats["lastFailureAt"] = now
            stats["lastError"] = error
