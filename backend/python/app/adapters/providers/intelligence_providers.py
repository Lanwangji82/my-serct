from __future__ import annotations

import json
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Callable

from .data_provider_store import get_data_provider_settings, request_tushare_api


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuantX/0.1"
DEFAULT_TIMEOUT = 12

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


@dataclass(frozen=True)
class FeedStatus:
    source_id: str
    label: str
    ok: bool
    detail: str
    updated_at: int


class AShareIntelligenceProvider:
    def __init__(self, *, now_ms: Callable[[], int]) -> None:
        self.now_ms = now_ms

    def fetch_market_data(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], FeedStatus]:
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
                return self._fetch_fallback(f"Tushare 回退：{exc}")
        return self._fetch_fallback()

    def fetch_sector_pulse(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=1.510300,0.159915,1.512480,0.159928"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            pulse = []
            for index, item in enumerate(diff[: len(A_SHARE_ETF_SPECS)]):
                spec = A_SHARE_ETF_SPECS[index]
                change_pct = float(item.get("f3") or 0)
                pulse.append(
                    {
                        "symbol": spec["symbol"],
                        "label": spec["label"],
                        "changePct": change_pct,
                        "signal": "领涨" if change_pct >= 1 else ("承接" if change_pct >= 0 else "降温"),
                        "reason": "用 ETF 快速感知板块宽度与风格轮动。",
                    }
                )
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

    def fetch_theme_pulse(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        secids = ",".join(spec["secid"] for spec in A_SHARE_THEME_PULSE_SPECS)
        url = f"https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids={secids}"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            rows = []
            for index, item in enumerate(diff[: len(A_SHARE_THEME_PULSE_SPECS)]):
                spec = A_SHARE_THEME_PULSE_SPECS[index]
                change_pct = float(item.get("f3") or 0)
                rows.append(
                    {
                        "symbol": spec["symbol"],
                        "label": spec["label"],
                        "changePct": change_pct,
                        "signal": "加速" if change_pct >= 1.5 else ("承接" if change_pct >= 0 else "降温"),
                        "reason": spec["summary"],
                    }
                )
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

    def _fetch_fallback(self, error_detail: str | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], FeedStatus]:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=1.000001,0.399001,0.399006,1.000300"
        try:
            payload = json.loads(self._fetch_text(url))
            diff = payload.get("data", {}).get("diff", [])
            indices = [
                {
                    "symbol": str(item.get("f12") or ""),
                    "label": str(item.get("f14") or "A股指数"),
                    "last": float(item.get("f2") or 0),
                    "changePct": float(item.get("f3") or 0),
                    "commentary": "指数偏强，风险偏好回暖。" if float(item.get("f3") or 0) >= 0 else "指数承压，短线情绪偏谨慎。",
                    "trend": [],
                    "trendLabel": "实时快照",
                }
                for item in diff
            ]
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

    def _latest_trade_date(self) -> str:
        today = datetime.now().strftime("%Y%m%d")
        payload = request_tushare_api(
            "trade_cal",
            params={"exchange": "SSE", "start_date": "20250101", "end_date": today, "is_open": "1"},
            fields="exchange,cal_date,is_open",
        )
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
            rows.append(
                {
                    "symbol": spec["symbol"],
                    "label": spec["label"],
                    "last": self._field_float(latest, index, "close"),
                    "changePct": pct,
                    "commentary": "近期结构偏强。" if pct >= 0 else "短线回撤仍需观察。",
                    "trend": [self._field_float(item, index, "close") for item in reversed(items[:10]) if self._field_float(item, index, "close") > 0],
                    "trendLabel": "近10日趋势",
                }
            )
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
            rows.append(
                {
                    "symbol": spec["symbol"],
                    "label": spec["label"],
                    "signal": "顺势跟踪" if pct >= 2 else ("观察修复" if pct >= 0 else "等待企稳"),
                    "reason": "用来补足指数之外的风格主线观察。",
                    "changePct": pct,
                    "price": self._field_float(latest, index, "close"),
                }
            )
        rows.sort(key=lambda item: abs(item["changePct"]), reverse=True)
        return rows[:4]

    def _field_float(self, item: list[Any], field_index: dict[str, int], field: str) -> float:
        return float(item[field_index[field]] or 0) if field in field_index else 0.0

    def _fetch_text(self, url: str) -> str:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode("utf-8", errors="ignore")


class CryptoIntelligenceProvider:
    def __init__(self, *, now_ms: Callable[[], int]) -> None:
        self.now_ms = now_ms

    def fetch_assets(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        url = "https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22,%22BNBUSDT%22%5D"
        try:
            payload = json.loads(self._fetch_text(url))
            trend_map = self._fetch_trends()
            rows = []
            for item in payload:
                symbol = str(item.get("symbol") or "")
                pct = float(item.get("priceChangePercent") or 0)
                rows.append(
                    {
                        "symbol": symbol,
                        "label": symbol.replace("USDT", ""),
                        "last": float(item.get("lastPrice") or 0),
                        "changePct": pct,
                        "quoteVolume": float(item.get("quoteVolume") or 0),
                        "commentary": "价格与成交额同步走强。" if pct >= 0 else "回撤阶段更需要观察支撑位。",
                        "trend": trend_map.get(symbol, []),
                        "trendLabel": "近12根4h",
                    }
                )
            return rows, FeedStatus("binance-24h", "Binance 24h 行情", True, f"已拉取 {len(rows)} 个主流币", self.now_ms())
        except Exception as exc:
            fallback = [
                {"symbol": "BTCUSDT", "label": "BTC", "last": 66764.2, "changePct": 0.84, "quoteVolume": 1_200_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "ETHUSDT", "label": "ETH", "last": 3482.15, "changePct": 1.18, "quoteVolume": 730_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "SOLUSDT", "label": "SOL", "last": 181.34, "changePct": -0.42, "quoteVolume": 410_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
                {"symbol": "BNBUSDT", "label": "BNB", "last": 612.58, "changePct": 0.27, "quoteVolume": 360_000_000, "commentary": "使用缓存样本。", "trend": [], "trendLabel": "样本"},
            ]
            return fallback, FeedStatus("binance-24h", "Binance 24h 行情", False, str(exc), self.now_ms())

    def fetch_event_feed(self) -> tuple[list[dict[str, Any]], FeedStatus]:
        now = self.now_ms()
        try:
            rows = []
            status_payload = json.loads(self._fetch_text("https://api.binance.com/sapi/v1/system/status"))
            rows.append(
                {
                    "id": "binance-system-status",
                    "exchange": "Binance",
                    "title": "系统状态",
                    "summary": str(status_payload.get("msg") or "system status"),
                    "severity": "normal" if int(status_payload.get("status", 1)) == 0 else "attention",
                    "publishedAt": now,
                }
            )
            try:
                root = ET.fromstring(self._fetch_text("https://www.binance.com/en/support/announcement/rss"))
                for item in root.findall(".//item")[:3]:
                    rows.append(
                        {
                            "id": f"binance-ann-{abs(hash(item.findtext('link', default='')))}",
                            "exchange": "Binance",
                            "title": item.findtext("title", default="公告").strip(),
                            "summary": "来自 Binance 公告流。",
                            "severity": "normal",
                            "publishedAt": self._parse_pub_date(item.findtext("pubDate", default="")),
                        }
                    )
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

    def _fetch_trends(self) -> dict[str, list[float]]:
        trends: dict[str, list[float]] = {}
        for spec in CRYPTO_SPECS:
            try:
                payload = json.loads(self._fetch_text(f"https://api.binance.com/api/v3/klines?symbol={spec['symbol']}&interval=4h&limit=12"))
                trends[spec["symbol"]] = [float(item[4]) for item in payload if len(item) >= 5]
            except Exception:
                trends[spec["symbol"]] = []
        return trends

    def _parse_pub_date(self, value: str) -> int:
        if not value:
            return self.now_ms()
        try:
            return int(parsedate_to_datetime(value).timestamp() * 1000)
        except Exception:
            return self.now_ms()

    def _fetch_text(self, url: str) -> str:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=DEFAULT_TIMEOUT) as response:
            return response.read().decode("utf-8", errors="ignore")
