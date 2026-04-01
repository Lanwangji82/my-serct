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
    {
        "exchangeId": "binance",
        "label": "Binance",
        "fallbackSymbolsByMarketType": {
            "spot": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT"),
            "swap": ("BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "BNB/USDT:USDT"),
        },
        "excludedSymbolsByMarketType": {
            "spot": ("ALPACA/USDT", "BNX/USDT"),
            "swap": ("ALPACA/USDT:USDT", "BNX/USDT:USDT"),
        },
    },
    {
        "exchangeId": "okx",
        "label": "OKX",
        "fallbackSymbolsByMarketType": {
            "spot": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "TON/USDT"),
            "swap": ("BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "TON/USDT:USDT"),
        },
        "excludedSymbolsByMarketType": {
            "spot": (),
            "swap": (),
        },
    },
    {
        "exchangeId": "bybit",
        "label": "Bybit",
        "fallbackSymbolsByMarketType": {
            "spot": ("BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"),
            "swap": ("BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "XRP/USDT:USDT"),
        },
        "excludedSymbolsByMarketType": {
            "spot": (),
            "swap": (),
        },
    },
)

A_SHARE_INTERVALS = ("5m", "15m", "30m", "60m", "1d", "1w")
CRYPTO_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")
CRYPTO_MARKET_TYPES = ("spot", "swap")
CRYPTO_CATALOG_SYMBOL_LIMIT = 24
CRYPTO_BOARD_MAX_ITEMS = 240


class AshareMarketProvider:
    def __init__(self, *, now_ms) -> None:
        self.now_ms = now_ms

    def build_catalog_source(self, *, now_ms: int) -> dict[str, Any]:
        return {
            "sourceId": "a-share-eastmoney",
            "label": "东方财富 A股行情",
            "ok": True,
            "detail": "A股行情模块统一使用东方财富公开行情接口，覆盖指数、个股与分钟线。",
            "updatedAt": now_ms,
        }

    def build_market_catalog(self) -> dict[str, Any]:
        return {
            "market": "a_share",
            "label": "A股行情",
            "defaultSymbol": "000001.SH",
            "defaultInterval": "1d",
            "intervals": list(A_SHARE_INTERVALS),
            "symbols": [{"symbol": item["symbol"], "label": item["label"], "kind": item["kind"]} for item in A_SHARE_SYMBOLS],
        }

    def build_market_board(
        self,
        *,
        page: int = 1,
        page_size: int = 100,
        sort_field: str = "changePct",
        sort_direction: str = "desc",
    ) -> dict[str, Any]:
        now = self.now_ms()
        try:
            items = []
            normalized_page = max(1, int(page))
            normalized_page_size = max(20, min(int(page_size), 200))
            normalized_sort_field = sort_field if sort_field in {"changePct", "turnover", "marketCap"} else "changePct"
            normalized_sort_direction = "asc" if sort_direction == "asc" else "desc"
            query = urllib.parse.urlencode(
                {
                    "pn": str(normalized_page),
                    "pz": str(normalized_page_size),
                    "po": "0" if normalized_sort_direction == "asc" else "1",
                    "np": "1",
                    "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    "fltt": "2",
                    "invt": "2",
                    "fid": {"changePct": "f3", "turnover": "f6", "marketCap": "f20"}[normalized_sort_field],
                    "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
                    "fields": "f2,f3,f6,f12,f13,f14,f20,f21",
                }
            )
            payload = json.loads(self._fetch_text(f"https://push2.eastmoney.com/api/qt/clist/get?{query}"))
            data = payload.get("data", {}) or {}
            total = int(data.get("total") or 0)
            diff = data.get("diff", []) or []
            for row in diff:
                code = str(row.get("f12") or "").strip()
                market_id = str(row.get("f13") or "").strip()
                label = str(row.get("f14") or code).strip()
                if not code:
                    continue
                suffix = ".SH" if market_id == "1" else ".SZ"
                symbol = f"{code}{suffix}"
                turnover = self._safe_float(row.get("f6"))
                market_cap = self._safe_float(row.get("f20")) or self._safe_float(row.get("f21"))
                items.append(
                    {
                        "symbol": symbol,
                        "label": label,
                        "kind": "stock",
                        "exchangeId": "eastmoney",
                            "exchangeLabel": "东方财富",
                        "last": self._safe_float(row.get("f2")),
                        "changePct": self._safe_float(row.get("f3")),
                        "turnover": turnover,
                        "turnoverLabel": self._format_turnover(turnover),
                        "marketCap": market_cap,
                        "marketCapLabel": self._format_turnover(market_cap),
                        "sourceOk": True,
                    }
                )
            return {
                "market": "a_share",
                "label": "A股列表",
                "generatedAt": now,
                "source": {
                    "sourceId": "eastmoney-board",
                    "label": "东方财富全市场列表",
                    "ok": True,
                    "detail": f"已拉取 {len(items)} 只 A股股票的涨跌幅、成交额和市值。",
                    "updatedAt": now,
                },
                "items": items,
            }
        except Exception as exc:
            items = [
                {
                    "symbol": item["symbol"],
                    "label": item["label"],
                    "kind": item["kind"],
                    "exchangeId": "eastmoney",
                    "exchangeLabel": "东方财富",
                    "last": 0.0,
                    "changePct": 0.0,
                    "turnover": 0.0,
                    "turnoverLabel": "--",
                    "marketCap": 0.0,
                    "marketCapLabel": "--",
                    "sourceOk": False,
                }
                for item in A_SHARE_SYMBOLS
                if item["kind"] == "stock"
            ]
            return {
                "market": "a_share",
                "label": "A股列表",
                "generatedAt": now,
                "source": {
                    "sourceId": "eastmoney-board",
                    "label": "东方财富全市场列表",
                    "ok": False,
                    "detail": f"{exc}，当前回退到核心股票样本。",
                    "updatedAt": now,
                },
                "items": items,
            }

    def build_market_board_page(
        self,
        *,
        page: int = 1,
        page_size: int = 100,
        sort_field: str = "changePct",
        sort_direction: str = "desc",
    ) -> dict[str, Any]:
        now = self.now_ms()
        normalized_page = max(1, int(page))
        normalized_page_size = max(20, min(int(page_size), 200))
        normalized_sort_field = sort_field if sort_field in {"changePct", "turnover", "marketCap"} else "changePct"
        normalized_sort_direction = "asc" if sort_direction == "asc" else "desc"
        try:
            query = urllib.parse.urlencode(
                {
                    "pn": str(normalized_page),
                    "pz": str(normalized_page_size),
                    "po": "0" if normalized_sort_direction == "asc" else "1",
                    "np": "1",
                    "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    "fltt": "2",
                    "invt": "2",
                    "fid": {"changePct": "f3", "turnover": "f6", "marketCap": "f20"}[normalized_sort_field],
                    "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
                    "fields": "f2,f3,f6,f12,f13,f14,f20,f21",
                }
            )
            payload = json.loads(self._fetch_text(f"https://push2.eastmoney.com/api/qt/clist/get?{query}"))
            data = payload.get("data", {}) or {}
            total = int(data.get("total") or 0)
            diff = data.get("diff", []) or []
            items: list[dict[str, Any]] = []
            for row in diff:
                code = str(row.get("f12") or "").strip()
                market_id = str(row.get("f13") or "").strip()
                label = str(row.get("f14") or code).strip()
                if not code:
                    continue
                suffix = ".SH" if market_id == "1" else ".SZ"
                symbol = f"{code}{suffix}"
                turnover = self._safe_float(row.get("f6"))
                market_cap = self._safe_float(row.get("f20")) or self._safe_float(row.get("f21"))
                items.append(
                    {
                        "symbol": symbol,
                        "label": label,
                        "kind": "stock",
                        "exchangeId": "eastmoney",
                        "exchangeLabel": "东方财富",
                        "last": self._safe_float(row.get("f2")),
                        "changePct": self._safe_float(row.get("f3")),
                        "turnover": turnover,
                        "turnoverLabel": self._format_turnover(turnover),
                        "marketCap": market_cap,
                        "marketCapLabel": self._format_turnover(market_cap),
                        "sourceOk": True,
                    }
                )
            return {
                "market": "a_share",
                "label": "A股列表",
                "generatedAt": now,
                "total": total,
                "page": normalized_page,
                "pageSize": normalized_page_size,
                "source": {
                    "sourceId": "eastmoney-board",
                    "label": "东方财富全市场列表",
                    "ok": True,
                    "detail": f"已通过东方财富按页拉取 A 股列表，当前返回 {len(items)} 条，共 {total} 条。",
                    "updatedAt": now,
                },
                "items": items,
            }
        except Exception as exc:
            items = [
                {
                    "symbol": item["symbol"],
                    "label": item["label"],
                    "kind": item["kind"],
                    "exchangeId": "eastmoney",
                    "exchangeLabel": "东方财富",
                    "last": 0.0,
                    "changePct": 0.0,
                    "turnover": 0.0,
                    "turnoverLabel": "--",
                    "marketCap": 0.0,
                    "marketCapLabel": "--",
                    "sourceOk": False,
                }
                for item in A_SHARE_SYMBOLS
                if item["kind"] == "stock"
            ]
            return {
                "market": "a_share",
                "label": "A股列表",
                "generatedAt": now,
                "total": len(items),
                "page": normalized_page,
                "pageSize": normalized_page_size,
                "source": {
                    "sourceId": "eastmoney-board",
                    "label": "东方财富全市场列表",
                    "ok": False,
                    "detail": f"{exc}，当前回退到核心股票样本。",
                    "updatedAt": now,
                },
                "items": items,
            }

    def build_series(self, *, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        spec = self._resolve_symbol(symbol)
        candles, source_ok, source_detail, source_meta = self._fetch_a_share_kline(spec, interval, limit)
        snapshot = self._build_snapshot_from_candles(spec["label"], spec["symbol"], candles)
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
                "sourceId": source_meta["sourceId"],
                "label": source_meta["label"],
                "ok": source_ok,
                "detail": source_detail,
                "updatedAt": self.now_ms(),
            },
            "snapshot": snapshot,
            "candles": candles,
        }

    def normalize_interval(self, interval: str) -> str:
        candidate = (interval or "").strip()
        return candidate if candidate in A_SHARE_INTERVALS else A_SHARE_INTERVALS[-1]

    def _resolve_symbol(self, symbol: str) -> dict[str, str]:
        normalized = (symbol or "000001.SH").strip().upper()
        for item in A_SHARE_SYMBOLS:
            if item["symbol"] == normalized:
                return dict(item)
        code = normalized.split(".")[0]
        if normalized.endswith(".SH"):
            secid = f"1.{code}"
        elif normalized.endswith(".SZ"):
            secid = f"0.{code}"
        elif code.startswith(("5", "6", "9")):
            normalized = f"{code}.SH"
            secid = f"1.{code}"
        else:
            normalized = f"{code}.SZ"
            secid = f"0.{code}"
        return {"symbol": normalized, "label": code, "kind": "stock", "secid": secid}

    def _fetch_a_share_kline(self, spec: dict[str, str], interval: str, limit: int) -> tuple[list[dict[str, Any]], bool, str, dict[str, str]]:
        if interval in {"5m", "15m", "30m", "60m"}:
            try:
                candles = self._fetch_sina_intraday_kline(spec, interval, limit)
                if candles:
                    return (
                        candles,
                        True,
                        f"已通过新浪行情拉取 {len(candles)} 根 {interval} K线。",
                        {"sourceId": "sina-kline", "label": "新浪行情 K线"},
                    )
            except Exception as exc:
                fallback_candles, source_ok, source_detail = self._fetch_eastmoney_kline(spec, interval, limit)
                return (
                    fallback_candles,
                    source_ok,
                    f"新浪行情失败：{exc}；{source_detail}",
                    {"sourceId": "eastmoney-kline", "label": "东方财富 K线"},
                )

        if interval in {"1d", "1w"}:
            try:
                candles = self._fetch_tencent_kline(spec, interval, limit)
                if candles:
                    return (
                        candles,
                        True,
                        f"已通过腾讯行情拉取 {len(candles)} 根 {interval} K线。",
                        {"sourceId": "tencent-kline", "label": "腾讯行情 K线"},
                    )
            except Exception as exc:
                fallback_candles, source_ok, source_detail = self._fetch_eastmoney_kline(spec, interval, limit)
                return (
                    fallback_candles,
                    source_ok,
                    f"腾讯行情失败：{exc}；{source_detail}",
                    {"sourceId": "eastmoney-kline", "label": "东方财富 K线"},
                )

        candles, source_ok, source_detail = self._fetch_eastmoney_kline(spec, interval, limit)
        return candles, source_ok, source_detail, {"sourceId": "eastmoney-kline", "label": "东方财富 K线"}

    def _fetch_eastmoney_kline(self, spec: dict[str, str], interval: str, limit: int) -> tuple[list[dict[str, Any]], bool, str]:
        klt = {"5m": "5", "15m": "15", "30m": "30", "60m": "60", "1d": "101", "1w": "102"}.get(interval, "101")
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

    def _fetch_tencent_kline(self, spec: dict[str, str], interval: str, limit: int) -> list[dict[str, Any]]:
        code = spec["symbol"].split(".")[0]
        prefix = "sh" if spec["symbol"].endswith(".SH") else "sz"
        market_symbol = f"{prefix}{code}"
        kline_type = "day" if interval == "1d" else "week"
        query = urllib.parse.urlencode({"param": f"{market_symbol},{kline_type},,,{limit},qfq"})
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?{query}"
        payload = json.loads(self._fetch_text(url))
        data = (payload.get("data") or {}).get(market_symbol) or {}
        rows = data.get(f"qfq{kline_type}") or data.get(kline_type) or []
        candles: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                continue
            candles.append(
                {
                    "ts": self._eastmoney_time_to_ts(str(row[0])),
                    "open": float(row[1]),
                    "close": float(row[2]),
                    "high": float(row[3]),
                    "low": float(row[4]),
                    "volume": float(row[5]),
                }
            )
        if not candles:
            raise RuntimeError("腾讯行情未返回 K 线数据。")
        return candles[-limit:]

    def _fetch_sina_intraday_kline(self, spec: dict[str, str], interval: str, limit: int) -> list[dict[str, Any]]:
        code = spec["symbol"].split(".")[0]
        prefix = "sh" if spec["symbol"].endswith(".SH") else "sz"
        market_symbol = f"{prefix}{code}"
        scale = {"5m": "5", "15m": "15", "30m": "30", "60m": "60"}[interval]
        query = urllib.parse.urlencode({"symbol": market_symbol, "scale": scale, "ma": "no", "datalen": str(limit)})
        url = f"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?{query}"
        raw_text = self._fetch_text(url)
        start = raw_text.find("(")
        end = raw_text.rfind(")")
        if start < 0 or end <= start:
            raise RuntimeError("新浪行情未返回可解析的分钟 K 线。")
        payload = json.loads(raw_text[start + 1 : end])
        candles: list[dict[str, Any]] = []
        for row in payload or []:
            if not isinstance(row, dict):
                continue
            candles.append(
                {
                    "ts": self._eastmoney_time_to_ts(str(row.get("day") or "")),
                    "open": float(row.get("open") or 0),
                    "close": float(row.get("close") or 0),
                    "high": float(row.get("high") or 0),
                    "low": float(row.get("low") or 0),
                    "volume": float(row.get("volume") or 0),
                }
            )
        if not candles:
            raise RuntimeError("新浪行情未返回分钟 K 线数据。")
        return candles[-limit:]

    def _build_snapshot_from_candles(self, label: str, symbol: str, candles: list[dict[str, Any]]) -> dict[str, Any]:
        last = candles[-1]
        recent = candles[-30:] if len(candles) >= 30 else candles
        return {
            "label": label,
            "symbol": symbol,
            "last": last["close"],
            "changePct": self._safe_pct(candles[-1]["close"], candles[-2]["close"]) if len(candles) > 1 else 0.0,
            "high": max(item["high"] for item in recent),
            "low": min(item["low"] for item in recent),
            "volume": last["volume"],
            "quoteVolume": 0,
            "turnoverLabel": self._format_turnover(last["volume"]),
        }

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

    def _fetch_text(self, url: str) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="ignore")

    def _eastmoney_time_to_ts(self, value: str) -> int:
        if len(value.strip()) == 19:
            return int(datetime.strptime(value, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
        if " " in value:
            return int(datetime.strptime(value, "%Y-%m-%d %H:%M").timestamp() * 1000)
        return int(datetime.strptime(value, "%Y-%m-%d").timestamp() * 1000)

    def _interval_to_ms(self, interval: str) -> int:
        mapping = {"5m": 300_000, "15m": 900_000, "30m": 1_800_000, "60m": 3_600_000, "1d": 86_400_000, "1w": 604_800_000}
        return mapping.get(interval, 86_400_000)

    def _safe_pct(self, current: float | int | None, previous: float | int | None) -> float:
        try:
            current_value = float(current or 0)
            previous_value = float(previous or 0)
            if previous_value == 0:
                return 0.0
            return ((current_value / previous_value) - 1) * 100
        except Exception:
            return 0.0

    def _safe_float(self, value: Any) -> float:
        try:
            if value in (None, "", "-"):
                return 0.0
            return float(value)
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


class CryptoMarketProvider:
    def __init__(self, *, now_ms, network_runtime_adapter: Any | None = None) -> None:
        self.now_ms = now_ms
        self.network_runtime_adapter = network_runtime_adapter

    def build_catalog_source(self, *, now_ms: int) -> dict[str, Any]:
        return {
            "sourceId": "crypto-ccxt",
            "label": "CCXT 交易所行情",
            "ok": ccxt is not None,
            "detail": "通过 ccxt 统一接 Binance / OKX / Bybit 公共行情。" if ccxt is not None else "未检测到 ccxt，无法使用加密交易所行情。",
            "updatedAt": now_ms,
        }

    def build_market_catalog(self) -> dict[str, Any]:
        return {
            "market": "crypto",
            "label": "交易所行情",
            "defaultExchangeId": "binance",
            "defaultMarketType": "spot",
            "defaultSymbol": "BTC/USDT",
            "defaultInterval": "4h",
            "intervals": list(CRYPTO_INTERVALS),
            "marketTypes": [
                {"id": "spot", "label": "现货"},
                {"id": "swap", "label": "合约"},
            ],
            "exchanges": [
                {
                    "exchangeId": item["exchangeId"],
                    "label": item["label"],
                    "symbolsByMarketType": {
                        market_type: [{"symbol": symbol, "label": self._symbol_label(symbol)} for symbol in symbols]
                        for market_type, symbols in item["fallbackSymbolsByMarketType"].items()
                    },
                }
                for item in CRYPTO_EXCHANGES
            ],
        }

    def build_market_board(self, *, exchange_id: str, market_type: str) -> dict[str, Any]:
        normalized_exchange = self.normalize_exchange_id(exchange_id)
        normalized_market_type = self.normalize_market_type(market_type)
        exchange_spec = next((item for item in CRYPTO_EXCHANGES if item["exchangeId"] == normalized_exchange), CRYPTO_EXCHANGES[0])
        symbols = exchange_spec["fallbackSymbolsByMarketType"][normalized_market_type]
        now = self.now_ms()
        try:
            exchange = self._create_exchange(normalized_exchange, normalized_market_type)
            exchange.load_markets()
            rows = []
            if getattr(exchange, "has", {}).get("fetchTickers"):
                tickers = exchange.fetch_tickers()
                symbols = self._select_crypto_board_symbols(
                    exchange=exchange,
                    exchange_spec=exchange_spec,
                    tickers=tickers,
                    fallback_symbols=symbols,
                    market_type=normalized_market_type,
                )
                for symbol in symbols:
                    ticker = tickers.get(symbol) or {}
                    turnover = float(ticker.get("quoteVolume") or 0)
                    market_cap = float(ticker.get("info", {}).get("marketCap") or 0) if isinstance(ticker.get("info"), dict) else 0.0
                    rows.append(
                        {
                            "symbol": symbol,
                            "label": self._symbol_label(symbol),
                            "kind": "contract" if normalized_market_type == "swap" else "coin",
                            "exchangeId": normalized_exchange,
                            "exchangeLabel": exchange_spec["label"],
                            "last": float(ticker.get("last") or 0),
                            "changePct": float(ticker.get("percentage") or 0),
                            "turnover": turnover,
                            "turnoverLabel": self._format_turnover(turnover),
                            "marketCap": market_cap,
                            "marketCapLabel": self._format_turnover(market_cap) if market_cap else "--",
                            "sourceOk": True,
                        }
                    )
            else:
                for symbol in symbols:
                    ticker = exchange.fetch_ticker(symbol)
                    turnover = float(ticker.get("quoteVolume") or 0)
                    market_cap = float(ticker.get("info", {}).get("marketCap") or 0) if isinstance(ticker.get("info"), dict) else 0.0
                    rows.append(
                        {
                            "symbol": symbol,
                            "label": self._symbol_label(symbol),
                            "kind": "contract" if normalized_market_type == "swap" else "coin",
                            "exchangeId": normalized_exchange,
                            "exchangeLabel": exchange_spec["label"],
                            "last": float(ticker.get("last") or 0),
                            "changePct": float(ticker.get("percentage") or 0),
                            "turnover": turnover,
                            "turnoverLabel": self._format_turnover(turnover),
                            "marketCap": market_cap,
                            "marketCapLabel": self._format_turnover(market_cap) if market_cap else "--",
                            "sourceOk": True,
                        }
                    )
            return {
                "market": "crypto",
                "marketType": normalized_market_type,
                "label": f"{exchange_spec['label']} {'合约' if normalized_market_type == 'swap' else '现货'}列表",
                "generatedAt": now,
                "source": {
                    "sourceId": f"crypto-board:{normalized_exchange}:{normalized_market_type}",
                    "label": f"{exchange_spec['label']} {'合约' if normalized_market_type == 'swap' else '现货'}列表快照",
                    "ok": True,
                    "detail": f"已拉取 {len(rows)} 个{'合约' if normalized_market_type == 'swap' else '现货币种'}的涨跌幅与成交额。",
                    "updatedAt": now,
                },
                "items": rows,
            }
        except Exception as exc:
            rows = [
                {
                    "symbol": symbol,
                    "label": self._symbol_label(symbol),
                    "kind": "contract" if normalized_market_type == "swap" else "coin",
                    "exchangeId": normalized_exchange,
                    "exchangeLabel": exchange_spec["label"],
                    "last": 0.0,
                    "changePct": 0.0,
                    "turnover": 0.0,
                    "turnoverLabel": "--",
                    "marketCap": 0.0,
                    "marketCapLabel": "--",
                    "sourceOk": False,
                }
                for symbol in symbols
            ]
            return {
                "market": "crypto",
                "marketType": normalized_market_type,
                "label": f"{exchange_spec['label']} {'合约' if normalized_market_type == 'swap' else '现货'}列表",
                "generatedAt": now,
                "source": {
                    "sourceId": f"crypto-board:{normalized_exchange}:{normalized_market_type}",
                    "label": f"{exchange_spec['label']} {'合约' if normalized_market_type == 'swap' else '现货'}列表快照",
                    "ok": False,
                    "detail": f"{exc}，当前回退到核心{'合约' if normalized_market_type == 'swap' else '现货'}样本。",
                    "updatedAt": now,
                },
                "items": rows,
            }

    def build_series(self, *, exchange_id: str, symbol: str, interval: str, limit: int, market_type: str) -> dict[str, Any]:
        normalized_market_type = self.normalize_market_type(market_type)
        exchange = self._create_exchange(exchange_id, normalized_market_type)
        try:
            exchange.load_markets()
            ticker = exchange.fetch_ticker(symbol)
            raw_candles = exchange.fetch_ohlcv(symbol, timeframe=interval, limit=limit)
            source_ok = True
            source_detail = f"已通过 {exchange_id} {('合约' if normalized_market_type == 'swap' else '现货')} 拉取 {len(raw_candles)} 根 {interval} K线。"
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
            {"ts": int(item[0]), "open": float(item[1]), "high": float(item[2]), "low": float(item[3]), "close": float(item[4]), "volume": float(item[5])}
            for item in raw_candles
        ]
        return {
            "generatedAt": self.now_ms(),
            "market": "crypto",
            "marketType": normalized_market_type,
            "label": "交易所行情",
            "exchangeId": exchange_id,
            "exchangeLabel": exchange_id.upper(),
            "symbol": symbol,
            "symbolLabel": self._symbol_label(symbol),
            "interval": interval,
            "source": {
                "sourceId": f"ccxt-{exchange_id}:{normalized_market_type}",
                "label": f"{exchange_id.upper()} / {'合约' if normalized_market_type == 'swap' else '现货'} / ccxt",
                "ok": source_ok,
                "detail": source_detail,
                "updatedAt": self.now_ms(),
            },
            "snapshot": {
                "label": self._symbol_label(symbol),
                "symbol": symbol,
                "last": float(ticker.get("last") or candles[-1]["close"]),
                "changePct": float(ticker.get("percentage") or 0),
                "high": float(ticker.get("high") or max(item["high"] for item in candles[-30:])),
                "low": float(ticker.get("low") or min(item["low"] for item in candles[-30:])),
                "volume": float(ticker.get("baseVolume") or 0),
                "quoteVolume": float(ticker.get("quoteVolume") or 0),
                "turnoverLabel": self._format_turnover(float(ticker.get("quoteVolume") or 0)),
            },
            "candles": candles,
        }

    def normalize_interval(self, interval: str) -> str:
        candidate = (interval or "").strip()
        return candidate if candidate in CRYPTO_INTERVALS else CRYPTO_INTERVALS[-1]

    def normalize_exchange_id(self, exchange_id: str | None) -> str:
        candidate = (exchange_id or "binance").strip().lower()
        supported = {item["exchangeId"] for item in CRYPTO_EXCHANGES}
        return candidate if candidate in supported else "binance"

    def normalize_market_type(self, market_type: str | None) -> str:
        candidate = (market_type or "spot").strip().lower()
        return candidate if candidate in CRYPTO_MARKET_TYPES else "spot"

    def _create_exchange(self, exchange_id: str, market_type: str):
        if ccxt is None:
            raise RuntimeError("ccxt is not available.")
        exchange_class = getattr(ccxt, exchange_id, None)
        if exchange_class is None:
            raise RuntimeError(f"Unsupported exchange: {exchange_id}")
        exchange = exchange_class(
            {
                "enableRateLimit": True,
                "options": {
                    "defaultType": "swap" if market_type == "swap" else "spot",
                },
            }
        )
        proxy_environment = self._get_proxy_environment(exchange_id)
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

    def _select_crypto_board_symbols(
        self,
        *,
        exchange,
        exchange_spec: dict[str, Any],
        tickers: dict[str, Any],
        fallback_symbols: tuple[str, ...],
        market_type: str,
    ) -> list[str]:
        markets = getattr(exchange, "markets", {}) or {}
        candidates: list[tuple[str, float, float]] = []
        for symbol, ticker in tickers.items():
            market = markets.get(symbol) or {}
            if not self._is_supported_crypto_market(market, market_type):
                continue
            if self._is_excluded_crypto_symbol(symbol=symbol, exchange_spec=exchange_spec, market_type=market_type):
                continue
            quote_volume = self._safe_float(ticker.get("quoteVolume"))
            last = self._safe_float(ticker.get("last"))
            if quote_volume <= 0 and last <= 0:
                continue
            candidates.append((symbol, quote_volume, abs(self._safe_float(ticker.get("percentage")))))
        candidates.sort(key=lambda item: (item[1], item[2], item[0]), reverse=True)
        symbols = [item[0] for item in candidates[:CRYPTO_BOARD_MAX_ITEMS]]
        return symbols or list(fallback_symbols)

    def _is_supported_crypto_market(self, market: dict[str, Any], market_type: str) -> bool:
        quote = str(market.get("quote") or "").upper()
        settle = str(market.get("settle") or "").upper()
        status = str((market.get("info") or {}).get("status") or "").upper()
        active = market.get("active")
        if active is False:
            return False
        if status and status not in {"TRADING", "TRADING_HALTED", "ONLINE", "LIVE"}:
            return False
        if market_type == "spot":
            return bool(market.get("spot")) and quote == "USDT"
        return bool(market.get("swap") or market.get("contract")) and (settle == "USDT" or quote == "USDT")

    def _is_excluded_crypto_symbol(self, *, symbol: str, exchange_spec: dict[str, Any], market_type: str) -> bool:
        excluded = exchange_spec.get("excludedSymbolsByMarketType", {}).get(market_type, ())
        return symbol in excluded

    def _safe_float(self, value: Any) -> float:
        try:
            if value in (None, "", "-"):
                return 0.0
            return float(value)
        except Exception:
            return 0.0

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

    def _interval_to_ms(self, interval: str) -> int:
        mapping = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
        return mapping.get(interval, 86_400_000)

    def _format_turnover(self, value: float) -> str:
        absolute = abs(value)
        if absolute >= 1_000_000_000:
            return f"{value / 1_000_000_000:.2f}B"
        if absolute >= 1_000_000:
            return f"{value / 1_000_000:.2f}M"
        if absolute >= 1_000:
            return f"{value / 1_000:.2f}K"
        return f"{value:.2f}"

    def _symbol_label(self, symbol: str) -> str:
        normalized = symbol.replace(":USDT", "")
        return normalized.replace("/USDT", "")
