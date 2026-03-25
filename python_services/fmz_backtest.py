from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import tempfile
import time
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode


@dataclass
class BacktestConfig:
    strategy_id: str
    broker_target: str
    symbol: str
    market_type: str
    period: str
    base_period: str
    start_time: str | None
    end_time: str | None
    mode: str
    initial_capital: float
    quote_asset: str
    tolerance_pct: float
    open_fee_pct: float
    close_fee_pct: float
    slippage_points: float
    candle_limit: int
    chart_display: str
    depth_min: int
    depth_max: int
    record_events: bool
    leverage: float
    chart_bars: int
    delay_ms: int
    log_limit: int
    profit_limit: int
    data_source: str
    order_mode: str
    distributor: str


def build_result_params(config: BacktestConfig) -> dict[str, Any]:
    return {
        "strategyId": config.strategy_id,
        "brokerTarget": config.broker_target,
        "symbol": config.symbol,
        "marketType": config.market_type,
        "startTime": config.start_time,
        "endTime": config.end_time,
        "period": config.period,
        "basePeriod": config.base_period,
        "mode": config.mode,
        "initialCapital": config.initial_capital,
        "quoteAsset": config.quote_asset,
        "tolerancePct": config.tolerance_pct,
        "openFeePct": config.open_fee_pct,
        "closeFeePct": config.close_fee_pct,
        "slippagePoints": config.slippage_points,
        "candleLimit": config.candle_limit,
        "chartDisplay": config.chart_display,
        "depthMin": config.depth_min,
        "depthMax": config.depth_max,
        "recordEvents": config.record_events,
        "leverage": config.leverage,
        "chartBars": config.chart_bars,
        "delayMs": config.delay_ms,
        "logLimit": config.log_limit,
        "profitLimit": config.profit_limit,
        "dataSource": config.data_source,
        "orderMode": config.order_mode,
        "distributor": config.distributor,
    }


def build_engine_options(config: BacktestConfig) -> dict[str, Any]:
    return {
        "BrokerTarget": config.broker_target,
        "Symbol": config.symbol,
        "MarketType": config.market_type,
        "Period": config.period,
        "BasePeriod": config.base_period,
        "StartTime": config.start_time,
        "EndTime": config.end_time,
        "Mode": config.mode,
        "QuoteAsset": config.quote_asset,
        "TolerancePct": config.tolerance_pct,
        "CandleLimit": config.candle_limit,
        "ChartDisplay": config.chart_display,
        "DepthMin": config.depth_min,
        "DepthMax": config.depth_max,
        "RecordEvents": config.record_events,
        "DataSource": config.data_source,
        "OrderMode": config.order_mode,
        "Distributor": config.distributor,
        "MarginLevel": config.leverage,
    }


def load_fmz_module():
    external_root = Path(__file__).resolve().parent.parent / "external" / "backtest_python"
    if not external_root.exists():
        raise RuntimeError("未找到 FMZ 官方本地回测引擎，请先拉取 external/backtest_python")
    external_root_str = str(external_root)
    if external_root_str not in sys.path:
        sys.path.insert(0, external_root_str)
    import fmz  # type: ignore

    return fmz


def split_strategy_source(source_code: str) -> tuple[str, str]:
    match = re.search(r"'''backtest(.*?)'''", source_code, re.S)
    if not match:
        raise RuntimeError("FMZ 策略源码缺少 '''backtest ... ''' 配置块")
    code_block = source_code[match.end() :].strip()
    if not code_block:
        raise RuntimeError("FMZ 策略源码缺少可执行代码")
    return match.group(1).strip(), code_block


def map_exchange_id(broker_target: str, market_type: str) -> str:
    if broker_target.startswith("binance:"):
        return "Futures_Binance" if market_type == "futures" else "Binance"
    if broker_target.startswith("okx:"):
        return "Futures_OKX" if market_type == "futures" else "OKX"
    raise RuntimeError(f"不支持的交易所目标：{broker_target}")


def to_fmz_symbol(symbol: str) -> str:
    compact = symbol.upper().replace("/", "").replace("-", "")
    if compact.endswith("USDT") and len(compact) > 4:
        return f"{compact[:-4]}_USDT"
    return compact


def build_backtest_header(config: BacktestConfig) -> str:
    exchange = {
        "eid": map_exchange_id(config.broker_target, config.market_type),
        "currency": to_fmz_symbol(config.symbol),
        "balance": float(config.initial_capital),
        "fee": [float(config.open_fee_pct), float(config.close_fee_pct)],
    }
    return "\n".join(
        [
            "'''backtest",
            f"start: {config.start_time or '2026-01-01 00:00:00'}",
            f"end: {config.end_time or '2026-03-21 08:00:00'}",
            f"period: {config.period}",
            f"basePeriod: {config.base_period}",
            "pnl: true",
            f"slippage: {config.slippage_points}",
            f"netDelay: {config.delay_ms}",
            f"exchanges: [{json.dumps(exchange, ensure_ascii=False)}]",
            "'''",
        ]
    )


