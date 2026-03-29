from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

try:
    import ccxt  # type: ignore
except ImportError:  # pragma: no cover
    ccxt = None  # type: ignore


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuantX/0.1"
DEFAULT_TIMEOUT = 12
MARKET_CATALOG_CACHE_KEY = "market-data:catalog"
MARKET_SERIES_CACHE_PREFIX = "market-data:series:"

A_SHARE_SYMBOLS = (
    {"symbol": "000001.SH", "label": "上证指数", "kind": "index", "secid": "1.000001"},
    {"symbol": "399001.SZ", "label": "深证成指", "kind": "index", "secid": "0.399001"},
    {"symbol": "399006.SZ", "label": "创业板指", "kind": "index", "secid": "0.399006"},
    {"symbol": "000300.SH", "label": "沪深300", "kind": "index", "secid": "1.000300"},
    {"symbol": "000001.SZ", "label": "平安银行", "kind": "stock", "secid": "0.000001"},
    {"symbol": "600519.SH", "label": "贵州茅台", "kind": "stock", "secid": "1.600519"},
    {"symbol": "300750.SZ", "label": "宁德时代", "kind": "stock", "secid": "0.300750"},
    {"symbol": "601127.SH", "label": "赛力斯", "kind": "stock", "secid": "1.601127"},
)

