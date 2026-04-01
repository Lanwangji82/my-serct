from __future__ import annotations

from typing import Any

from ...adapters.providers.market_data_providers import (
    A_SHARE_SYMBOLS,
    CRYPTO_EXCHANGES,
    AshareMarketProvider,
    CryptoMarketProvider,
)


MARKET_CATALOG_CACHE_KEY = "market-data:catalog"
MARKET_BOARD_CACHE_PREFIX = "market-data:board:"
MARKET_SERIES_CACHE_PREFIX = "market-data:series:"


class MarketDataService:
    def __init__(
        self,
        *,
        redis_cache: Any,
        now_ms,
        network_runtime_adapter: Any | None = None,
        snapshot_repository: Any | None = None,
        refresh_scheduler: Any | None = None,
        a_share_provider: AshareMarketProvider | None = None,
        crypto_provider: CryptoMarketProvider | None = None,
        catalog_ttl_ms: int = 300_000,
        series_ttl_ms: int = 60_000,
    ) -> None:
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.network_runtime_adapter = network_runtime_adapter
        self.snapshot_repository = snapshot_repository
        self.refresh_scheduler = refresh_scheduler
        self.a_share_provider = a_share_provider or AshareMarketProvider(now_ms=now_ms)
        self.crypto_provider = crypto_provider or CryptoMarketProvider(
            now_ms=now_ms,
            network_runtime_adapter=network_runtime_adapter,
        )
        self.catalog_ttl_ms = catalog_ttl_ms
        self.series_ttl_ms = series_ttl_ms

    def get_catalog(self, force_refresh: bool = False) -> dict[str, Any]:
        if force_refresh:
            return self.refresh_catalog()

        cached = self.redis_cache.get_json(MARKET_CATALOG_CACHE_KEY)
        if cached is not None:
            return cached

        if self.snapshot_repository is not None:
            snapshot = self.snapshot_repository.get_market_catalog()
            if snapshot is not None:
                self.redis_cache.set_json(MARKET_CATALOG_CACHE_KEY, snapshot, self.catalog_ttl_ms)
                if self.refresh_scheduler is not None:
                    self.refresh_scheduler.enqueue_market_catalog_refresh()
                return snapshot

        return self.refresh_catalog()

    def refresh_catalog(self) -> dict[str, Any]:
        now = self.now_ms()
        payload = {
            "generatedAt": now,
            "sources": [
                self.a_share_provider.build_catalog_source(now_ms=now),
                self.crypto_provider.build_catalog_source(now_ms=now),
            ],
            "markets": [
                self.a_share_provider.build_market_catalog(),
                self.crypto_provider.build_market_catalog(),
            ],
        }
        self._persist_catalog(payload)
        return payload

    def get_series(
        self,
        *,
        market: str,
        symbol: str,
        interval: str,
        exchange_id: str | None = None,
        market_type: str | None = None,
        limit: int = 180,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        normalized_market = "crypto" if market == "crypto" else "a_share"
        normalized_interval = self._normalize_interval(normalized_market, interval)
        normalized_limit = max(60, min(int(limit), 1200))
        normalized_exchange = self.crypto_provider.normalize_exchange_id(exchange_id) if normalized_market == "crypto" else None
        normalized_market_type = self.crypto_provider.normalize_market_type(market_type) if normalized_market == "crypto" else None
        normalized_symbol = (
            symbol
            or (("BTC/USDT" if normalized_market_type != "swap" else "BTC/USDT:USDT") if normalized_market == "crypto" else "000001.SH")
        )
        cache_key = f"{MARKET_SERIES_CACHE_PREFIX}{normalized_market}:{normalized_exchange or '-'}:{normalized_market_type or '-'}:{normalized_symbol}:{normalized_interval}:{normalized_limit}"

        if force_refresh:
            return self.refresh_series(
                market=normalized_market,
                symbol=normalized_symbol,
                interval=normalized_interval,
                exchange_id=normalized_exchange,
                market_type=normalized_market_type,
                limit=normalized_limit,
            )

        cached = self.redis_cache.get_json(cache_key)
        if cached is not None and self._is_matching_series_payload(
            cached,
            market=normalized_market,
            exchange_id=normalized_exchange,
            market_type=normalized_market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
        ):
            return cached

        if self.snapshot_repository is not None:
            snapshot = self.snapshot_repository.get_market_series(
                market=normalized_market,
                exchange_id=normalized_exchange,
                market_type=normalized_market_type,
                symbol=normalized_symbol,
                interval=normalized_interval,
                limit=normalized_limit,
            )
            if snapshot is not None and self._is_matching_series_payload(
                snapshot,
                market=normalized_market,
                exchange_id=normalized_exchange,
                market_type=normalized_market_type,
                symbol=normalized_symbol,
                interval=normalized_interval,
            ):
                self.redis_cache.set_json(cache_key, snapshot, self.series_ttl_ms)
                if self.refresh_scheduler is not None:
                    self.refresh_scheduler.enqueue_market_series_refresh(
                        market=normalized_market,
                        exchange_id=normalized_exchange,
                        market_type=normalized_market_type,
                        symbol=normalized_symbol,
                        interval=normalized_interval,
                        limit=normalized_limit,
                    )
                return snapshot

        return self.refresh_series(
            market=normalized_market,
            symbol=normalized_symbol,
            interval=normalized_interval,
            exchange_id=normalized_exchange,
            market_type=normalized_market_type,
            limit=normalized_limit,
        )

    def get_board(
        self,
        *,
        market: str,
        exchange_id: str | None = None,
        market_type: str | None = None,
        page: int = 1,
        page_size: int = 100,
        sort_field: str = "changePct",
        sort_direction: str = "desc",
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        normalized_market = "crypto" if market == "crypto" else "a_share"
        normalized_exchange = self.crypto_provider.normalize_exchange_id(exchange_id) if normalized_market == "crypto" else None
        normalized_market_type = self.crypto_provider.normalize_market_type(market_type) if normalized_market == "crypto" else None
        normalized_page = max(1, int(page))
        normalized_page_size = max(20, min(int(page_size), 200))
        normalized_sort_field = sort_field if sort_field in {"changePct", "turnover", "marketCap"} else "changePct"
        normalized_sort_direction = "asc" if sort_direction == "asc" else "desc"
        cache_key = (
            f"{MARKET_BOARD_CACHE_PREFIX}{normalized_market}:{normalized_exchange or '-'}:{normalized_market_type or '-'}:"
            f"{normalized_page}:{normalized_page_size}:{normalized_sort_field}:{normalized_sort_direction}"
        )

        if force_refresh:
            return self.refresh_board(
                market=normalized_market,
                exchange_id=normalized_exchange,
                market_type=normalized_market_type,
                page=normalized_page,
                page_size=normalized_page_size,
                sort_field=normalized_sort_field,
                sort_direction=normalized_sort_direction,
            )

        cached = self.redis_cache.get_json(cache_key)
        if cached is not None:
            return cached

        payload = self.refresh_board(
            market=normalized_market,
            exchange_id=normalized_exchange,
            market_type=normalized_market_type,
            page=normalized_page,
            page_size=normalized_page_size,
            sort_field=normalized_sort_field,
            sort_direction=normalized_sort_direction,
        )
        self.redis_cache.set_json(cache_key, payload, self.series_ttl_ms)
        return payload

    def refresh_board(
        self,
        *,
        market: str,
        exchange_id: str | None = None,
        market_type: str | None = None,
        page: int = 1,
        page_size: int = 100,
        sort_field: str = "changePct",
        sort_direction: str = "desc",
    ) -> dict[str, Any]:
        normalized_market = "crypto" if market == "crypto" else "a_share"
        normalized_exchange = self.crypto_provider.normalize_exchange_id(exchange_id) if normalized_market == "crypto" else None
        normalized_market_type = self.crypto_provider.normalize_market_type(market_type) if normalized_market == "crypto" else None
        if normalized_market == "crypto":
            base_payload = self.crypto_provider.build_market_board(exchange_id=normalized_exchange or "binance", market_type=normalized_market_type)
            payload = self._project_board(
                base_payload,
                page=max(1, int(page)),
                page_size=max(20, min(int(page_size), 200)),
                sort_field=sort_field if sort_field in {"changePct", "turnover", "marketCap"} else "changePct",
                sort_direction="asc" if sort_direction == "asc" else "desc",
            )
        else:
            payload = self.a_share_provider.build_market_board_page(
                page=page,
                page_size=page_size,
                sort_field=sort_field,
                sort_direction=sort_direction,
            )
        cache_key = (
            f"{MARKET_BOARD_CACHE_PREFIX}{normalized_market}:{normalized_exchange or '-'}:{normalized_market_type or '-'}:"
            f"{max(1, int(page))}:{max(20, min(int(page_size), 200))}:{sort_field if sort_field in {'changePct', 'turnover', 'marketCap'} else 'changePct'}:{'asc' if sort_direction == 'asc' else 'desc'}"
        )
        self.redis_cache.set_json(cache_key, payload, self.series_ttl_ms)
        return payload

    def refresh_series(
        self,
        *,
        market: str,
        symbol: str,
        interval: str,
        exchange_id: str | None = None,
        market_type: str | None = None,
        limit: int = 180,
    ) -> dict[str, Any]:
        normalized_market = "crypto" if market == "crypto" else "a_share"
        normalized_interval = self._normalize_interval(normalized_market, interval)
        normalized_limit = max(60, min(int(limit), 1200))
        normalized_exchange = self.crypto_provider.normalize_exchange_id(exchange_id) if normalized_market == "crypto" else None
        normalized_market_type = self.crypto_provider.normalize_market_type(market_type) if normalized_market == "crypto" else None
        normalized_symbol = (
            symbol
            or (("BTC/USDT" if normalized_market_type != "swap" else "BTC/USDT:USDT") if normalized_market == "crypto" else "000001.SH")
        )

        if normalized_market == "crypto":
            payload = self.crypto_provider.build_series(
                exchange_id=normalized_exchange or "binance",
                symbol=normalized_symbol,
                interval=normalized_interval,
                market_type=normalized_market_type,
                limit=normalized_limit,
            )
        else:
            payload = self.a_share_provider.build_series(
                symbol=normalized_symbol,
                interval=normalized_interval,
                limit=normalized_limit,
            )

        enriched = self._build_indicator_pack(payload["candles"])
        payload["candles"] = enriched
        payload["snapshot"] = self._build_snapshot(
            market=normalized_market,
            payload=payload,
            candles=enriched,
        )
        payload["indicators"] = self._build_indicator_summary(enriched)
        payload["availableIndicators"] = ["volume", "macd", "rsi14"]

        self._persist_series(
            market=normalized_market,
            exchange_id=normalized_exchange,
            market_type=normalized_market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            limit=normalized_limit,
            payload=payload,
        )
        return payload

    def _normalize_interval(self, market: str, interval: str) -> str:
        return self.crypto_provider.normalize_interval(interval) if market == "crypto" else self.a_share_provider.normalize_interval(interval)

    def _build_snapshot(
        self,
        *,
        market: str,
        payload: dict[str, Any],
        candles: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if market == "crypto":
            snapshot = dict(payload.get("snapshot") or {})
            snapshot["changePct"] = float(snapshot.get("changePct") or self._calc_change_pct(candles))
            snapshot["high"] = float(snapshot.get("high") or max(item["high"] for item in candles[-30:]))
            snapshot["low"] = float(snapshot.get("low") or min(item["low"] for item in candles[-30:]))
            return snapshot

        last = candles[-1]
        recent = candles[-30:] if len(candles) >= 30 else candles
        return {
            "label": payload["symbolLabel"],
            "symbol": payload["symbol"],
            "last": last["close"],
            "changePct": self._calc_change_pct(candles),
            "high": max(item["high"] for item in recent),
            "low": min(item["low"] for item in recent),
            "volume": last["volume"],
            "quoteVolume": 0,
            "turnoverLabel": self._format_turnover(last["volume"]),
        }

    def _persist_catalog(self, payload: dict[str, Any]) -> None:
        self.redis_cache.set_json(MARKET_CATALOG_CACHE_KEY, payload, self.catalog_ttl_ms)
        if self.snapshot_repository is not None:
            self.snapshot_repository.save_market_catalog(payload, updated_at=self.now_ms())

    def _persist_series(
        self,
        *,
        market: str,
        exchange_id: str | None,
        market_type: str | None,
        symbol: str,
        interval: str,
        limit: int,
        payload: dict[str, Any],
    ) -> None:
        cache_key = f"{MARKET_SERIES_CACHE_PREFIX}{market}:{exchange_id or '-'}:{market_type or '-'}:{symbol}:{interval}:{limit}"
        self.redis_cache.set_json(cache_key, payload, self.series_ttl_ms)
        if self.snapshot_repository is not None:
            self.snapshot_repository.save_market_series(
                market=market,
                exchange_id=exchange_id,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                limit=limit,
                payload=payload,
                updated_at=self.now_ms(),
            )

    def _is_matching_series_payload(
        self,
        payload: dict[str, Any] | None,
        *,
        market: str,
        exchange_id: str | None,
        market_type: str | None,
        symbol: str,
        interval: str,
    ) -> bool:
        if not isinstance(payload, dict):
            return False

        payload_symbol = str(payload.get("symbol") or "").strip()
        payload_interval = str(payload.get("interval") or "").strip()
        if payload_symbol != symbol or payload_interval != interval:
            return False

        if market != "crypto":
            return True

        payload_exchange = str(payload.get("exchangeId") or "").strip()
        payload_market_type = str(payload.get("marketType") or "").strip()
        return payload_exchange == str(exchange_id or "") and payload_market_type == str(market_type or "")

    def _build_indicator_pack(self, candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        closes = [float(item["close"]) for item in candles]
        ma7 = self._sma(closes, 7)
        ma20 = self._sma(closes, 20)
        ema12 = self._ema(closes, 12)
        ema26 = self._ema(closes, 26)
        macd = [a - b if a is not None and b is not None else None for a, b in zip(ema12, ema26)]
        signal = self._ema_optional(macd, 9)
        histogram = [m - s if m is not None and s is not None else None for m, s in zip(macd, signal)]
        rsi14 = self._rsi(closes, 14)

        enriched: list[dict[str, Any]] = []
        for index, candle in enumerate(candles):
            enriched.append(
                {
                    **candle,
                    "ma7": ma7[index],
                    "ma20": ma20[index],
                    "ema12": ema12[index],
                    "ema26": ema26[index],
                    "macd": macd[index],
                    "signal": signal[index],
                    "histogram": histogram[index],
                    "rsi14": rsi14[index],
                }
            )
        return enriched

    def _build_indicator_summary(self, candles: list[dict[str, Any]]) -> dict[str, Any]:
        last = candles[-1]
        prev = candles[-2] if len(candles) > 1 else last
        trend = "多头" if (last.get("ma7") or 0) >= (last.get("ma20") or 0) else "震荡偏弱"
        macd_state = "金叉上方" if (last.get("macd") or 0) >= (last.get("signal") or 0) else "回落整理"
        rsi = last.get("rsi14")
        rsi_state = "超买" if isinstance(rsi, (int, float)) and rsi >= 70 else ("超卖" if isinstance(rsi, (int, float)) and rsi <= 30 else "中性")
        return {
            "trend": trend,
            "macdState": macd_state,
            "rsiState": rsi_state,
            "latest": {
                "ma7": last.get("ma7"),
                "ma20": last.get("ma20"),
                "ema12": last.get("ema12"),
                "ema26": last.get("ema26"),
                "macd": last.get("macd"),
                "signal": last.get("signal"),
                "histogram": last.get("histogram"),
                "rsi14": last.get("rsi14"),
            },
            "delta": {
                "closeChangePct": self._safe_pct(last.get("close"), prev.get("close")),
                "volumeChangePct": self._safe_pct(last.get("volume"), prev.get("volume")),
            },
        }

    def _sma(self, values: list[float], period: int) -> list[float | None]:
        result: list[float | None] = []
        for index in range(len(values)):
            if index + 1 < period:
                result.append(None)
                continue
            window = values[index + 1 - period : index + 1]
            result.append(sum(window) / period)
        return result

    def _project_board(
        self,
        payload: dict[str, Any],
        *,
        page: int,
        page_size: int,
        sort_field: str,
        sort_direction: str,
    ) -> dict[str, Any]:
        items = list(payload.get("items") or [])
        items.sort(
            key=lambda item: (
                float(item.get(sort_field) or 0),
                str(item.get("label") or ""),
            ),
            reverse=sort_direction == "desc",
        )
        total = len(items)
        start = (page - 1) * page_size
        end = start + page_size
        return {
            **payload,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "items": items[start:end],
        }

    def _ema(self, values: list[float], period: int) -> list[float | None]:
        result: list[float | None] = []
        multiplier = 2 / (period + 1)
        ema_value: float | None = None
        for value in values:
            ema_value = value if ema_value is None else (value - ema_value) * multiplier + ema_value
            result.append(ema_value)
        return result

    def _ema_optional(self, values: list[float | None], period: int) -> list[float | None]:
        result: list[float | None] = []
        multiplier = 2 / (period + 1)
        ema_value: float | None = None
        for value in values:
            if value is None:
                result.append(None)
                continue
            ema_value = value if ema_value is None else (value - ema_value) * multiplier + ema_value
            result.append(ema_value)
        return result

    def _rsi(self, values: list[float], period: int) -> list[float | None]:
        if len(values) < 2:
            return [None for _ in values]
        gains = [0.0]
        losses = [0.0]
        for index in range(1, len(values)):
            change = values[index] - values[index - 1]
            gains.append(max(change, 0.0))
            losses.append(abs(min(change, 0.0)))

        result: list[float | None] = []
        avg_gain = 0.0
        avg_loss = 0.0
        for index in range(len(values)):
            if index < period:
                avg_gain += gains[index]
                avg_loss += losses[index]
                result.append(None)
                continue
            if index == period:
                avg_gain /= period
                avg_loss /= period
            else:
                avg_gain = ((avg_gain * (period - 1)) + gains[index]) / period
                avg_loss = ((avg_loss * (period - 1)) + losses[index]) / period
            if avg_loss == 0:
                result.append(100.0)
            else:
                rs = avg_gain / avg_loss
                result.append(100 - (100 / (1 + rs)))
        return result

    def _calc_change_pct(self, candles: list[dict[str, Any]]) -> float:
        if len(candles) < 2:
            return 0.0
        return self._safe_pct(candles[-1]["close"], candles[-2]["close"])

    def _safe_pct(self, current: float | int | None, previous: float | int | None) -> float:
        try:
            current_value = float(current or 0)
            previous_value = float(previous or 0)
            if previous_value == 0:
                return 0.0
            return ((current_value / previous_value) - 1) * 100
        except Exception:
            return 0.0

    def _format_turnover(self, value: float) -> str:
        absolute = abs(value)
        if absolute >= 1_000_000_000:
            return f"{value / 1_000_000_000:.2f}B"
        if absolute >= 1_000_000:
            return f"{value / 1_000_000:.2f}M"
        if absolute >= 1_000:
            return f"{value / 1_000:.2f}K"
        return f"{value:.2f}"