def build_task(source_code: str, config: BacktestConfig, fmz: Any) -> tuple[dict[str, Any], str]:
    _, code = split_strategy_source(source_code)
    task = fmz.parseTask(build_backtest_header(config))
    if task.get("Exchanges"):
        exchange = task["Exchanges"][0]
        exchange["Balance"] = float(config.initial_capital)
        exchange["FeeMaker"] = int(float(config.open_fee_pct) * 10000)
        exchange["FeeTaker"] = int(float(config.close_fee_pct) * 10000)
        exchange["MarginLevel"] = float(config.leverage)
    if task.get("Options"):
        task["Options"]["MaxChartLogs"] = int(config.chart_bars)
        task["Options"]["MaxProfitLogs"] = int(config.profit_limit)
        task["Options"]["MaxRuntimeLogs"] = int(config.log_limit)
        task["Options"]["NetDelay"] = int(config.delay_ms)
        task["Options"]["Mode"] = config.mode
        task["Options"]["QuoteAsset"] = config.quote_asset
        task["Options"]["TolerancePct"] = float(config.tolerance_pct)
        task["Options"]["CandleLimit"] = int(config.candle_limit)
        task["Options"]["ChartDisplay"] = config.chart_display
        task["Options"]["DepthMin"] = int(config.depth_min)
        task["Options"]["DepthMax"] = int(config.depth_max)
        task["Options"]["RecordEvents"] = bool(config.record_events)
        task["Options"]["DataSource"] = config.data_source
        task["Options"]["OrderMode"] = config.order_mode
        task["Options"]["Distributor"] = config.distributor
    task["Code"] = [(code, [])]
    return task, code


def extract_latest_account(raw_result: dict[str, Any]) -> dict[str, Any] | None:
    snapshots = raw_result.get("Snapshots") or []
    if not snapshots:
        return None
    last = snapshots[-1]
    if not isinstance(last, list) or len(last) < 2 or not last[1]:
        return None
    return last[1][0]


def build_equity_curve(raw_result: dict[str, Any], initial_capital: float) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for snapshot in raw_result.get("Snapshots") or []:
        if not snapshot[1]:
            continue
        account = snapshot[1][0]
        equity = float(initial_capital) + float(account.get("PnL") or 0)
        points.append({"time": int(snapshot[0]), "equity": round(equity, 6)})
    return points


def compute_metrics(equity_curve: list[dict[str, Any]]) -> dict[str, float]:
    if not equity_curve:
        return {"totalReturnPct": 0.0, "maxDrawdownPct": 0.0, "sharpe": 0.0, "endingEquity": 0.0, "winRatePct": 0.0, "trades": 0}

    starting_equity = equity_curve[0]["equity"]
    ending_equity = equity_curve[-1]["equity"]
    total_return_pct = ((ending_equity / starting_equity) - 1) * 100 if starting_equity else 0.0

    peak = equity_curve[0]["equity"]
    max_drawdown_pct = 0.0
    returns: list[float] = []
    previous = equity_curve[0]["equity"]
    for point in equity_curve[1:]:
        equity = point["equity"]
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown_pct = max(max_drawdown_pct, ((peak - equity) / peak) * 100)
        if previous > 0:
            returns.append((equity - previous) / previous)
        previous = equity

    if len(returns) > 1:
        mean_return = sum(returns) / len(returns)
        variance = sum((item - mean_return) ** 2 for item in returns) / (len(returns) - 1)
        sharpe = 0.0 if variance <= 0 else (mean_return / math.sqrt(variance)) * math.sqrt(252)
    else:
        sharpe = 0.0

    return {
        "totalReturnPct": round(total_return_pct, 4),
        "maxDrawdownPct": round(max_drawdown_pct, 4),
        "sharpe": round(sharpe, 4),
        "endingEquity": round(ending_equity, 4),
        "winRatePct": 0.0,
        "trades": 0,
    }


