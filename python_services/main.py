from __future__ import annotations

import base64
import ast
import hashlib
import json
import math
import os
import re
import secrets
import time
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import ccxt
import pandas as pd
import polars as pl
import uvicorn
import vectorbt as vbt
from cryptography.fernet import Fernet
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


APP_PORT = int(os.getenv("PY_PLATFORM_PORT", "8800"))
DB_PATH = Path(os.getenv("PY_PLATFORM_DB_PATH", Path(__file__).resolve().parent / "data" / "platform_db.json"))
STRATEGY_STORE_ROOT = Path(os.getenv("PY_PLATFORM_STRATEGY_STORE", Path(__file__).resolve().parent / "strategy_store"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
STRATEGY_STORE_ROOT.mkdir(parents=True, exist_ok=True)
SESSION_TTL_MS = 1000 * 60 * 60 * 12
DEV_LOCAL_MODE = os.getenv("PY_PLATFORM_LOCAL_MODE", "1").lower() not in {"0", "false", "off"}

BrokerId = Literal["paper", "binance", "okx", "bybit", "ibkr"]
BrokerMode = Literal["paper", "sandbox", "production"]
StrategyRuntime = Literal["backtest-only", "paper", "sandbox", "production"]
MarketType = Literal["spot", "futures"]
StrategyTemplate = Literal["smaCross", "breakout", "python"]


def now_ms() -> int:
    return int(time.time() * 1000)


def create_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def build_fernet() -> Fernet:
    secret = os.getenv("SECRET_STORE_KEY", "replace-with-a-long-random-secret").encode("utf-8")
    digest = hashlib.sha256(secret).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


FERNET = build_fernet()


def encrypt_secret(value: str) -> str:
    return FERNET.encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str) -> str:
    return FERNET.decrypt(value.encode("utf-8")).decode("utf-8")


class JsonDb:
    def __init__(self, path: Path):
        self.path = path
        self.lock = Lock()
        if not self.path.exists():
            self.write(self.default_state())

    @staticmethod
    def default_state() -> dict[str, Any]:
        return {
            "users": [],
            "sessions": [],
            "credentials": [],
            "strategies": [],
            "backtests": [],
            "auditEvents": [],
            "paperAccounts": [],
        }

    def read(self) -> dict[str, Any]:
        with self.lock:
            with self.path.open("r", encoding="utf-8") as handle:
                return json.load(handle)

    def write(self, state: dict[str, Any]) -> None:
        with self.lock:
            with self.path.open("w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)

    def update(self, fn):
        state = self.read()
        next_state = fn(state)
        self.write(next_state)
        return next_state


db = JsonDb(DB_PATH)


DEFAULT_STRATEGIES = [
    {
        "name": "BTC 双均线趋势",
        "description": "使用快慢均线交叉识别趋势方向，适合先做回测和纸面验证。",
        "marketType": "futures",
        "symbol": "BTCUSDT",
        "interval": "1h",
        "runtime": "sandbox",
        "template": "smaCross",
        "parameters": {"fastPeriod": 20, "slowPeriod": 50, "positionSizeUsd": 1500},
        "risk": {
            "maxNotional": 5000,
            "maxLeverage": 3,
            "maxDailyLoss": 400,
            "allowedSymbols": ["BTCUSDT", "ETHUSDT"],
        },
    },
    {
        "name": "ETH 突破模板",
        "description": "基于突破窗口寻找入场信号，适合验证仓位控制和止盈止损参数。",
        "marketType": "spot",
        "symbol": "ETHUSDT",
        "interval": "4h",
        "runtime": "paper",
        "template": "breakout",
        "parameters": {"breakoutLookback": 20, "positionSizeUsd": 1000, "stopLossPct": 2, "takeProfitPct": 4},
        "risk": {
            "maxNotional": 3000,
            "maxLeverage": 1,
            "maxDailyLoss": 250,
            "allowedSymbols": ["ETHUSDT"],
        },
    },
]

DEFAULT_PYTHON_STRATEGY = """import polars as pl


def generate_signals(frame: pl.DataFrame, params: dict) -> dict:
    fast_period = int(params.get("fastPeriod", 20))
    slow_period = int(params.get("slowPeriod", 50))

    if frame.height == 0:
        return {"entries": [], "exits": []}

    close = frame["close"]
    fast = close.rolling_mean(fast_period)
    slow = close.rolling_mean(slow_period)

    entries: list[bool] = []
    exits: list[bool] = []
    previous_fast = None
    previous_slow = None

    for current_fast, current_slow in zip(fast.to_list(), slow.to_list()):
        can_compare = None not in (previous_fast, previous_slow, current_fast, current_slow)
        entries.append(bool(can_compare and current_fast > current_slow and previous_fast <= previous_slow))
        exits.append(bool(can_compare and current_fast < current_slow and previous_fast >= previous_slow))
        previous_fast = current_fast
        previous_slow = current_slow

    return {"entries": entries, "exits": exits}
"""


BROKER_SUMMARIES = [
    {
        "brokerId": "binance",
        "label": "Binance",
        "supportsMarketData": True,
        "supportsExecution": True,
        "targets": [
            {"target": "binance:sandbox", "mode": "sandbox", "label": "Binance Sandbox"},
            {"target": "binance:production", "mode": "production", "label": "Binance Production"},
        ],
    },
    {
        "brokerId": "okx",
        "label": "OKX",
        "supportsMarketData": True,
        "supportsExecution": True,
        "targets": [
            {"target": "okx:sandbox", "mode": "sandbox", "label": "OKX Sandbox"},
            {"target": "okx:production", "mode": "production", "label": "OKX Production"},
        ],
    },
]


app = FastAPI(title="QuantX Python Platform", version="0.1.0")


def looks_corrupted_text(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    if not stripped:
        return False
    return all(char == "?" for char in stripped)


def normalize_strategy_record(strategy: dict[str, Any]) -> dict[str, Any]:
    normalized = {**strategy}
    template = normalized.get("template")
    symbol = normalized.get("symbol", "UNKNOWN")
    interval = normalized.get("interval", "")

    if normalized.get("name") == "BTC SMA Trend":
        normalized["name"] = "BTC 双均线趋势"
    if normalized.get("description") == "Fast and slow moving average crossover validated through the research runtime.":
        normalized["description"] = "使用快慢均线交叉识别趋势方向，适合先做回测和纸面验证。"

    if normalized.get("name") == "ETH Breakout":
        normalized["name"] = "ETH 突破模板"
    if normalized.get("description") == "Breakout template for paper deployment and portfolio sizing validation.":
        normalized["description"] = "基于突破窗口寻找入场信号，适合验证仓位控制和止盈止损参数。"

    if looks_corrupted_text(normalized.get("name")):
        if template == "python":
            normalized["name"] = f"Python策略 {symbol} {interval}".strip()
        else:
            normalized["name"] = f"策略 {symbol} {interval}".strip()

    if looks_corrupted_text(normalized.get("description")):
        if template == "python":
            normalized["description"] = "历史乱码已自动修复。请补充这条策略的用途说明。"
        else:
            normalized["description"] = "历史乱码已自动修复。请补充这条策略的说明。"

    return normalized


def ensure_bootstrap_user() -> dict[str, Any]:
    state = db.read()
    if state["users"]:
        return state["users"][0]
    user = {
        "id": create_id("user"),
        "email": os.getenv("AUTH_BOOTSTRAP_EMAIL", "admin@quantx.local").strip().lower(),
        "passwordHash": sha256(os.getenv("AUTH_BOOTSTRAP_PASSWORD", "quantx-admin")),
        "roles": ["admin", "trader"],
        "createdAt": now_ms(),
    }
    db.update(lambda current: {**current, "users": [user, *current["users"]]})
    return user


def ensure_default_strategies() -> list[dict[str, Any]]:
    state = db.read()
    current_strategies = [normalize_strategy_record(item) for item in state["strategies"]]
    state_changed = current_strategies != state["strategies"]
    if len(current_strategies) >= len(DEFAULT_STRATEGIES):
        if state_changed:
            db.write({**state, "strategies": current_strategies})
        return sorted(current_strategies, key=lambda item: item["updatedAt"], reverse=True)
    timestamp = now_ms()

    def updater(current: dict[str, Any]) -> dict[str, Any]:
        strategies = [normalize_strategy_record(item) for item in current["strategies"]]
        for template in DEFAULT_STRATEGIES:
            exists = any(item["name"] == template["name"] and item["symbol"] == template["symbol"] for item in strategies)
            if exists:
                continue
            strategies.append({**template, "id": create_id("strat"), "createdAt": timestamp, "updatedAt": timestamp})
        return {**current, "strategies": strategies}

    db.update(updater)
    refreshed = db.read()
    return sorted(refreshed["strategies"], key=lambda item: item["updatedAt"], reverse=True)


def list_strategies() -> list[dict[str, Any]]:
    state = db.read()
    strategies = [normalize_strategy_record(item) for item in state["strategies"]]
    if strategies != state["strategies"]:
        db.write({**state, "strategies": strategies})
    return sorted(strategies, key=lambda item: item["updatedAt"], reverse=True)


def get_strategy_summary(strategy: dict[str, Any]) -> dict[str, Any]:
    if strategy["template"] != "python":
        return strategy
    return {
        **strategy,
        "sourceCode": strategy.get("sourceCode", ""),
        "compiler": strategy.get("compiler", {"valid": True, "checkedAt": strategy.get("updatedAt"), "errors": [], "warnings": []}),
    }


def slugify_filename(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "-", value.strip())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-_")
    return normalized or "strategy"


def ensure_strategy_artifact(strategy: dict[str, Any]) -> dict[str, Any] | None:
    if strategy.get("template") != "python":
        return None

    strategy_id = strategy["id"]
    strategy_name = strategy.get("name") or strategy_id
    version = int(strategy.get("updatedAt") or now_ms())
    folder_name = f"{slugify_filename(strategy_name)}__{strategy_id}"
    strategy_dir = STRATEGY_STORE_ROOT / folder_name
    strategy_dir.mkdir(parents=True, exist_ok=True)

    source_path = strategy_dir / f"v{version}.py"
    latest_source_path = strategy_dir / "latest.py"
    metadata_path = strategy_dir / f"v{version}.json"
    latest_metadata_path = strategy_dir / "latest.json"

    source_code = strategy.get("sourceCode") or DEFAULT_PYTHON_STRATEGY
    source_path.write_text(source_code, encoding="utf-8")
    latest_source_path.write_text(source_code, encoding="utf-8")

    metadata = {
        "id": strategy_id,
        "name": strategy_name,
        "description": strategy.get("description"),
        "symbol": strategy.get("symbol"),
        "interval": strategy.get("interval"),
        "marketType": strategy.get("marketType"),
        "runtime": strategy.get("runtime"),
        "template": strategy.get("template"),
        "parameters": strategy.get("parameters", {}),
        "risk": strategy.get("risk", {}),
        "compiler": strategy.get("compiler"),
        "version": version,
        "updatedAt": strategy.get("updatedAt"),
        "createdAt": strategy.get("createdAt"),
        "sourceFile": str(source_path),
        "latestSourceFile": str(latest_source_path),
    }
    metadata_text = json.dumps(metadata, ensure_ascii=False, indent=2)
    metadata_path.write_text(metadata_text, encoding="utf-8")
    latest_metadata_path.write_text(metadata_text, encoding="utf-8")

    return {
        "rootDir": str(strategy_dir),
        "sourceFile": str(source_path),
        "latestSourceFile": str(latest_source_path),
        "metadataFile": str(metadata_path),
        "latestMetadataFile": str(latest_metadata_path),
        "version": version,
    }


def parse_broker_target(target: str | None) -> tuple[BrokerId, BrokerMode, str]:
    if not target or target == "paper":
        return "paper", "paper", "paper"
    broker_id, broker_mode = target.split(":", 1)
    if broker_id not in {"binance", "okx", "bybit", "ibkr"}:
        broker_id = "binance"
    if broker_mode != "production":
        broker_mode = "sandbox"
    return broker_id, broker_mode, f"{broker_id}:{broker_mode}"


def get_broker_label(target: str) -> str:
    broker_id, broker_mode, normalized = parse_broker_target(target)
    if normalized == "paper":
        return "Paper"
    return f"{broker_id.upper() if broker_id == 'okx' else broker_id.capitalize()} {'Production' if broker_mode == 'production' else 'Sandbox'}"


def get_default_execution_target(runtime: str) -> str:
    if runtime == "paper":
        return "paper"
    return "binance:production" if runtime == "production" else "binance:sandbox"


def sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "email": user["email"], "roles": user["roles"], "createdAt": user["createdAt"]}


def require_user(authorization: str | None) -> dict[str, Any]:
    user = ensure_bootstrap_user()
    if DEV_LOCAL_MODE and (not authorization or not authorization.startswith("Bearer ")):
        return sanitize_user(user)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing session token")
    token = authorization[7:].strip()
    state = db.read()
    session = next((item for item in state["sessions"] if item["token"] == token and item["expiresAt"] > now_ms()), None)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    user = next((item for item in state["users"] if item["id"] == session["userId"]), None)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return sanitize_user(user)


def audit_event(actor_user_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    event = {
        "id": create_id("audit"),
        "type": event_type,
        "actorUserId": actor_user_id,
        "createdAt": now_ms(),
        "payload": payload,
    }
    db.update(lambda current: {**current, "auditEvents": [event, *current["auditEvents"]][:500]})
    return event


def list_audit_events(user_id: str) -> list[dict[str, Any]]:
    state = db.read()
    return sorted([item for item in state["auditEvents"] if item["actorUserId"] == user_id], key=lambda item: item["createdAt"], reverse=True)


def list_credentials(user_id: str) -> list[dict[str, Any]]:
    state = db.read()
    return sorted([item for item in state["credentials"] if item["userId"] == user_id], key=lambda item: item["updatedAt"], reverse=True)


def get_credential(user_id: str, broker_target: str) -> dict[str, Any] | None:
    state = db.read()
    return next((item for item in state["credentials"] if item["userId"] == user_id and item["brokerTarget"] == broker_target), None)


def save_credential(user_id: str, broker_target: str, label: str, api_key: str, api_secret: str, passphrase: str | None = None) -> list[dict[str, Any]]:
    broker_id, broker_mode, normalized = parse_broker_target(broker_target)
    if normalized == "paper":
        raise HTTPException(status_code=400, detail="Paper target does not support credentials")
    if broker_id == "okx" and not (passphrase or os.getenv("OKX_API_PASSPHRASE")):
        raise HTTPException(status_code=400, detail="OKX credentials require an API passphrase")

    existing = get_credential(user_id, normalized)
    timestamp = now_ms()
    credential = {
        "id": existing["id"] if existing else create_id("cred"),
        "userId": user_id,
        "label": label,
        "brokerId": broker_id,
        "brokerMode": broker_mode,
        "brokerTarget": normalized,
        "encryptedApiKey": encrypt_secret(api_key.strip()),
        "encryptedApiSecret": encrypt_secret(api_secret.strip()),
        "encryptedPassphrase": encrypt_secret(passphrase.strip()) if passphrase else None,
        "createdAt": existing["createdAt"] if existing else timestamp,
        "updatedAt": timestamp,
    }

    def updater(current: dict[str, Any]) -> dict[str, Any]:
        credentials = [item for item in current["credentials"] if item["id"] != credential["id"]]
        credentials.append(credential)
        return {**current, "credentials": credentials}

    db.update(updater)
    return list_credentials(user_id)


def resolve_broker_credentials(user_id: str, broker_target: str) -> dict[str, str] | None:
    credential = get_credential(user_id, broker_target)
    if not credential:
        return None
    return {
        "apiKey": decrypt_secret(credential["encryptedApiKey"]),
        "apiSecret": decrypt_secret(credential["encryptedApiSecret"]),
        "passphrase": decrypt_secret(credential["encryptedPassphrase"]) if credential.get("encryptedPassphrase") else (os.getenv("OKX_API_PASSPHRASE") or ""),
    }


def to_unified_symbol(symbol: str) -> str:
    normalized = symbol.upper()
    for quote in ("USDT", "USDC", "BUSD", "FDUSD", "USD"):
        if normalized.endswith(quote) and len(normalized) > len(quote):
            return f"{normalized[:-len(quote)]}/{quote}"
    return normalized


def to_compact_symbol(symbol: str) -> str:
    return symbol.upper().replace("/", "").replace(":USDT", "").replace("-SWAP", "")


def build_ccxt_proxy_config() -> dict[str, Any]:
    http_proxy = os.getenv("CCXT_HTTP_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
    https_proxy = os.getenv("CCXT_HTTPS_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
    socks_proxy = os.getenv("CCXT_SOCKS_PROXY") or os.getenv("ALL_PROXY")
    ws_proxy = os.getenv("CCXT_WS_PROXY")
    wss_proxy = os.getenv("CCXT_WSS_PROXY")

    proxy_config: dict[str, Any] = {}
    if http_proxy:
        proxy_config["httpProxy"] = http_proxy
    if https_proxy:
        proxy_config["httpsProxy"] = https_proxy
    if socks_proxy:
        proxy_config["socksProxy"] = socks_proxy
    if ws_proxy:
        proxy_config["wsProxy"] = ws_proxy
    if wss_proxy:
        proxy_config["wssProxy"] = wss_proxy
    return proxy_config


def create_exchange_client(broker_id: str, market_type: str, credentials: dict[str, str] | None = None, broker_mode: str = "sandbox"):
    common: dict[str, Any] = {"enableRateLimit": True, "timeout": int(os.getenv("CCXT_TIMEOUT_MS", "10000"))}
    common.update(build_ccxt_proxy_config())
    if credentials:
        common["apiKey"] = credentials["apiKey"]
        common["secret"] = credentials["apiSecret"]
    if broker_id == "okx":
        if credentials:
            common["password"] = credentials.get("passphrase") or os.getenv("OKX_API_PASSPHRASE", "")
        common["options"] = {"defaultType": "spot" if market_type == "spot" else "swap"}
        client = ccxt.okx(common)
        if broker_mode != "production":
            client.set_sandbox_mode(True)
        return client
    if market_type == "spot":
        client = ccxt.binance(common)
        if broker_mode != "production":
            client.set_sandbox_mode(True)
        return client
    client = ccxt.binanceusdm(common)
    if broker_mode != "production":
        client.set_sandbox_mode(True)
    return client


def resolve_market_symbol(client: Any, broker_id: str, market_type: str, compact_symbol: str) -> str:
    markets = client.load_markets()
    target = compact_symbol.upper()
    for market in markets.values():
        if broker_id == "okx":
            type_match = bool(market.get("spot")) if market_type == "spot" else bool(market.get("swap") or market.get("future"))
            if not type_match:
                continue
            if to_compact_symbol(str(market.get("symbol") or market.get("id") or "")) == target:
                return str(market["symbol"])
        elif str(market.get("id") or "").upper() == target:
            return str(market["symbol"])
    return to_unified_symbol(compact_symbol)


def interval_to_millis(interval: str) -> int:
    unit = interval[-1].lower() if interval else "h"
    value = int(interval[:-1]) if interval[:-1].isdigit() else 1
    if unit == "m":
        return value * 60_000
    if unit == "h":
        return value * 3_600_000
    if unit == "d":
        return value * 86_400_000
    return 3_600_000


def generate_synthetic_ohlcv(symbol: str, interval: str, limit: int) -> pl.DataFrame:
    step = interval_to_millis(interval)
    end_ts = (now_ms() // step) * step
    base = 100 + (sum(ord(ch) for ch in symbol.upper()) % 5000) / 10
    rows: list[dict[str, float | int]] = []
    for index in range(limit):
        ts = end_ts - (limit - index - 1) * step
        drift = index * 0.18
        wave = math.sin(index / 7) * 4.5 + math.cos(index / 13) * 2.2
        open_price = base + drift + wave
        close_price = open_price + math.sin(index / 3) * 1.4
        high_price = max(open_price, close_price) + 1.2 + abs(math.cos(index / 5))
        low_price = min(open_price, close_price) - 1.2 - abs(math.sin(index / 5))
        volume = 1000 + abs(math.sin(index / 4)) * 400 + index * 3
        rows.append(
            {
                "timestamp": int(ts),
                "open": float(open_price),
                "high": float(high_price),
                "low": float(low_price),
                "close": float(close_price),
                "volume": float(volume),
            }
        )
    return pl.DataFrame(rows)


def fetch_ohlcv_frame(broker_target: str, market_type: str, symbol: str, interval: str, limit: int) -> tuple[pl.DataFrame, str]:
    broker_id, broker_mode, normalized = parse_broker_target(broker_target)
    if normalized == "paper":
        broker_id = "binance"
        broker_mode = "sandbox"
    try:
        client = create_exchange_client(broker_id, market_type, broker_mode=broker_mode)
        market_symbol = resolve_market_symbol(client, broker_id, market_type, symbol)
        rows = client.fetch_ohlcv(market_symbol, interval, limit=limit)
        if not rows:
            raise ValueError("No historical candles returned from broker")
        return (
            pl.DataFrame(
                {
                    "timestamp": [int(item[0]) for item in rows],
                    "open": [float(item[1]) for item in rows],
                    "high": [float(item[2]) for item in rows],
                    "low": [float(item[3]) for item in rows],
                    "close": [float(item[4]) for item in rows],
                    "volume": [float(item[5]) if len(item) > 5 and item[5] is not None else 0.0 for item in rows],
                }
            ),
            "broker-historical",
        )
    except Exception as exc:
        print(f"[market-data] fallback to synthetic candles for {broker_target} {market_type} {symbol} {interval}: {exc}")
        return generate_synthetic_ohlcv(symbol, interval, limit), "synthetic-fallback"


def strategy_signals(strategy: dict[str, Any], frame: pl.DataFrame):
    index = pd.to_datetime(frame["timestamp"].to_list(), unit="ms")
    close = pd.Series(frame["close"].to_list(), index=index)
    if strategy["template"] == "python":
        return close, *run_python_strategy_signals(strategy, frame, index)
    if strategy["template"] == "smaCross":
        fast = int(strategy["parameters"].get("fastPeriod", 20))
        slow = int(strategy["parameters"].get("slowPeriod", 50))
        fast_ma = close.rolling(fast).mean()
        slow_ma = close.rolling(slow).mean()
        entries = (fast_ma > slow_ma) & (fast_ma.shift(1) <= slow_ma.shift(1))
        exits = (fast_ma < slow_ma) & (fast_ma.shift(1) >= slow_ma.shift(1))
        return close, entries.fillna(False), exits.fillna(False)
    lookback = int(strategy["parameters"].get("breakoutLookback", 20))
    rolling_high = close.rolling(lookback).max().shift(1)
    rolling_low = close.rolling(lookback).min().shift(1)
    return close, (close > rolling_high).fillna(False), (close < rolling_low).fillna(False)


def _coerce_signal_series(values: Any, index: pd.Index, field_name: str) -> pd.Series:
    if isinstance(values, pl.Series):
        items = values.to_list()
    elif isinstance(values, pd.Series):
        items = values.tolist()
    elif isinstance(values, list):
        items = values
    else:
        raise ValueError(f"{field_name} must be a list, pandas Series, or polars Series")

    if len(items) != len(index):
        raise ValueError(f"{field_name} length must match the number of candles")
    return pd.Series([bool(item) for item in items], index=index).fillna(False)


def run_python_strategy_signals(strategy: dict[str, Any], frame: pl.DataFrame, index: pd.Index) -> tuple[pd.Series, pd.Series]:
    source_code = (strategy.get("sourceCode") or "").strip()
    if not source_code:
        raise ValueError("Python strategy source code is empty")

    compiler = compile_python_strategy(source_code)
    if not compiler["valid"]:
        raise ValueError("Python strategy compilation failed: " + "; ".join(compiler["errors"]))

    namespace: dict[str, Any] = {}
    safe_globals: dict[str, Any] = {
        "__builtins__": {
            "__import__": __import__,
            "abs": abs,
            "all": all,
            "any": any,
            "bool": bool,
            "dict": dict,
            "enumerate": enumerate,
            "float": float,
            "int": int,
            "len": len,
            "list": list,
            "max": max,
            "min": min,
            "range": range,
            "round": round,
            "sum": sum,
            "zip": zip,
        },
        "pl": pl,
        "math": math,
    }
    exec(compile(source_code, "<strategy>", "exec"), safe_globals, namespace)
    generate_signals = namespace.get("generate_signals") or safe_globals.get("generate_signals")
    if not callable(generate_signals):
        raise ValueError("generate_signals(frame, params) was not defined")

    result = generate_signals(frame, strategy.get("parameters", {}))
    if not isinstance(result, dict):
        raise ValueError("generate_signals must return a dict with entries and exits")

    entries = _coerce_signal_series(result.get("entries", []), index, "entries")
    exits = _coerce_signal_series(result.get("exits", []), index, "exits")
    return entries, exits


def serialize_trade_records(portfolio) -> list[dict[str, Any]]:
    try:
        records = portfolio.trades.records_readable
        return [
            {
                "time": now_ms(),
                "side": str(record["Direction"]).upper(),
                "price": float(record.get("Avg Exit Price") or record.get("Avg Entry Price") or 0),
                "quantity": float(record.get("Size") or 0),
                "fee": float(record.get("Fees") or 0),
                "pnl": float(record.get("PnL") or 0),
                "reason": "vectorbt",
            }
            for _, record in records.iterrows()
        ]
    except Exception:
        return []


def run_vectorbt_backtest(strategy: dict[str, Any], frame: pl.DataFrame, lookback: int, initial_capital: float, fee_bps: float, slippage_bps: float) -> dict[str, Any]:
    close, entries, exits = strategy_signals(strategy, frame)
    portfolio = vbt.Portfolio.from_signals(
        close,
        entries,
        exits,
        init_cash=initial_capital,
        fees=fee_bps / 10_000,
        slippage=slippage_bps / 10_000,
        freq=strategy["interval"],
    )
    value = portfolio.value()
    total_return = portfolio.total_return()
    sharpe_ratio = portfolio.sharpe_ratio()
    max_drawdown = portfolio.max_drawdown()
    win_rate = portfolio.trades.win_rate()
    return {
        "id": create_id("bt"),
        "strategyId": strategy["id"],
        "symbol": strategy["symbol"],
        "interval": strategy["interval"],
        "marketType": strategy["marketType"],
        "startedAt": now_ms(),
        "completedAt": now_ms(),
        "source": "broker-historical",
        "params": {"lookback": lookback, "initialCapital": initial_capital, "feeBps": fee_bps, "slippageBps": slippage_bps},
        "metrics": {
            "totalReturnPct": float(total_return) * 100 if total_return is not None else 0.0,
            "sharpe": float(sharpe_ratio) if sharpe_ratio is not None else 0.0,
            "maxDrawdownPct": float(max_drawdown) * 100 if max_drawdown is not None else 0.0,
            "winRatePct": float(win_rate) * 100 if win_rate is not None else 0.0,
            "trades": int(portfolio.trades.count()),
            "endingEquity": float(value.iloc[-1]) if len(value) else initial_capital,
        },
        "equityCurve": [{"time": int(ts / 1000), "equity": float(eq)} for ts, eq in zip(frame["timestamp"].to_list(), value.tolist())],
        "trades": serialize_trade_records(portfolio),
    }


def get_paper_account(user_id: str) -> dict[str, Any]:
    state = db.read()
    account = next((item for item in state["paperAccounts"] if item["userId"] == user_id), None)
    if account:
        return account
    return {"id": create_id("paper"), "userId": user_id, "balanceUsd": 100000.0, "realizedPnl": 0.0, "positions": [], "updatedAt": now_ms()}


def save_paper_account(account: dict[str, Any]) -> dict[str, Any]:
    db.update(lambda current: {**current, "paperAccounts": [item for item in current["paperAccounts"] if item["id"] != account["id"]] + [account]})
    return account


def evaluate_pre_trade_risk(strategy: dict[str, Any], requested_notional: float, leverage: float) -> dict[str, Any]:
    breaches: list[str] = []
    if requested_notional > float(strategy["risk"]["maxNotional"]):
        breaches.append("notional limit exceeded")
    if leverage > float(strategy["risk"]["maxLeverage"]):
        breaches.append("leverage limit exceeded")
    return {"allow": not breaches, "breaches": breaches}


def compile_python_strategy(source_code: str) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    function_names: list[str] = []
    if not source_code.strip():
        return {"valid": False, "errors": ["策略源码不能为空"], "warnings": warnings, "functions": function_names}
    try:
        tree = ast.parse(source_code, filename="<strategy>")
        compile(source_code, "<strategy>", "exec")
        function_names = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
        if "generate_signals" not in function_names:
            errors.append("必须定义 generate_signals(frame, params) 函数")
        if not any(isinstance(node, ast.Import) or isinstance(node, ast.ImportFrom) for node in tree.body):
            warnings.append("没有检测到 import 语句，通常建议显式导入 polars")
    except SyntaxError as exc:
        errors.append(f"第 {exc.lineno} 行语法错误：{exc.msg}")
    except Exception as exc:
        errors.append(str(exc))
    return {"valid": not errors, "errors": errors, "warnings": warnings, "functions": function_names}
class LoginRequest(BaseModel):
    email: str
    password: str


class CredentialRequest(BaseModel):
    brokerTarget: str
    label: str
    apiKey: str
    apiSecret: str
    apiPassphrase: str | None = None


class BacktestRequest(BaseModel):
    strategyId: str
    lookback: int = Field(default=500, ge=100, le=1500)
    initialCapital: float = 10000
    feeBps: float = 4
    slippageBps: float = 2


class ExecutionRequest(BaseModel):
    strategyId: str
    brokerTarget: str = "paper"
    side: Literal["BUY", "SELL"]
    quantity: float | None = None
    leverage: float = 1


class StrategyRequest(BaseModel):
    id: str | None = None
    name: str
    description: str
    marketType: MarketType
    symbol: str
    interval: str
    runtime: StrategyRuntime
    template: StrategyTemplate
    parameters: dict[str, float]
    risk: dict[str, Any]
    sourceCode: str | None = None


class StrategyCompileRequest(BaseModel):
    sourceCode: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "python-platform", "port": APP_PORT}


@app.post("/api/platform/auth/login")
def login(payload: LoginRequest):
    ensure_bootstrap_user()
    state = db.read()
    user = next((item for item in state["users"] if item["email"] == payload.email.strip().lower()), None)
    if not user or user["passwordHash"] != sha256(payload.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    session = {"token": create_id("sess"), "userId": user["id"], "createdAt": now_ms(), "expiresAt": now_ms() + SESSION_TTL_MS}
    db.update(lambda current: {**current, "sessions": [item for item in current["sessions"] if item["expiresAt"] > now_ms()] + [session]})
    audit_event(user["id"], "auth.login", {"email": user["email"]})
    return {"session": session, "user": sanitize_user(user)}


@app.get("/api/platform/me")
def me(authorization: str | None = Header(default=None)):
    return {"user": require_user(authorization)}


@app.get("/api/platform/brokers")
def brokers(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return BROKER_SUMMARIES


@app.get("/api/platform/strategies")
def strategies(authorization: str | None = Header(default=None)):
    require_user(authorization)
    ensure_default_strategies()
    return [get_strategy_summary(item) for item in list_strategies()]


@app.post("/api/platform/strategies")
def save_strategy(payload: StrategyRequest, authorization: str | None = Header(default=None)):
    require_user(authorization)
    ensure_default_strategies()
    existing = next((item for item in list_strategies() if item["id"] == payload.id), None)
    timestamp = now_ms()
    compiler = None
    if payload.template == "python":
        compiler = compile_python_strategy(payload.sourceCode or "")
        if not compiler["valid"]:
            raise HTTPException(status_code=400, detail=f"Python 策略编译失败：{'；'.join(compiler['errors'])}")
    strategy = {
        **payload.model_dump(),
        "sourceCode": payload.sourceCode if payload.template == "python" else None,
        "compiler": {**compiler, "checkedAt": timestamp} if compiler else None,
        "id": existing["id"] if existing else create_id("strat"),
        "createdAt": existing["createdAt"] if existing else timestamp,
        "updatedAt": timestamp,
    }
    artifact_summary = ensure_strategy_artifact(strategy)
    if artifact_summary:
        strategy["artifactSummary"] = artifact_summary
    db.update(lambda current: {**current, "strategies": [item for item in current["strategies"] if item["id"] != strategy["id"]] + [strategy]})
    return get_strategy_summary(strategy)


@app.post("/api/platform/strategies/compile")
def compile_strategy(payload: StrategyCompileRequest, authorization: str | None = Header(default=None)):
    require_user(authorization)
    result = compile_python_strategy(payload.sourceCode)
    return {**result, "checkedAt": now_ms()}


@app.get("/api/platform/backtests")
def list_backtests(strategyId: str | None = None, authorization: str | None = Header(default=None)):
    require_user(authorization)
    state = db.read()
    runs = [item for item in state["backtests"] if not strategyId or item["strategyId"] == strategyId]
    return sorted(runs, key=lambda item: item["completedAt"], reverse=True)


@app.post("/api/platform/backtests")
def run_backtest(payload: BacktestRequest, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    strategy = next((item for item in ensure_default_strategies() if item["id"] == payload.strategyId), None)
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    broker_target = get_default_execution_target(strategy["runtime"])
    frame, source = fetch_ohlcv_frame(broker_target, strategy["marketType"], strategy["symbol"], strategy["interval"], payload.lookback)
    run = run_vectorbt_backtest(strategy, frame, payload.lookback, payload.initialCapital, payload.feeBps, payload.slippageBps)
    run["source"] = source
    db.update(lambda current: {**current, "backtests": [run, *current["backtests"]][:100]})
    audit_event(user["id"], "backtest.run", {"strategyId": strategy["id"], "runId": run["id"], "metrics": run["metrics"]})
    return run


@app.get("/api/platform/runtime/connectivity")
def runtime_connectivity(authorization: str | None = Header(default=None)):
    require_user(authorization)
    http_proxy = os.getenv("CCXT_HTTP_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or ""
    socks_proxy = os.getenv("CCXT_SOCKS_PROXY") or os.getenv("ALL_PROXY") or ""
    broker_checks: list[dict[str, Any]] = []
    for broker_target in ("okx:sandbox", "binance:sandbox"):
        broker_id, broker_mode, normalized = parse_broker_target(broker_target)
        try:
            client = create_exchange_client(broker_id, "futures", broker_mode=broker_mode)
            broker_checks.append({
                "brokerTarget": normalized,
                "ok": True,
                "remoteTime": client.fetch_time(),
            })
        except Exception as exc:
            broker_checks.append({
                "brokerTarget": normalized,
                "ok": False,
                "error": str(exc),
            })
    return {
        "proxy": {
            "configured": bool(http_proxy or socks_proxy),
            "httpProxy": http_proxy,
            "socksProxy": socks_proxy,
        },
        "brokers": broker_checks,
        "checkedAt": now_ms(),
    }


@app.get("/api/platform/credentials")
def credentials(authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    return [{"id": item["id"], "label": item["label"], "brokerTarget": item["brokerTarget"], "updatedAt": item["updatedAt"]} for item in list_credentials(user["id"])]


@app.post("/api/platform/credentials")
def create_credential(payload: CredentialRequest, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    items = save_credential(user["id"], payload.brokerTarget, payload.label, payload.apiKey, payload.apiSecret, payload.apiPassphrase)
    audit_event(user["id"], "secret.saved", {"brokerTarget": payload.brokerTarget, "label": payload.label})
    return [{"id": item["id"], "label": item["label"], "brokerTarget": item["brokerTarget"], "updatedAt": item["updatedAt"]} for item in items]


@app.get("/api/platform/audit")
def audit(authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    return list_audit_events(user["id"])


@app.get("/api/platform/paper-account")
def paper_account(authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    return get_paper_account(user["id"])


@app.post("/api/platform/execution")
def execute(payload: ExecutionRequest, authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    strategy = next((item for item in ensure_default_strategies() if item["id"] == payload.strategyId), None)
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    broker_id, broker_mode, normalized_target = parse_broker_target(payload.brokerTarget or get_default_execution_target(strategy["runtime"]))
    data_target = normalized_target if normalized_target != "paper" else "binance:sandbox"
    frame, _ = fetch_ohlcv_frame(data_target, strategy["marketType"], strategy["symbol"], strategy["interval"], 3)
    last_close = float(frame["close"].to_list()[-1])
    quantity = payload.quantity or float(strategy["parameters"].get("positionSizeUsd", 1000)) / max(last_close, 1e-8)
    requested_notional = quantity * last_close
    risk = evaluate_pre_trade_risk(strategy, requested_notional, payload.leverage)
    if not risk["allow"]:
        audit_event(user["id"], "execution.rejected", {"strategyId": strategy["id"], "brokerTarget": normalized_target, "breaches": risk["breaches"]})
        return {"accepted": False, "brokerTarget": normalized_target, "risk": risk}

    audit_event(user["id"], "execution.accepted", {"strategyId": strategy["id"], "brokerTarget": normalized_target, "side": payload.side, "quantity": quantity})
    if normalized_target == "paper":
        account = get_paper_account(user["id"])
        existing = next((item for item in account["positions"] if item["symbol"] == strategy["symbol"] and item["marketType"] == strategy["marketType"]), None)
        positions = [item for item in account["positions"] if not (item["symbol"] == strategy["symbol"] and item["marketType"] == strategy["marketType"])]
        next_qty = (existing["quantity"] if existing else 0.0) + (quantity if payload.side == "BUY" else -quantity)
        if abs(next_qty) > 1e-8:
            positions.append({"symbol": strategy["symbol"], "marketType": strategy["marketType"], "quantity": next_qty, "avgEntryPrice": last_close, "updatedAt": now_ms()})
        account["positions"] = positions
        account["balanceUsd"] = float(account["balanceUsd"]) - (requested_notional if payload.side == "BUY" else -requested_notional)
        account["updatedAt"] = now_ms()
        save_paper_account(account)
        result = {"accepted": True, "brokerTarget": "paper", "broker": "Paper", "fillPrice": last_close, "quantity": quantity, "updatedAccount": account}
        audit_event(user["id"], "execution.sent", result)
        return result

    credentials_map = resolve_broker_credentials(user["id"], normalized_target)
    if not credentials_map:
        raise HTTPException(status_code=400, detail=f"Missing broker credentials for {normalized_target}")
    client = create_exchange_client(broker_id, strategy["marketType"], credentials_map, broker_mode)
    market_symbol = resolve_market_symbol(client, broker_id, strategy["marketType"], strategy["symbol"])
    try:
        extra_params = {"tdMode": "cross"} if broker_id == "okx" and strategy["marketType"] != "spot" else {}
        order = client.create_order(market_symbol, "market", payload.side.lower(), float(quantity), None, extra_params)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    result = {"accepted": True, "brokerTarget": normalized_target, "broker": get_broker_label(normalized_target), "orderResult": order}
    audit_event(user["id"], "execution.sent", {"strategyId": strategy["id"], "brokerTarget": normalized_target, "orderResult": order})
    return result


@app.get("/research/modules")
def research_modules(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return [
        {"id": "research", "label": "Research", "capabilities": ["strategy registry", "factor research", "alpha experiments"]},
        {"id": "simulation", "label": "Simulation", "capabilities": ["vectorbt backtests", "parameter sweeps", "historical replay"]},
    ]


@app.get("/research/strategies")
def research_strategies(authorization: str | None = Header(default=None)):
    require_user(authorization)
    ensure_default_strategies()
    return [get_strategy_summary(item) for item in list_strategies()]


@app.post("/research/strategies")
def research_save_strategy(payload: StrategyRequest, authorization: str | None = Header(default=None)):
    return save_strategy(payload, authorization)


@app.get("/research/backtests")
def research_backtests(strategyId: str | None = None, authorization: str | None = Header(default=None)):
    return list_backtests(strategyId=strategyId, authorization=authorization)


@app.get("/portfolio/modules")
def portfolio_modules(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return [{"id": "portfolio", "label": "Portfolio", "capabilities": ["paper accounts", "allocation views", "exposure oversight"]}]


@app.get("/portfolio/account")
def portfolio_account(authorization: str | None = Header(default=None)):
    return paper_account(authorization)


@app.get("/governance/modules")
def governance_modules(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return [{"id": "governance", "label": "Governance", "capabilities": ["credential storage", "audit trail", "broker controls"]}]


@app.get("/governance/brokers")
def governance_brokers(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return BROKER_SUMMARIES


@app.get("/governance/credentials")
def governance_credentials(authorization: str | None = Header(default=None)):
    return credentials(authorization)


@app.post("/governance/credentials")
def governance_create_credential(payload: CredentialRequest, authorization: str | None = Header(default=None)):
    return create_credential(payload, authorization)


@app.get("/governance/audit")
def governance_audit(authorization: str | None = Header(default=None)):
    return audit(authorization)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"message": exc.detail})


def run() -> None:
    uvicorn.run("python_services.main:app", host="127.0.0.1", port=APP_PORT, reload=False)


if __name__ == "__main__":
    run()