CRYPTO_EXCHANGES = (
    {"exchangeId": "binance", "label": "Binance", "symbols": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT")},
    {"exchangeId": "okx", "label": "OKX", "symbols": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "TON/USDT")},
    {"exchangeId": "bybit", "label": "Bybit", "symbols": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT")},
)

A_SHARE_INTERVALS = ("5m", "15m", "30m", "60m", "1d", "1w")
CRYPTO_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")


class MarketDataService:
    def __init__(
        self,
        *,
        redis_cache: Any,
        now_ms,
        network_runtime_adapter: Any | None = None,
        catalog_ttl_ms: int = 300_000,
        series_ttl_ms: int = 60_000,
    ) -> None:
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.network_runtime_adapter = network_runtime_adapter
        self.catalog_ttl_ms = catalog_ttl_ms
        self.series_ttl_ms = series_ttl_ms

    def get_catalog(self, force_refresh: bool = False) -> dict[str, Any]:
        if not force_refresh:
            cached = self.redis_cache.get_json(MARKET_CATALOG_CACHE_KEY)
            if cached is not None:
                return cached

        now = self.now_ms()
        payload = {
            "generatedAt": now,
            "sources": [
                {
                    "sourceId": "a-share-eastmoney",
                    "label": "东方财富 A股行情",
                    "ok": True,
                    "detail": "A股行情模块统一使用东方财富公开行情接口，覆盖指数、个股与分钟线。",
                    "updatedAt": now,
                },
                {
                    "sourceId": "crypto-ccxt",
                    "label": "CCXT 交易所行情",
                    "ok": ccxt is not None,
                    "detail": "通过 ccxt 统一接 Binance / OKX / Bybit 公共行情。" if ccxt is not None else "未检测到 ccxt，无法使用加密交易所行情。",
                    "updatedAt": now,
                },
            ],
            "markets": [
                {
                    "market": "a_share",
                    "label": "A股行情",
                    "defaultSymbol": "000001.SH",
                    "defaultInterval": "1d",
                    "intervals": list(A_SHARE_INTERVALS),
                    "symbols": [{"symbol": item["symbol"], "label": item["label"], "kind": item["kind"]} for item in A_SHARE_SYMBOLS],
                },
                {
                    "market": "crypto",
                    "label": "交易所行情",
                    "defaultExchangeId": "binance",
                    "defaultSymbol": "BTC/USDT",
                    "defaultInterval": "4h",
                    "intervals": list(CRYPTO_INTERVALS),
                    "exchanges": [
                        {
                            "exchangeId": item["exchangeId"],
                            "label": item["label"],
                            "symbols": [{"symbol": symbol, "label": symbol.replace("/USDT", "")} for symbol in item["symbols"]],
                        }
                        for item in CRYPTO_EXCHANGES
                    ],
                },
            ],
        }
        self.redis_cache.set_json(MARKET_CATALOG_CACHE_KEY, payload, self.catalog_ttl_ms)
        return payload

    def get_series(
        self,
        *,
        market: str,
        symbol: str,
        interval: str,
        exchange_id: str | None = None,
        limit: int = 180,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        normalized_market = "crypto" if market == "crypto" else "a_share"
        normalized_interval = self._normalize_interval(normalized_market, interval)
        normalized_limit = max(60, min(int(limit), 1200))
        normalized_exchange = self._normalize_exchange_id(exchange_id) if normalized_market == "crypto" else None
        cache_key = f"{MARKET_SERIES_CACHE_PREFIX}{normalized_market}:{normalized_exchange or '-'}:{symbol}:{normalized_interval}:{normalized_limit}"
        if not force_refresh:
            cached = self.redis_cache.get_json(cache_key)
            if cached is not None:
                return cached

        if normalized_market == "crypto":
            payload = self._build_crypto_series(
                exchange_id=normalized_exchange or "binance",
                symbol=symbol or "BTC/USDT",
                interval=normalized_interval,
                limit=normalized_limit,
            )
        else:
            payload = self._build_a_share_series(symbol=symbol or "000001.SH", interval=normalized_interval, limit=normalized_limit)

        self.redis_cache.set_json(cache_key, payload, self.series_ttl_ms)
        return payload

    def _build_a_share_series(self, *, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        spec = self._resolve_a_share_symbol(symbol)
        candles, source_ok, source_detail = self._fetch_eastmoney_kline(spec, interval, limit)
        enriched = self._build_indicator_pack(candles)
        snapshot = self._build_snapshot_from_candles(spec["label"], spec["symbol"], enriched)
        return {
            "generatedAt": self.now_ms(),
            "market": "a_share",
            "label": "A股行情",
            "exchangeId": "eastmoney",
            "exchangeLabel": "东方财富",
            "symbol": spec["symbol"],
            "symbolLabel": spec["label"],
            "interval": interval,
            "source": {
                "sourceId": "eastmoney-kline",
                "label": "东方财富 K线",
                "ok": source_ok,
                "detail": source_detail,
                "updatedAt": self.now_ms(),
            },
            "snapshot": snapshot,
            "candles": enriched,
            "indicators": self._build_indicator_summary(enriched),
            "availableIndicators": ["volume", "macd", "rsi14"],
        }

    def _build_crypto_series(self, *, exchange_id: str, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        exchange = self._create_exchange(exchange_id)
        try:
            exchange.load_markets()
            ticker = exchange.fetch_ticker(symbol)
            raw_candles = exchange.fetch_ohlcv(symbol, timeframe=interval, limit=limit)
            source_ok = True
            source_detail = f"已通过 {exchange_id} 拉取 {len(raw_candles)} 根 {interval} K线。"
        except Exception as exc:
            source_ok = False
            source_detail = f"{exc}，已回退示例行情。"
            raw_candles = self._seed_crypto_candles(symbol, interval, limit)
            ticker = {
                "last": raw_candles[-1][4],
                "percentage": ((raw_candles[-1][4] / raw_candles[-2][4]) - 1) * 100 if len(raw_candles) > 1 else 0,
                "baseVolume": raw_candles[-1][5],
                "quoteVolume": raw_candles[-1][4] * raw_candles[-1][5],
                "high": max(item[2] for item in raw_candles),
                "low": min(item[3] for item in raw_candles),
            }

        candles = [
            {
                "ts": int(item[0]),
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
                "volume": float(item[5]),
            }
            for item in raw_candles
        ]
        enriched = self._build_indicator_pack(candles)
        snapshot = {
            "label": symbol.replace("/USDT", ""),
            "symbol": symbol,
            "last": float(ticker.get("last") or enriched[-1]["close"]),
            "changePct": float(ticker.get("percentage") or self._calc_change_pct(enriched)),
            "high": float(ticker.get("high") or max(item["high"] for item in enriched[-30:])),
            "low": float(ticker.get("low") or min(item["low"] for item in enriched[-30:])),
            "volume": float(ticker.get("baseVolume") or 0),
            "quoteVolume": float(ticker.get("quoteVolume") or 0),
            "turnoverLabel": self._format_turnover(float(ticker.get("quoteVolume") or 0)),
        }
        return {
            "generatedAt": self.now_ms(),
            "market": "crypto",
            "label": "交易所行情",
            "exchangeId": exchange_id,
            "exchangeLabel": exchange_id.upper(),
            "symbol": symbol,
            "symbolLabel": symbol.replace("/USDT", ""),
            "interval": interval,
            "source": {
                "sourceId": f"ccxt-{exchange_id}",
                "label": f"{exchange_id.upper()} / ccxt",
                "ok": source_ok,
                "detail": source_detail,
                "updatedAt": self.now_ms(),
            },
            "snapshot": snapshot,
            "candles": enriched,
            "indicators": self._build_indicator_summary(enriched),
            "availableIndicators": ["volume", "macd", "rsi14"],
        }

    def _fetch_eastmoney_kline(self, spec: dict[str, str], interval: str, limit: int) -> tuple[list[dict[str, Any]], bool, str]:
        klt = {
            "5m": "5",
            "15m": "15",
            "30m": "30",
            "60m": "60",
            "1d": "101",
            "1w": "102",
        }.get(interval, "101")
        query = urllib.parse.urlencode(
            {
                "fields1": "f1,f2,f3,f4,f5,f6",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
                "secid": spec["secid"],
                "klt": klt,
                "fqt": "1",
                "beg": "0",
                "end": "20500101",
                "lmt": str(limit),
            }
        )
        url = f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{query}"
        try:
            payload = json.loads(self._fetch_text(url))
            klines = payload.get("data", {}).get("klines", []) or []
            candles = []
            for row in klines:
                parts = str(row).split(",")
                if len(parts) < 6:
                    continue
                candles.append(
                    {
                        "ts": self._eastmoney_time_to_ts(parts[0]),
                        "open": float(parts[1]),
                        "close": float(parts[2]),
                        "high": float(parts[3]),
                        "low": float(parts[4]),
                        "volume": float(parts[5]),
                    }
                )
            if candles:
                return candles[-limit:], True, f"已通过东方财富拉取 {len(candles[-limit:])} 根 {interval} K线。"
            raise RuntimeError("东方财富未返回 K 线数据。")
        except Exception as exc:
            return self._seed_a_share_candles(spec, interval, limit), False, f"{exc}，已回退示例行情。"

    def _resolve_a_share_symbol(self, symbol: str) -> dict[str, str]:
        normalized = (symbol or "000001.SH").strip().upper()
        for item in A_SHARE_SYMBOLS:
            if item["symbol"] == normalized:
                return dict(item)
        return dict(A_SHARE_SYMBOLS[0])

    def _normalize_interval(self, market: str, interval: str) -> str:
        candidate = (interval or "").strip()
        allowed = CRYPTO_INTERVALS if market == "crypto" else A_SHARE_INTERVALS
        return candidate if candidate in allowed else allowed[-1]

    def _normalize_exchange_id(self, exchange_id: str | None) -> str:
        candidate = (exchange_id or "binance").strip().lower()
        supported = {item["exchangeId"] for item in CRYPTO_EXCHANGES}
        return candidate if candidate in supported else "binance"

    def _create_exchange(self, exchange_id: str):
        if ccxt is None:
            raise RuntimeError("ccxt is not available.")
        exchange_class = getattr(ccxt, exchange_id, None)
        if exchange_class is None:
            raise RuntimeError(f"Unsupported exchange: {exchange_id}")
        exchange = exchange_class({"enableRateLimit": True})
        proxy_environment = self._get_proxy_environment(exchange_id)
        # ccxt Python does not allow multiple proxy fields at once. Most exchange
        # REST endpoints here are HTTPS, so prefer the configured HTTPS proxy.
        if proxy_environment.get("httpsProxy"):
            exchange.httpsProxy = proxy_environment["httpsProxy"]
        elif proxy_environment.get("socksProxy"):
            exchange.socksProxy = proxy_environment["socksProxy"]
        elif proxy_environment.get("httpProxy"):
            exchange.httpProxy = proxy_environment["httpProxy"]
        return exchange

    def _get_proxy_environment(self, exchange_id: str) -> dict[str, str]:
        if self.network_runtime_adapter is None:
            return {}
        try:
            return self.network_runtime_adapter.get_proxy_environment(exchange_id)
        except Exception:
            return {}

    def _fetch_text(self, url: str) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="ignore")

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

    def _build_snapshot_from_candles(self, label: str, symbol: str, candles: list[dict[str, Any]]) -> dict[str, Any]:
        last = candles[-1]
        recent = candles[-30:] if len(candles) >= 30 else candles
        return {
            "label": label,
            "symbol": symbol,
            "last": last["close"],
            "changePct": self._calc_change_pct(candles),
            "high": max(item["high"] for item in recent),
            "low": min(item["low"] for item in recent),
            "volume": last["volume"],
            "quoteVolume": 0,
            "turnoverLabel": self._format_turnover(last["volume"]),
        }

    def _seed_crypto_candles(self, symbol: str, interval: str, limit: int) -> list[list[float]]:
        step_ms = self._interval_to_ms(interval)
        base = 100 if symbol.startswith("SOL") else 3000 if symbol.startswith("ETH") else 68000
        now = self.now_ms()
        rows: list[list[float]] = []
        last_close = float(base)
        for index in range(limit):
            ts = now - (limit - index) * step_ms
            drift = math.sin(index / 8) * (base * 0.004)
            close = max(1.0, last_close + drift)
            open_price = last_close
            high = max(open_price, close) * 1.003
            low = min(open_price, close) * 0.997
            volume = abs(drift) * 120 + 1000
            rows.append([ts, open_price, high, low, close, volume])
            last_close = close
        return rows

    def _seed_a_share_candles(self, spec: dict[str, str], interval: str, limit: int) -> list[dict[str, Any]]:
        step_ms = self._interval_to_ms(interval)
        base = 3200 if spec["kind"] == "index" else 40
        now = self.now_ms()
        rows: list[dict[str, Any]] = []
        last_close = float(base)
        for index in range(limit):
            ts = now - (limit - index) * step_ms
            drift = math.sin(index / 6) * (base * 0.003)
            close = max(0.5, last_close + drift)
            open_price = last_close
            high = max(open_price, close) * 1.002
            low = min(open_price, close) * 0.998
            volume = abs(drift) * 80 + 500
            rows.append({"ts": ts, "open": open_price, "high": high, "low": low, "close": close, "volume": volume})
            last_close = close
        return rows

    def _eastmoney_time_to_ts(self, value: str) -> int:
        if " " in value:
            return int(datetime.strptime(value, "%Y-%m-%d %H:%M").timestamp() * 1000)
        return int(datetime.strptime(value, "%Y-%m-%d").timestamp() * 1000)

    def _interval_to_ms(self, interval: str) -> int:
        mapping = {
            "1m": 60_000,
            "5m": 300_000,
            "15m": 900_000,
            "30m": 1_800_000,
            "60m": 3_600_000,
            "1h": 3_600_000,
            "4h": 14_400_000,
            "1d": 86_400_000,
            "1w": 604_800_000,
        }
        return mapping.get(interval, 86_400_000)

    def _sma(self, values: list[float], period: int) -> list[float | None]:
        result: list[float | None] = []
        for index in range(len(values)):
            if index + 1 < period:
                result.append(None)
                continue
            window = values[index + 1 - period : index + 1]
            result.append(sum(window) / period)
        return result

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