def build_asset_rows(raw_result: dict[str, Any], initial_capital: float) -> list[dict[str, Any]]:
    account = extract_latest_account(raw_result)
    if not account:
        return []

    quote_currency = account.get("MarginCurrency") or account.get("QuoteCurrency") or "USDT"
    quote_asset = next((asset for asset in account.get("Assets", []) if asset.get("Currency") == quote_currency), {})
    symbols = account.get("Symbols") or {}

    close_profit = 0.0
    open_profit = 0.0
    margin = 0.0
    trade_count = 0
    for symbol_data in symbols.values():
        if "Long" in symbol_data:
            long_data = symbol_data["Long"]
            close_profit += float(long_data.get("CloseProfit") or 0)
            open_profit += float(long_data.get("Profit") or 0)
            margin += float(long_data.get("Margin") or 0)
        if "Short" in symbol_data:
            short_data = symbol_data["Short"]
            close_profit += float(short_data.get("CloseProfit") or 0)
            open_profit += float(short_data.get("Profit") or 0)
            margin += float(short_data.get("Margin") or 0)
        trade_status = symbol_data.get("TradeStatus") or {}
        trade_count += int(trade_status.get("BuyOrderCount") or 0)
        trade_count += int(trade_status.get("SellOrderCount") or 0)

    pnl = float(account.get("PnL") or 0)
    balance = float(quote_asset.get("Amount") or 0)
    frozen = float(quote_asset.get("FrozenAmount") or 0)
    fees = float(quote_asset.get("Commission") or 0)
    funding = float(quote_asset.get("Funding") or 0)

    return [
        {
            "name": account.get("Id") or "FMZ",
            "asset": quote_currency,
            "balance": round(balance, 6),
            "frozen": round(frozen, 6),
            "fees": round(fees, 6),
            "equity": round(funding, 6),
            "realizedPnl": round(close_profit, 6),
            "positionPnl": round(open_profit, 6),
            "margin": round(margin, 6),
            "estimatedProfit": round(pnl, 6),
            "tradeCount": trade_count,
        }
    ]


def build_runtime_logs(raw_result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_result.get("RuntimeLogs") or []:
        if not isinstance(item, list) or len(item) < 2:
            continue
        message = ""
        if len(item) >= 8 and item[7]:
            message = str(item[7])
        elif len(item) >= 10 and item[9]:
            symbol = item[8] if len(item) > 8 else ""
            message = f"{item[9]} {symbol} qty={item[6]}"
        else:
            message = json.dumps(item, ensure_ascii=False)
        rows.append({"time": int(item[1]), "level": "runtime", "message": message})
    return rows


def build_funding_logs(raw_result: dict[str, Any], config: BacktestConfig) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    previous_funding: float | None = None
    for item in raw_result.get("Snapshots") or []:
        if not isinstance(item, list) or len(item) < 2 or not item[1]:
            continue
        timestamp = int(item[0])
        account = item[1][0]
        assets = account.get("Assets") or []
        quote_currency = account.get("MarginCurrency") or account.get("QuoteCurrency") or config.quote_asset
        quote_asset = next((asset for asset in assets if asset.get("Currency") == quote_currency), {})
        funding_total = float(quote_asset.get("Funding") or 0)
        if previous_funding is None:
            previous_funding = funding_total
            continue
        funding_delta = funding_total - previous_funding
        previous_funding = funding_total
        if abs(funding_delta) < 1e-9:
            continue

        symbols = account.get("Symbols") or {}
        symbol_data = next(iter(symbols.values()), {})
        long_data = symbol_data.get("Long") or {}
        short_data = symbol_data.get("Short") or {}
        long_amount = float(long_data.get("Amount") or 0)
        short_amount = float(short_data.get("Amount") or 0)
        position = long_amount if abs(long_amount) > 0 else -short_amount
        last_price = float(symbol_data.get("Last") or 0)
        account_id = account.get("Id") or "FMZ"

        rows.append(
            {
                "time": timestamp,
                "level": "event",
                "message": f"[Event] {account_id} position {round(position, 6)} funding {round(funding_delta, 9)}, indexPrice: {round(last_price, 4)} fairPrice: {round(last_price, 4)}",
            }
        )
    return rows


def parse_period_to_ms(period: str | None) -> int:
    match = re.match(r"^\s*(\d+)\s*([mhd])\s*$", str(period or ""), re.I)
    if not match:
        return 60 * 60 * 1000
    value = max(1, int(match.group(1)))
    unit = match.group(2).lower()
    if unit == "m":
        return value * 60 * 1000
    if unit == "d":
        return value * 24 * 60 * 60 * 1000
    return value * 60 * 60 * 1000


def decimal_places(value: Any) -> int:
    text = str(value or "").strip()
    if not text or text in {"0", "0.0"}:
        return 0
    if "e-" in text.lower():
        try:
            return max(0, int(text.lower().split("e-")[1]))
        except (IndexError, ValueError):
            return 0
    if "." not in text:
        return 0
    return len(text.rstrip("0").split(".", 1)[1])


def build_history_query(config: BacktestConfig, period_ms: int) -> tuple[str, dict[str, Any]]:
    fmz = load_fmz_module()
    task = fmz.parseTask(build_backtest_header(config))
    exchange = (task.get("Exchanges") or [{}])[0]
    options = task.get("Options") or {}
    history_symbol = to_fmz_symbol(config.symbol)
    if config.market_type == "futures" and not history_symbol.endswith(".swap"):
        history_symbol = f"{history_symbol}.swap"
    start_sec = 0
    end_sec = 0
    if config.start_time:
        try:
            start_sec = int(datetime.strptime(config.start_time, "%Y-%m-%d %H:%M:%S").timestamp())
        except ValueError:
            start_sec = 0
    if config.end_time:
        try:
            end_sec = int(datetime.strptime(config.end_time, "%Y-%m-%d %H:%M:%S").timestamp())
        except ValueError:
            end_sec = 0
    params = {
        "detail": "true",
        "round": "true",
        "feeder": "local",
        "event": "feed",
        "symbol": history_symbol,
        "eid": exchange.get("Id"),
        "depth": max(int(config.depth_min or 0), 1),
        "trades": 0,
        "custom": 0,
        "period": int(period_ms),
        "from": start_sec,
        "to": end_sec,
    }
    data_server = str(options.get("DataServer") or getattr(fmz, "DATASERVER", "http://q.fmz.com")).rstrip("/")
    return f"{data_server}/data/history?{urlencode(params)}", params


def normalize_history_rows(payload: dict[str, Any], start_ms: int, end_ms: int) -> list[dict[str, Any]]:
    detail = payload.get("detail") or {}
    schema = [str(item).lower() for item in (payload.get("schema") or [])]
    rows = payload.get("data") or []
    if not schema or not rows:
        return []

    field_index = {name: index for index, name in enumerate(schema)}
    price_scale = 10 ** max(int(detail.get("quotePrecision") or 0), decimal_places(detail.get("priceTick")))
    volume_scale = 10 ** max(int(detail.get("basePrecision") or 0), decimal_places(detail.get("volumeTick")))
    open_interest_scale = 10 ** decimal_places(detail.get("openInterestTick"))

    normalized: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, list) or not item:
            continue
        timestamp = int(item[field_index["time"]]) if "time" in field_index else 0
        if not timestamp:
            continue
        if start_ms and timestamp < start_ms:
            continue
        if end_ms and timestamp > end_ms:
            continue

        def get_scaled(name: str, scale: int) -> float:
            if name not in field_index:
                return 0.0
            raw = float(item[field_index[name]] or 0)
            return round(raw / scale, 6) if scale > 1 else round(raw, 6)

        normalized.append(
            {
                "time": timestamp,
                "open": get_scaled("open", price_scale),
                "high": get_scaled("high", price_scale),
                "low": get_scaled("low", price_scale),
                "close": get_scaled("close", price_scale),
                "volume": get_scaled("vol", volume_scale),
                "openInterest": get_scaled("openinterest", open_interest_scale),
            }
        )
    return normalized


def fetch_ohlcv_rows(config: BacktestConfig) -> list[dict[str, Any]]:
    period_ms = parse_period_to_ms(config.period)
    start_ms = 0
    target_end_ms = 0
    if config.start_time:
        try:
            start_ms = int(datetime.strptime(config.start_time, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
        except ValueError:
            start_ms = 0
    if config.end_time:
        try:
            target_end_ms = int(datetime.strptime(config.end_time, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
        except ValueError:
            target_end_ms = 0
    try:
        fmz = load_fmz_module()
        url, _ = build_history_query(config, period_ms)
        payload = json.loads(fmz.httpGet(url).decode("utf-8"))
        return normalize_history_rows(payload, start_ms, target_end_ms)
    except Exception:
        return []


def build_snapshot_timeline(raw_result: dict[str, Any], initial_capital: float) -> tuple[list[int], list[dict[str, float]]]:
    snapshot_times: list[int] = []
    snapshot_states: list[dict[str, float]] = []
    for item in raw_result.get("Snapshots") or []:
        if not isinstance(item, list) or len(item) < 2 or not item[1]:
            continue
        timestamp = int(item[0])
        account = item[1][0]
        symbols = account.get("Symbols") or {}
        symbol_data = next(iter(symbols.values()), {})
        long_data = symbol_data.get("Long") or {}
        short_data = symbol_data.get("Short") or {}
        pnl = float(account.get("PnL") or 0)
        snapshot_times.append(timestamp)
        snapshot_states.append(
            {
                "last_price": round(float(symbol_data.get("Last") or 0), 6),
                "equity": round(float(initial_capital) + pnl, 6),
                "utilization": round(float(account.get("Utilization") or 0), 6),
                "long_amount": round(float(long_data.get("Amount") or 0), 6),
                "long_price": round(float(long_data.get("Price") or 0), 6),
                "long_profit": round(float(long_data.get("Profit") or 0), 6),
                "long_close_profit": round(float(long_data.get("CloseProfit") or 0), 6),
                "short_amount": round(float(short_data.get("Amount") or 0), 6),
                "short_price": round(float(short_data.get("Price") or 0), 6),
                "short_profit": round(float(short_data.get("Profit") or 0), 6),
                "short_close_profit": round(float(short_data.get("CloseProfit") or 0), 6),
            }
        )
    return snapshot_times, snapshot_states


def lookup_snapshot_state(snapshot_times: list[int], snapshot_states: list[dict[str, float]], timestamp: int, *, prefer_next: bool = False) -> dict[str, float]:
    if not snapshot_times:
        return {}
    index = bisect_left(snapshot_times, timestamp)
    if prefer_next:
        if index >= len(snapshot_times):
            index = len(snapshot_times) - 1
    else:
        index -= 1
        if index < 0:
            index = 0
    return snapshot_states[index]


def build_market_rows(raw_result: dict[str, Any], initial_capital: float, ohlcv_rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    snapshot_times, snapshot_states = build_snapshot_timeline(raw_result, initial_capital)
    if ohlcv_rows:
        rows: list[dict[str, Any]] = []
        for item in ohlcv_rows:
            state = lookup_snapshot_state(snapshot_times, snapshot_states, int(item["time"]))
            rows.append(
                {
                    "time": int(item["time"]),
                    "open": float(item["open"]),
                    "high": float(item["high"]),
                    "low": float(item["low"]),
                    "close": float(item["close"]),
                    "volume": float(item["volume"]),
                    "openInterest": float(item.get("openInterest") or 0),
                    "lastPrice": float(item["close"]),
                    "equity": float(state.get("equity", initial_capital)),
                    "utilization": float(state.get("utilization", 0)),
                    "longAmount": float(state.get("long_amount", 0)),
                    "longPrice": float(state.get("long_price", 0)),
                    "longProfit": float(state.get("long_profit", 0)),
                    "shortAmount": float(state.get("short_amount", 0)),
                    "shortPrice": float(state.get("short_price", 0)),
                    "shortProfit": float(state.get("short_profit", 0)),
                }
            )
        return rows

    rows: list[dict[str, Any]] = []
    for item in raw_result.get("Snapshots") or []:
        if not isinstance(item, list) or len(item) < 2 or not item[1]:
            continue
        timestamp = int(item[0])
        account = item[1][0]
        symbols = account.get("Symbols") or {}
        symbol_data = next(iter(symbols.values()), {})
        long_data = symbol_data.get("Long") or {}
        short_data = symbol_data.get("Short") or {}
        pnl = float(account.get("PnL") or 0)
        rows.append(
            {
                "time": timestamp,
                "lastPrice": round(float(symbol_data.get("Last") or 0), 6),
                "equity": round(float(initial_capital) + pnl, 6),
                "utilization": round(float(account.get("Utilization") or 0), 6),
                "longAmount": round(float(long_data.get("Amount") or 0), 6),
                "longPrice": round(float(long_data.get("Price") or 0), 6),
                "longProfit": round(float(long_data.get("Profit") or 0), 6),
                "shortAmount": round(float(short_data.get("Amount") or 0), 6),
                "shortPrice": round(float(short_data.get("Price") or 0), 6),
                "shortProfit": round(float(short_data.get("Profit") or 0), 6),
            }
        )
    return rows


def build_trade_rows(raw_result: dict[str, Any], config: BacktestConfig) -> list[dict[str, Any]]:
    runtime_logs = raw_result.get("RuntimeLogs") or []
    message_by_time: dict[int, list[str]] = {}
    for item in runtime_logs:
        if not isinstance(item, list) or len(item) < 8:
            continue
        message = str(item[7] or "").strip()
        if message:
            message_by_time.setdefault(int(item[1]), []).append(message)
    snapshot_times, snapshot_states = build_snapshot_timeline(raw_result, config.initial_capital)

    def extract_price_and_qty(timestamp: int, fallback_qty: float) -> tuple[float, float]:
        messages = message_by_time.get(timestamp, [])
        for message in messages:
            numbers = re.findall(r"-?\d+(?:\.\d+)?", message)
            if len(numbers) >= 2:
                price = float(numbers[-2])
                qty = float(numbers[-1])
                return price, qty
        return 0.0, fallback_qty

    rows: list[dict[str, Any]] = []
    long_entry: dict[str, float] | None = None
    short_entry: dict[str, float] | None = None
    fee_rate = max(float(config.open_fee_pct or 0), float(config.close_fee_pct or 0)) / 100.0
    action_map = {
        "buy": ("open-long", "做多", "long"),
        "sell": ("open-short", "做空", "short"),
        "closebuy": ("close-long", "平多", "close"),
        "closesell": ("close-short", "平空", "shortclose"),
    }

    for item in runtime_logs:
        if not isinstance(item, list) or len(item) < 10:
            continue
        action = str(item[9] or "")
        if action not in {"buy", "sell", "closebuy", "closesell"}:
            continue

        timestamp = int(item[1])
        fallback_qty = float(item[6] or 0)
        fallback_price, fallback_qty = extract_price_and_qty(timestamp, fallback_qty)
        messages = message_by_time.get(timestamp, [])
        prev_state = lookup_snapshot_state(snapshot_times, snapshot_states, timestamp)
        next_state = lookup_snapshot_state(snapshot_times, snapshot_states, timestamp, prefer_next=True)
        price = fallback_price
        quantity = fallback_qty
        pnl = 0.0

        if action == "buy":
            quantity = float(next_state.get("long_amount") or quantity)
            price = float(next_state.get("long_price") or price)
            long_entry = {"price": price, "quantity": quantity}
        elif action == "sell":
            quantity = float(next_state.get("short_amount") or quantity)
            price = float(next_state.get("short_price") or price)
            short_entry = {"price": price, "quantity": quantity}
        elif action == "closebuy":
            quantity = float(long_entry["quantity"]) if long_entry else fallback_qty
            close_profit = float(next_state.get("long_close_profit", prev_state.get("long_close_profit", 0)) - prev_state.get("long_close_profit", 0))
            pnl = close_profit
            if long_entry and quantity > 0:
                price = float(long_entry["price"]) + (close_profit / quantity)
            long_entry = None
        elif action == "closesell":
            quantity = float(short_entry["quantity"]) if short_entry else fallback_qty
            close_profit = float(next_state.get("short_close_profit", prev_state.get("short_close_profit", 0)) - prev_state.get("short_close_profit", 0))
            pnl = close_profit
            if short_entry and quantity > 0:
                price = float(short_entry["price"]) - (close_profit / quantity)
            short_entry = None

        fee = round(price * quantity * fee_rate, 6) if price > 0 and quantity > 0 else 0.0
        event_code, label, marker = action_map[action]
        message = messages[0] if messages else f"{label} {config.symbol} qty={round(quantity, 6)}"

        rows.append(
            {
                "id": f"{timestamp}-{action}-{len(rows)}",
                "time": timestamp,
                "action": action,
                "eventCode": event_code,
                "label": label,
                "marker": marker,
                "positionSide": "short" if action in {"sell", "closesell"} else "long",
                "symbol": config.symbol,
                "message": message,
                "side": action,
                "price": round(price, 6),
                "quantity": round(quantity, 6),
                "fee": fee,
                "pnl": round(pnl, 6),
                "equity": round(float(config.initial_capital) + float(next_state.get("long_profit", 0)) + float(next_state.get("short_profit", 0)), 6),
                "lastPrice": round(float(next_state.get("last_price") or prev_state.get("last_price") or price), 6),
                "beforePosition": {
                    "longAmount": round(float(prev_state.get("long_amount") or 0), 6),
                    "shortAmount": round(float(prev_state.get("short_amount") or 0), 6),
                },
                "afterPosition": {
                    "longAmount": round(float(next_state.get("long_amount") or 0), 6),
                    "shortAmount": round(float(next_state.get("short_amount") or 0), 6),
                },
            }
        )
    return rows


def build_status_info(
    raw_result: dict[str, Any],
    asset_rows: list[dict[str, Any]],
    market_rows: list[dict[str, Any]],
    trade_rows: list[dict[str, Any]],
    config: BacktestConfig,
) -> dict[str, Any]:
    latest_asset = asset_rows[0] if asset_rows else {}
    latest_market = market_rows[-1] if market_rows else {}
    return {
        "backtestStatus": raw_result.get("BacktestStatus"),
        "finished": bool(raw_result.get("Finished")),
        "progress": float(raw_result.get("Progress") or 0),
        "logsCount": int(raw_result.get("LogsCount") or 0),
        "loadBytes": int(raw_result.get("LoadBytes") or 0),
        "loadElapsed": int(raw_result.get("LoadElapsed") or 0),
        "elapsed": int(raw_result.get("Elapsed") or 0),
        "lastPrice": latest_market.get("lastPrice", 0),
        "equity": latest_market.get("equity", 0),
        "utilization": latest_market.get("utilization", 0),
        "longAmount": latest_market.get("longAmount", 0),
        "shortAmount": latest_market.get("shortAmount", 0),
        "estimatedProfit": latest_asset.get("estimatedProfit", 0),
        "tradeCount": len(trade_rows),
        "mode": config.mode,
        "quoteAsset": config.quote_asset,
        "tolerancePct": config.tolerance_pct,
        "candleLimit": config.candle_limit,
        "chartDisplay": config.chart_display,
        "depthMin": config.depth_min,
        "depthMax": config.depth_max,
        "recordEvents": config.record_events,
        "leverage": config.leverage,
        "chartBars": config.chart_bars,
        "delayMs": config.delay_ms,
        "logLimit": config.log_limit,
        "profitLimit": config.profit_limit,
        "dataSource": config.data_source,
        "orderMode": config.order_mode,
        "period": config.period,
        "basePeriod": config.base_period,
        "brokerTarget": config.broker_target,
        "symbol": config.symbol,
        "marketType": config.market_type,
    }


def _run_fmz_backtest_direct(source_code: str, config: BacktestConfig) -> dict[str, Any]:
    fmz = load_fmz_module()
    task, _ = build_task(source_code, config, fmz)
    backtest = fmz.Backtest(task, fmz.DummySession())
    started = time.perf_counter()
    backtest.Run()
    duration_ms = int((time.perf_counter() - started) * 1000)
    raw = backtest.ctx.Join(False)
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    try:
        result = json.loads(text)
    except json.JSONDecodeError as exc:
        start = max(0, exc.pos - 200)
        end = min(len(text), exc.pos + 200)
        snippet = text[start:end]
        raise RuntimeError(f"FMZ 回测结果解析失败: {exc.msg} at {exc.pos}. Snippet: {snippet}") from exc

    try:
        ohlcv_rows = fetch_ohlcv_rows(config)
    except Exception:
        ohlcv_rows = []
    equity_curve = build_equity_curve(result, config.initial_capital)
    metrics = compute_metrics(equity_curve)
    asset_rows = build_asset_rows(result, config.initial_capital)
    runtime_logs = build_runtime_logs(result)
    if config.record_events:
        runtime_logs = sorted([*runtime_logs, *build_funding_logs(result, config)], key=lambda item: int(item["time"]))
    trade_rows = build_trade_rows(result, config)
    market_rows = build_market_rows(result, config.initial_capital, ohlcv_rows)
    status_info = build_status_info(result, asset_rows, market_rows, trade_rows, config)

    if asset_rows:
        metrics["trades"] = int(asset_rows[0].get("tradeCount") or len(trade_rows))

    events_by_time: dict[int, list[dict[str, Any]]] = {}
    market_times = [int(row["time"]) for row in market_rows]
    market_index = {int(row["time"]): dict(row) for row in market_rows}

    def nearest_market_time(timestamp: int) -> int | None:
        if not market_times:
            return None
        index = bisect_left(market_times, timestamp)
        candidates: list[int] = []
        if index < len(market_times):
            candidates.append(market_times[index])
        if index > 0:
            candidates.append(market_times[index - 1])
        return min(candidates, key=lambda value: abs(value - timestamp)) if candidates else market_times[-1]

    def nearest_market_row(timestamp: int) -> dict[str, Any]:
        if not market_times:
            return {
                "time": timestamp,
                "lastPrice": 0.0,
                "equity": float(config.initial_capital),
                "utilization": 0.0,
                "longAmount": 0.0,
                "longPrice": 0.0,
                "longProfit": 0.0,
                "shortAmount": 0.0,
                "shortPrice": 0.0,
                "shortProfit": 0.0,
            }
        nearest_time = nearest_market_time(timestamp)
        if nearest_time is None:
            return {
                "time": timestamp,
                "lastPrice": 0.0,
                "equity": float(config.initial_capital),
                "utilization": 0.0,
                "longAmount": 0.0,
                "longPrice": 0.0,
                "longProfit": 0.0,
                "shortAmount": 0.0,
                "shortPrice": 0.0,
                "shortProfit": 0.0,
            }
        return dict(market_index[nearest_time])

    for trade in trade_rows:
        event_time = int(trade["time"])
        attach_time = nearest_market_time(event_time)
        if attach_time is None:
            synthetic_row = nearest_market_row(event_time)
            synthetic_row["time"] = event_time
            synthetic_row["lastPrice"] = float(trade.get("lastPrice") or synthetic_row.get("lastPrice") or trade.get("price") or 0)
            synthetic_row["equity"] = float(trade.get("equity") or synthetic_row.get("equity") or config.initial_capital)
            market_index[event_time] = synthetic_row
            market_times.append(event_time)
            attach_time = event_time
        events_by_time.setdefault(int(attach_time), []).append(
            {
                "id": trade["id"],
                "label": trade["label"],
                "marker": trade["marker"],
                "action": trade["action"],
                "symbol": trade["symbol"],
                "price": trade["price"],
                "averagePrice": trade["price"],
                "quantity": trade["quantity"],
                "fee": trade["fee"],
                "pnl": trade["pnl"],
                "status": "completed",
                "time": trade["time"],
                "completedAt": trade["time"],
                "message": trade["message"],
            }
        )

    market_rows = [market_index[time] for time in sorted(set(market_times))]
    market_rows = [
        {
            **row,
            "events": events_by_time.get(int(row["time"]), []),
        }
        for row in market_rows[-max(int(config.chart_bars or 0), 200) :]
    ]

    return {
        "source": "fmz-official-local",
        "params": build_result_params(config),
        "engineConfig": build_engine_options(config),
        "metrics": metrics,
        "equityCurve": equity_curve[-300:],
        "trades": trade_rows,
        "marketRows": market_rows,
        "logs": runtime_logs[-200:],
        "assetRows": [{k: v for k, v in row.items() if k != "tradeCount"} for row in asset_rows],
        "statusInfo": status_info,
        "summary": {
            "barCount": len(market_rows),
            "orderCount": metrics["trades"],
            "dataSource": "fmz-official-local-engine",
            "startedAtText": config.start_time,
            "endedAtText": config.end_time,
            "durationMs": duration_ms,
            "period": config.period,
            "basePeriod": config.base_period,
            "mode": config.mode,
            "quoteAsset": config.quote_asset,
            "tolerancePct": config.tolerance_pct,
            "candleLimit": config.candle_limit,
            "chartDisplay": config.chart_display,
            "depthMin": config.depth_min,
            "depthMax": config.depth_max,
            "recordEvents": config.record_events,
            "leverage": config.leverage,
            "chartBars": config.chart_bars,
            "delayMs": config.delay_ms,
            "logLimit": config.log_limit,
            "profitLimit": config.profit_limit,
            "orderMode": config.order_mode,
        },
        "rawResult": result,
    }


def run_fmz_backtest(source_code: str, config: BacktestConfig, progress_callback: Callable[[int, str], None] | None = None) -> dict[str, Any]:
    payload = {
        "source_code": source_code,
        "config": {
            "strategy_id": config.strategy_id,
            "broker_target": config.broker_target,
            "symbol": config.symbol,
            "market_type": config.market_type,
            "period": config.period,
            "base_period": config.base_period,
            "start_time": config.start_time,
            "end_time": config.end_time,
            "mode": config.mode,
            "initial_capital": config.initial_capital,
            "quote_asset": config.quote_asset,
            "tolerance_pct": config.tolerance_pct,
            "open_fee_pct": config.open_fee_pct,
            "close_fee_pct": config.close_fee_pct,
            "slippage_points": config.slippage_points,
            "candle_limit": config.candle_limit,
            "chart_display": config.chart_display,
            "depth_min": config.depth_min,
            "depth_max": config.depth_max,
            "record_events": config.record_events,
            "leverage": config.leverage,
            "chart_bars": config.chart_bars,
            "delay_ms": config.delay_ms,
            "log_limit": config.log_limit,
            "profit_limit": config.profit_limit,
            "data_source": config.data_source,
            "order_mode": config.order_mode,
            "distributor": config.distributor,
        },
    }
    worker_path = Path(__file__).resolve().parent / "fmz_backtest_worker.py"
    if progress_callback:
        progress_callback(10, "FMZ 本地回测引擎启动中")

    payload_file = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False)
    payload_path = Path(payload_file.name)
    result_path = payload_path.with_name(f"{payload_path.stem}.result.json")
    try:
        json.dump(payload, payload_file, ensure_ascii=False)
        payload_file.close()

        process = subprocess.Popen(
            [sys.executable, str(worker_path), str(payload_path), str(result_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

        started = time.perf_counter()
        last_tick = -1
        while process.poll() is None:
            elapsed_seconds = int(time.perf_counter() - started)
            if progress_callback and elapsed_seconds != last_tick and elapsed_seconds % 2 == 0:
                progress = min(90, 15 + elapsed_seconds * 4)
                progress_callback(progress, f"FMZ 引擎运行中，已耗时 {elapsed_seconds} 秒")
                last_tick = elapsed_seconds
            time.sleep(0.25)

        stdout = process.stdout.read() if process.stdout else ""
        stderr = process.stderr.read() if process.stderr else ""
        if process.returncode != 0:
            detail = stderr.strip() or stdout.strip() or "FMZ 本地回测引擎执行失败"
            raise RuntimeError(detail)
        if progress_callback:
            progress_callback(95, "正在解析回测结果")
        return json.loads(result_path.read_text(encoding="utf-8"))
    finally:
        try:
            payload_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            result_path.unlink(missing_ok=True)
        except Exception:
            pass
