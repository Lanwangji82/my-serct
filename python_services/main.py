from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import secrets
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

try:
    from pymongo import MongoClient
except ImportError:
    MongoClient = None  # type: ignore[assignment]

try:
    import redis
except ImportError:
    redis = None  # type: ignore[assignment]

try:
    from .fmz_backtest import BacktestConfig as FmzBacktestConfig
    from .fmz_backtest import run_fmz_backtest
except ImportError:
    from fmz_backtest import BacktestConfig as FmzBacktestConfig
    from fmz_backtest import run_fmz_backtest


def load_local_env() -> None:
    root = Path(__file__).resolve().parent.parent
    for filename in (".env", ".env.local"):
        env_path = root / filename
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = value


load_local_env()


APP_PORT = int(os.getenv("PY_PLATFORM_PORT", "8800"))
DB_PATH = Path(os.getenv("PY_PLATFORM_DB_PATH", Path(__file__).resolve().parent / "data" / "platform_db.json"))
STRATEGY_STORE_ROOT = Path(os.getenv("PY_PLATFORM_STRATEGY_STORE", Path(__file__).resolve().parent / "strategy_store"))
BACKTEST_STORE_ROOT = Path(os.getenv("PY_PLATFORM_BACKTEST_STORE", Path(__file__).resolve().parent / "data" / "backtests"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
STRATEGY_STORE_ROOT.mkdir(parents=True, exist_ok=True)
BACKTEST_STORE_ROOT.mkdir(parents=True, exist_ok=True)
SESSION_TTL_MS = 1000 * 60 * 60 * 12
DEV_LOCAL_MODE = os.getenv("PY_PLATFORM_LOCAL_MODE", "1").lower() not in {"0", "false", "off"}
MONGODB_URI = (os.getenv("MONGODB_URI") or "").strip()
MONGODB_DB_NAME = (os.getenv("MONGODB_DB_NAME") or "quantx_platform").strip()
REDIS_URL = (os.getenv("REDIS_URL") or "").strip()
STORAGE_BACKEND = (os.getenv("PY_PLATFORM_STORAGE_BACKEND") or ("mongo" if MONGODB_URI else "json")).strip().lower()
CACHE_PREFIX = "quantx:platform:"

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


class JsonDb:
    def __init__(self, path: Path):
        self.path = path
        self.backup_path = self.path.with_suffix(f"{self.path.suffix}.bak")
        self.temp_path = self.path.with_suffix(f"{self.path.suffix}.tmp")
        self.lock = RLock()
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
            try:
                with self.path.open("r", encoding="utf-8") as handle:
                    return json.load(handle)
            except json.JSONDecodeError:
                if self.backup_path.exists():
                    try:
                        with self.backup_path.open("r", encoding="utf-8") as handle:
                            state = json.load(handle)
                        self._write_unlocked(state)
                        return state
                    except json.JSONDecodeError:
                        pass

                self._archive_corrupt_files()
                state = self.default_state()
                self._write_unlocked(state)
                return state

    def write(self, state: dict[str, Any]) -> None:
        with self.lock:
            self._write_unlocked(state)
            invalidate_state_caches()

    def update(self, fn):
        with self.lock:
            state = self.read()
            next_state = fn(state)
            self._write_unlocked(next_state)
            invalidate_state_caches()
            return next_state

    def _write_unlocked(self, state: dict[str, Any]) -> None:
        with self.temp_path.open("w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())

        if self.path.exists():
            self.path.replace(self.backup_path)
        self.temp_path.replace(self.path)

    def _archive_corrupt_files(self) -> None:
        timestamp = int(time.time() * 1000)
        if self.path.exists():
            self.path.replace(self.path.with_suffix(f"{self.path.suffix}.corrupt.{timestamp}"))
        if self.backup_path.exists():
            self.backup_path.replace(self.backup_path.with_suffix(f"{self.backup_path.suffix}.corrupt.{timestamp}"))

class RedisCache:
    def __init__(self, url: str):
        self.client = None
        self.enabled = False
        if not url or redis is None:
            return
        try:
            self.client = redis.Redis.from_url(url, decode_responses=True)
            self.client.ping()
            self.enabled = True
        except Exception:
            self.client = None
            self.enabled = False

    def get_json(self, key: str) -> Any | None:
        if not self.enabled or self.client is None:
            return None
        try:
            payload = self.client.get(CACHE_PREFIX + key)
            return json.loads(payload) if payload else None
        except Exception:
            return None

    def set_json(self, key: str, value: Any, ttl_ms: int) -> None:
        if not self.enabled or self.client is None:
            return
        try:
            self.client.set(CACHE_PREFIX + key, json.dumps(value, ensure_ascii=False), px=max(ttl_ms, 1))
        except Exception:
            pass

    def delete(self, *keys: str) -> None:
        if not self.enabled or self.client is None or not keys:
            return
        try:
            self.client.delete(*[CACHE_PREFIX + key for key in keys])
        except Exception:
            pass

    def clear_prefix(self, prefix: str) -> None:
        if not self.enabled or self.client is None:
            return
        try:
            for key in self.client.scan_iter(f"{CACHE_PREFIX}{prefix}*"):
                self.client.delete(key)
        except Exception:
            pass

    @contextmanager
    def lock(self, name: str, timeout: int = 10):
        if not self.enabled or self.client is None:
            yield
            return
        lock = self.client.lock(CACHE_PREFIX + "lock:" + name, timeout=timeout, blocking_timeout=max(timeout, 1))
        acquired = False
        try:
            acquired = bool(lock.acquire())
            yield
        finally:
            if acquired:
                try:
                    lock.release()
                except Exception:
                    pass


redis_cache = RedisCache(REDIS_URL)


def invalidate_state_caches() -> None:
    redis_cache.clear_prefix("strategies:")
    redis_cache.clear_prefix("backtests:")
    redis_cache.clear_prefix("audit:")
    redis_cache.clear_prefix("sessions:")
    redis_cache.delete("runtime:connectivity")


def cached_json(key: str, ttl_ms: int, loader) -> Any:
    cached = redis_cache.get_json(key)
    if cached is not None:
        return cached
    value = loader()
    redis_cache.set_json(key, value, ttl_ms)
    return value


class MongoDb:
    collection_names = {
        "users": "users",
        "sessions": "sessions",
        "credentials": "credentials",
        "strategies": "strategies",
        "backtests": "backtests",
        "auditEvents": "audit_events",
        "paperAccounts": "paper_accounts",
    }

    def __init__(self, uri: str, db_name: str):
        if MongoClient is None:
            raise RuntimeError("MongoDB 后端已启用，但未安装 pymongo。")
        self.client = MongoClient(uri, appname="quantx-platform")
        self.database = self.client[db_name]
        self.lock = RLock()
        self._ensure_indexes()

    @staticmethod
    def default_state() -> dict[str, Any]:
        return JsonDb.default_state()

    def _ensure_indexes(self) -> None:
        self.database["strategies"].create_index("id", unique=True)
        self.database["strategies"].create_index([("updatedAt", -1)])
        self.database["backtests"].create_index("id", unique=True)
        self.database["backtests"].create_index([("strategyId", 1), ("updatedAt", -1)])
        self.database["backtests"].create_index([("updatedAt", -1)])
        self.database["backtests"].create_index([("status", 1), ("updatedAt", -1)])
        self.database["backtests"].create_index([("startedAt", -1)])
        self.database["audit_events"].create_index("id", unique=True)
        self.database["audit_events"].create_index([("actorUserId", 1), ("createdAt", -1)])
        self.database["sessions"].create_index("token", unique=True)
        self.database["sessions"].create_index("expiresAt", expireAfterSeconds=0)
        self.database["users"].create_index("id", unique=True)
        self.database["users"].create_index("email", unique=True)

    def read(self) -> dict[str, Any]:
        with self.lock:
            state = self.default_state()
            for field, collection_name in self.collection_names.items():
                items = list(self.database[collection_name].find({}, {"_id": 0}))
                state[field] = items
            return state

    def write(self, state: dict[str, Any]) -> None:
        with self.lock, redis_cache.lock("storage-write"):
            self._write_unlocked(state)
            invalidate_state_caches()

    def update(self, fn):
        with self.lock, redis_cache.lock("storage-update"):
            state = self.read()
            next_state = fn(state)
            self._write_unlocked(next_state)
            invalidate_state_caches()
            return next_state

    def _write_unlocked(self, state: dict[str, Any]) -> None:
        for field, collection_name in self.collection_names.items():
            collection = self.database[collection_name]
            collection.delete_many({})
            items = state.get(field) or []
            if items:
                collection.insert_many([{**item, "_id": item.get("id") or f"{field}-{index}"} for index, item in enumerate(items)], ordered=False)

    def list_collection(self, field: str, *, sort: list[tuple[str, int]] | None = None, limit: int | None = None, filter_query: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        collection = self.database[self.collection_names[field]]
        cursor = collection.find(filter_query or {}, {"_id": 0})
        if sort:
            cursor = cursor.sort(sort)
        if limit is not None:
            cursor = cursor.limit(limit)
        return list(cursor)

    def find_one(self, field: str, filter_query: dict[str, Any]) -> dict[str, Any] | None:
        item = self.database[self.collection_names[field]].find_one(filter_query, {"_id": 0})
        return item

    def upsert_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None:
        collection = self.database[self.collection_names[field]]
        item_id = item.get(key)
        if not item_id:
            raise ValueError(f"{field} 缺少主键 {key}")
        collection.replace_one({key: item_id}, {**item, "_id": item_id}, upsert=True)
        invalidate_state_caches()

    def append_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None:
        self.upsert_one(field, item, key=key)

    def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None:
        collection = self.database[self.collection_names[field]]
        collection.delete_many({})
        if items:
            collection.insert_many([{**item, "_id": item.get(key) or f"{field}-{index}"} for index, item in enumerate(items)], ordered=False)
        invalidate_state_caches()


def create_storage_backend():
    if STORAGE_BACKEND == "mongo" and MONGODB_URI:
        try:
            return MongoDb(MONGODB_URI, MONGODB_DB_NAME)
        except Exception:
            pass
    return JsonDb(DB_PATH)


db = create_storage_backend()



DEFAULT_PYTHON_STRATEGY = "\n".join([
    '#!Python3',
    "'''backtest",
    'start: 2025-03-23 00:00:00',
    'end: 2026-03-21 08:00:00',
    'period: 4h',
    'basePeriod: 1h',
    'exchanges: [{"eid":"Futures_Binance","currency":"ETH_USDT","balance":10000}]',
    "'''",
    '',
    'FAST = 12',
    'SLOW = 26',
    'SIGNAL = 9',
    'POSITION_RISK = 0.10',
    'LEVERAGE = 5',
    'MIN_ORDER_AMOUNT = 0.01',
    '',
    'last_bar_time = 0',
    '',
    'def get_position(position_type):',
    '    positions = exchange.GetPosition()',
    '    if not positions:',
    '        return False, 0',
    '    for position in positions:',
    '        if position.get("Type") == position_type and float(position.get("Amount", 0)) > 0:',
    '            return True, float(position["Amount"])',
    '    return False, 0',
    '',
    'def get_available_usdt():',
    '    account = exchange.GetAccount()',
    '    if not account:',
    '        return 0',
    '    for asset in account.get("Assets", []):',
    '        if asset.get("Currency") == "USDT":',
    '            return float(asset.get("Amount", 0))',
    '    return float(account.get("Balance") or 0)',
    '',
    'def get_order_amount(records):',
    '    if not records:',
    '        return 0',
    '    available_usdt = get_available_usdt()',
    '    close_price = float(records[-1]["Close"])',
    '    if available_usdt <= 0 or close_price <= 0:',
    '        return 0',
    '    notional = available_usdt * POSITION_RISK * LEVERAGE',
    '    amount = round(notional / close_price, 3)',
    '    return amount if amount >= MIN_ORDER_AMOUNT else 0',
    '',
    'def get_cross_signal(records):',
    '    macd = TA.MACD(records, FAST, SLOW, SIGNAL)',
    '    dif = macd[0]',
    '    dea = macd[1]',
    '    if len(dif) < 2 or len(dea) < 2:',
    '        return False, False',
    '',
    '    prev_dif = dif[-2]',
    '    prev_dea = dea[-2]',
    '    curr_dif = dif[-1]',
    '    curr_dea = dea[-1]',
    '',
    '    golden_cross = prev_dif <= prev_dea and curr_dif > curr_dea',
    '    death_cross = prev_dif >= prev_dea and curr_dif < curr_dea',
    '    return golden_cross, death_cross',
    '',
    'def main():',
    '    global last_bar_time',
    '    exchange.SetContractType("swap")',
    '    exchange.SetMarginLevel(LEVERAGE)',
    '',
    '    while True:',
    '        records = exchange.GetRecords(PERIOD_H4)',
    '        if not records or len(records) < 100:',
    '            Sleep(2000)',
    '            continue',
    '',
    '        current_bar_time = records[-1]["Time"]',
    '        if current_bar_time == last_bar_time:',
    '            Sleep(2000)',
    '            continue',
    '',
    '        last_bar_time = current_bar_time',
    '        golden_cross, death_cross = get_cross_signal(records)',
    '        has_long, long_amount = get_position(PD_LONG)',
    '        has_short, short_amount = get_position(PD_SHORT)',
    '        order_amount = get_order_amount(records)',
    '',
    '        LogStatus("ETH 4h MACD Strategy\\n", "Golden:", golden_cross, " Death:", death_cross, "\\nHasLong:", has_long, " LongAmount:", long_amount, "\\nHasShort:", has_short, " ShortAmount:", short_amount, "\\nOrderAmount:", order_amount)',
    '',
    '        if golden_cross:',
    '            if has_short:',
    '                exchange.SetDirection("closesell")',
    '                exchange.Buy(-1, short_amount)',
    '                Log("MACD golden cross close short", records[-1]["Close"], short_amount)',
    '            if (not has_long) and order_amount > 0:',
    '                exchange.SetDirection("buy")',
    '                exchange.Buy(-1, order_amount)',
    '                Log("MACD golden cross open long", records[-1]["Close"], order_amount)',
    '        elif death_cross:',
    '            if has_long:',
    '                exchange.SetDirection("closebuy")',
    '                exchange.Sell(-1, long_amount)',
    '                Log("MACD death cross close long", records[-1]["Close"], long_amount)',
    '            if (not has_short) and order_amount > 0:',
    '                exchange.SetDirection("sell")',
    '                exchange.Sell(-1, order_amount)',
    '                Log("MACD death cross open short", records[-1]["Close"], order_amount)',
    '',
    '        Sleep(2000)',
])

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
BACKTEST_DETAIL_FIELDS = {"equityCurve", "trades", "marketRows", "logs", "assetRows"}
NON_PERSISTED_BACKTEST_FIELDS = {"rawResult"}
CONNECTIVITY_CACHE_TTL_MS = 30_000
_connectivity_cache: dict[str, Any] | None = None
_connectivity_cache_checked_at = 0
_connectivity_cache_lock = RLock()
_backtest_detail_lock = RLock()


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

    if not normalized.get("name") or looks_corrupted_text(normalized.get("name")):
        if template == "python":
            normalized["name"] = f"Python Strategy {symbol} {interval}".strip()
        else:
            normalized["name"] = f"Strategy {symbol} {interval}".strip()

    if not normalized.get("description") or looks_corrupted_text(normalized.get("description")):
        normalized["description"] = "Please document this strategy in your IDE workspace."

    return normalized


def strategy_artifact_exists(strategy: dict[str, Any]) -> bool:
    if strategy.get("template") != "python":
        return True
    artifact_summary = strategy.get("artifactSummary") or {}
    root_dir = artifact_summary.get("rootDir")
    if root_dir:
        return Path(root_dir).exists()
    strategy_name = str(strategy.get("name") or "").strip()
    if strategy_name:
        return (STRATEGY_STORE_ROOT / slugify_filename(strategy_name)).exists()
    return False


def prune_missing_strategy_artifacts(strategies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in strategies if strategy_artifact_exists(item)]


def ensure_bootstrap_user() -> dict[str, Any]:
    if isinstance(db, MongoDb):
        existing = db.list_collection("users", limit=1)
        if existing:
            return existing[0]
    else:
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
    if isinstance(db, MongoDb):
        db.upsert_one("users", user)
    else:
        db.update(lambda current: {**current, "users": [user, *current["users"]]})
    return user


def list_strategies() -> list[dict[str, Any]]:
    def load() -> list[dict[str, Any]]:
        if isinstance(db, MongoDb):
            raw_items = db.list_collection("strategies", sort=[("updatedAt", -1)])
        else:
            raw_items = db.read()["strategies"]
        strategies = prune_missing_strategy_artifacts([normalize_strategy_record(item) for item in raw_items])
        if strategies != raw_items:
            if isinstance(db, MongoDb):
                db.replace_collection("strategies", strategies)
            else:
                state = db.read()
                db.write({**state, "strategies": strategies})
        return sorted(strategies, key=lambda item: item["updatedAt"], reverse=True)

    return cached_json("strategies:list", 10_000, load)


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
    folder_name = slugify_filename(strategy_name)
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


def sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "email": user["email"], "roles": user["roles"], "createdAt": user["createdAt"]}


def require_user(authorization: str | None) -> dict[str, Any]:
    user = ensure_bootstrap_user()
    if DEV_LOCAL_MODE and (not authorization or not authorization.startswith("Bearer ")):
        return sanitize_user(user)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing session token")
    token = authorization[7:].strip()
    if isinstance(db, MongoDb):
        session = db.find_one("sessions", {"token": token, "expiresAt": {"$gt": now_ms()}})
    else:
        state = db.read()
        session = next((item for item in state["sessions"] if item["token"] == token and item["expiresAt"] > now_ms()), None)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    if isinstance(db, MongoDb):
        user = db.find_one("users", {"id": session["userId"]})
    else:
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
    if isinstance(db, MongoDb):
        db.append_one("auditEvents", event)
        items = db.list_collection("auditEvents", sort=[("createdAt", -1)])
        if len(items) > 500:
            db.replace_collection("auditEvents", items[:500])
    else:
        db.update(lambda current: {**current, "auditEvents": [event, *current["auditEvents"]][:500]})
    return event


def list_audit_events(user_id: str) -> list[dict[str, Any]]:
    return cached_json(
        f"audit:{user_id}",
        5000,
        lambda: (
            db.list_collection("auditEvents", sort=[("createdAt", -1)], limit=500, filter_query={"actorUserId": user_id})
            if isinstance(db, MongoDb)
            else sorted([item for item in db.read()["auditEvents"] if item["actorUserId"] == user_id], key=lambda item: item["createdAt"], reverse=True)
        ),
    )


def backtest_sort_key(item: dict[str, Any]) -> int:
    return int(item.get("completedAt") or item.get("startedAt") or item.get("queuedAt") or 0)


def backtest_detail_path(run_id: str) -> Path:
    return BACKTEST_STORE_ROOT / f"{run_id}.json"


def read_backtest_details(run_id: str) -> dict[str, Any]:
    path = backtest_detail_path(run_id)
    with _backtest_detail_lock:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            path.unlink(missing_ok=True)
            return {}


def write_backtest_details(run_id: str, details: dict[str, Any]) -> None:
    path = backtest_detail_path(run_id)
    payload = {key: value for key, value in details.items() if key in BACKTEST_DETAIL_FIELDS}
    with _backtest_detail_lock:
        if not any(payload.get(key) for key in BACKTEST_DETAIL_FIELDS):
            path.unlink(missing_ok=True)
            return
        temp_path = path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(path)


def split_backtest_record(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    details = {key: item.get(key) for key in BACKTEST_DETAIL_FIELDS if key in item}
    summary = {
        key: value
        for key, value in item.items()
        if key not in BACKTEST_DETAIL_FIELDS and key not in NON_PERSISTED_BACKTEST_FIELDS
    }
    summary["hasDetails"] = any(details.get(key) for key in BACKTEST_DETAIL_FIELDS)
    summary["detailCounts"] = {
        "equityCurve": len(details.get("equityCurve") or []),
        "trades": len(details.get("trades") or []),
        "marketRows": len(details.get("marketRows") or []),
        "logs": len(details.get("logs") or []),
        "assetRows": len(details.get("assetRows") or []),
    }
    return summary, details


def merge_backtest_record(summary: dict[str, Any]) -> dict[str, Any]:
    return {**summary, **read_backtest_details(summary["id"])}


def strip_backtest_details(item: dict[str, Any]) -> dict[str, Any]:
    compact = {key: value for key, value in item.items() if key not in BACKTEST_DETAIL_FIELDS}
    if "detailCounts" not in compact:
        compact["detailCounts"] = {
            "equityCurve": len(item.get("equityCurve") or []),
            "trades": len(item.get("trades") or []),
            "marketRows": len(item.get("marketRows") or []),
            "logs": len(item.get("logs") or []),
            "assetRows": len(item.get("assetRows") or []),
        }
    compact["hasDetails"] = bool(compact.get("hasDetails") or any(compact["detailCounts"].values()))
    return compact


def find_backtest_run(run_id: str) -> dict[str, Any] | None:
    def load() -> dict[str, Any] | None:
        if isinstance(db, MongoDb):
            summary = db.find_one("backtests", {"id": run_id})
        else:
            state = db.read()
            summary = next((item for item in state["backtests"] if item["id"] == run_id), None)
        return merge_backtest_record(summary) if summary else None

    return cached_json(f"backtests:detail:{run_id}", 5000, load)


def migrate_backtests_to_file_store() -> None:
    state = db.read()
    migrated = False
    summaries: list[dict[str, Any]] = []
    for item in state["backtests"]:
        if any(key in item for key in BACKTEST_DETAIL_FIELDS) or any(key in item for key in NON_PERSISTED_BACKTEST_FIELDS) or "detailCounts" not in item:
            summary, details = split_backtest_record(item)
            write_backtest_details(summary["id"], details)
            summaries.append(summary)
            migrated = True
        else:
            summaries.append(item)
    if migrated:
        db.write({**state, "backtests": summaries[:200]})


def collect_runtime_connectivity() -> dict[str, Any]:
    proxy_summary = get_proxy_runtime_summary()
    broker_checks: list[dict[str, Any]] = []
    broker_targets = ("okx:sandbox", "binance:sandbox", "binance:production", "okx:production")
    with ThreadPoolExecutor(max_workers=len(broker_targets)) as executor:
        futures = {executor.submit(measure_broker_latency, broker_target): broker_target for broker_target in broker_targets}
        for future in as_completed(futures):
            broker_target = futures[future]
            try:
                broker_checks.append(future.result())
            except Exception as exc:
                _, _, normalized = parse_broker_target(broker_target)
                broker_checks.append(
                    {
                        "brokerTarget": normalized,
                        "ok": False,
                        "error": str(exc),
                        "checkedAt": now_ms(),
                    }
                )
    broker_checks.sort(key=lambda item: item["brokerTarget"])
    return {
        "proxy": proxy_summary,
        "brokers": broker_checks,
        "checkedAt": now_ms(),
    }


def get_cached_runtime_connectivity(force_refresh: bool = False) -> dict[str, Any]:
    global _connectivity_cache, _connectivity_cache_checked_at
    with _connectivity_cache_lock:
        current = now_ms()
        if not force_refresh and _connectivity_cache and current - _connectivity_cache_checked_at < CONNECTIVITY_CACHE_TTL_MS:
            return _connectivity_cache
        if not force_refresh:
            cached = redis_cache.get_json("runtime:connectivity")
            if cached is not None:
                _connectivity_cache = cached
                _connectivity_cache_checked_at = current
                return cached
        snapshot = collect_runtime_connectivity()
        _connectivity_cache = snapshot
        _connectivity_cache_checked_at = current
        redis_cache.set_json("runtime:connectivity", snapshot, CONNECTIVITY_CACHE_TTL_MS)
        return snapshot


migrate_backtests_to_file_store()


def update_backtest_run(run_id: str, updater):
    if isinstance(db, MongoDb):
        summary = db.find_one("backtests", {"id": run_id})
        if not summary:
            return
        merged = merge_backtest_record(summary)
        next_item = updater(dict(merged))
        next_summary, details = split_backtest_record(next_item)
        write_backtest_details(run_id, details)
        db.upsert_one("backtests", next_summary)
        return

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        runs: list[dict[str, Any]] = []
        for item in current["backtests"]:
            if item["id"] == run_id:
                merged = merge_backtest_record(item)
                next_item = updater(dict(merged))
                summary, details = split_backtest_record(next_item)
                write_backtest_details(run_id, details)
                item = summary
            runs.append(item)
        return {**current, "backtests": runs[:200]}

    db.update(mutate)


def append_backtest_log(run_id: str, message: str, level: str = "system", progress_pct: int | None = None) -> None:
    timestamp = now_ms()

    def mutate(item: dict[str, Any]) -> dict[str, Any]:
        logs = list(item.get("logs") or [])
        logs.append({"time": timestamp, "level": level, "message": message})
        item["logs"] = logs[-300:]
        if progress_pct is not None:
            item["progressPct"] = progress_pct
        item["updatedAt"] = timestamp
        return item

    update_backtest_run(run_id, mutate)


def start_backtest_job(run_id: str, actor_user_id: str, strategy: dict[str, Any], payload: "BacktestRequest") -> None:
    def worker():
        append_backtest_log(run_id, "回测任务已创建，等待执行。", progress_pct=5)

        def set_running(item: dict[str, Any]) -> dict[str, Any]:
            started_at = now_ms()
            item["status"] = "running"
            item["startedAt"] = started_at
            item["progressPct"] = 10
            item["updatedAt"] = started_at
            return item

        update_backtest_run(run_id, set_running)
        append_backtest_log(run_id, "FMZ 本地回测引擎已启动。", progress_pct=12)

        _, _, config = build_backtest_contract(payload, strategy)

        try:
            run = run_fmz_backtest(
                strategy.get("sourceCode") or DEFAULT_PYTHON_STRATEGY,
                config,
                progress_callback=lambda progress, message: append_backtest_log(run_id, message, progress_pct=progress),
            )

            def finalize(item: dict[str, Any]) -> dict[str, Any]:
                completed_at = now_ms()
                logs = list(item.get("logs") or [])
                result_logs = list(run.get("logs") or [])
                item.update(run)
                item["status"] = "completed"
                item["progressPct"] = 100
                item["completedAt"] = completed_at
                item["updatedAt"] = completed_at
                item["logs"] = (logs + result_logs)[-300:]
                item["errorMessage"] = None
                return item

            update_backtest_run(run_id, finalize)
            append_backtest_log(run_id, "回测完成。", progress_pct=100)
            audit_event(actor_user_id, "backtest.run.completed", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": run_id})
        except Exception as exc:
            error_text = str(exc)

            def fail(item: dict[str, Any]) -> dict[str, Any]:
                failed_at = now_ms()
                item["status"] = "failed"
                item["errorMessage"] = error_text
                item["completedAt"] = failed_at
                item["updatedAt"] = failed_at
                item["progressPct"] = min(int(item.get("progressPct") or 0), 95)
                return item

            update_backtest_run(run_id, fail)
            append_backtest_log(run_id, f"回测失败：{error_text}", level="error")
            audit_event(actor_user_id, "backtest.run.failed", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": run_id, "error": error_text})

    Thread(target=worker, daemon=True).start()


def get_proxy_environment() -> dict[str, str]:
    explicit_http = (os.getenv("CCXT_HTTP_PROXY") or os.getenv("HTTP_PROXY") or "").strip()
    explicit_https = (os.getenv("CCXT_HTTPS_PROXY") or os.getenv("HTTPS_PROXY") or "").strip()
    explicit_socks = (os.getenv("CCXT_SOCKS_PROXY") or os.getenv("ALL_PROXY") or "").strip()
    system_proxies = urllib.request.getproxies()

    return {
        "httpProxy": explicit_http or str(system_proxies.get("http") or "").strip(),
        "httpsProxy": explicit_https or str(system_proxies.get("https") or "").strip(),
        "socksProxy": explicit_socks,
        "wsProxy": (os.getenv("CCXT_WS_PROXY") or "").strip(),
        "wssProxy": (os.getenv("CCXT_WSS_PROXY") or "").strip(),
        "proxySource": "explicit" if any((explicit_http, explicit_https, explicit_socks)) else ("system" if system_proxies else "none"),
    }

def get_proxy_runtime_summary() -> dict[str, Any]:
    raw_proxy = get_proxy_environment()
    active_mode = "none"
    active_value = ""
    if raw_proxy["socksProxy"]:
        active_mode = "socks"
        active_value = raw_proxy["socksProxy"]
    elif raw_proxy["httpsProxy"]:
        active_mode = "https"
        active_value = raw_proxy["httpsProxy"]
    elif raw_proxy["httpProxy"]:
        active_mode = "http"
        active_value = raw_proxy["httpProxy"]

    return {
        "configured": active_mode != "none",
        "mode": active_mode,
        "activeProxy": active_value,
        "source": raw_proxy.get("proxySource", "none"),
        "httpProxy": raw_proxy["httpProxy"],
        "httpsProxy": raw_proxy["httpsProxy"],
        "socksProxy": raw_proxy["socksProxy"],
        "wsProxy": raw_proxy["wsProxy"],
        "wssProxy": raw_proxy["wssProxy"],
    }


def build_urllib_opener() -> urllib.request.OpenerDirector:
    proxy_env = get_proxy_environment()
    proxies: dict[str, str] = {}
    if proxy_env["socksProxy"]:
        proxies["http"] = proxy_env["socksProxy"]
        proxies["https"] = proxy_env["socksProxy"]
    else:
        if proxy_env["httpProxy"]:
            proxies["http"] = proxy_env["httpProxy"]
        if proxy_env["httpsProxy"]:
            proxies["https"] = proxy_env["httpsProxy"]
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))


def fetch_json_via_http(url: str) -> dict[str, Any]:
    opener = build_urllib_opener()
    timeout_seconds = max(int(os.getenv("PLATFORM_HTTP_TIMEOUT_MS", "10000")) / 1000.0, 1.0)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "QuantX/0.1",
            "Accept": "application/json",
        },
    )
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {url}") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise RuntimeError(f"Network error: {reason}") from exc


BROKER_LATENCY_ENDPOINTS: dict[str, dict[str, str]] = {
    "binance:sandbox": {
        "url": "https://testnet.binancefuture.com/fapi/v1/time",
        "label": "Binance Sandbox",
    },
    "binance:production": {
        "url": "https://fapi.binance.com/fapi/v1/time",
        "label": "Binance Production",
    },
    "okx:sandbox": {
        "url": "https://www.okx.com/api/v5/public/time",
        "label": "OKX Sandbox",
    },
    "okx:production": {
        "url": "https://www.okx.com/api/v5/public/time",
        "label": "OKX Production",
    },
}


def parse_remote_time(normalized_target: str, payload: dict[str, Any]) -> int | None:
    if normalized_target.startswith("binance:"):
        server_time = payload.get("serverTime")
        return int(server_time) if server_time is not None else None
    if normalized_target.startswith("okx:"):
        data = payload.get("data") or []
        if data and isinstance(data[0], dict):
            ts = data[0].get("ts")
            return int(ts) if ts is not None else None
    return None


def measure_broker_latency(broker_target: str, market_type: str = "futures") -> dict[str, Any]:
    broker_id, broker_mode, normalized = parse_broker_target(broker_target)
    endpoint = BROKER_LATENCY_ENDPOINTS.get(normalized)
    if not endpoint:
        raise RuntimeError(f"Unsupported broker target: {normalized}")
    started_at = now_ms()
    started_perf = time.perf_counter()
    payload = fetch_json_via_http(endpoint["url"])
    latency_ms = round((time.perf_counter() - started_perf) * 1000, 2)
    remote_time = parse_remote_time(normalized, payload)
    return {
        "brokerTarget": normalized,
        "ok": True,
        "latencyMs": latency_ms,
        "remoteTime": remote_time,
        "label": endpoint["label"],
        "checkedAt": started_at,
    }
def compile_python_strategy(source_code: str) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    function_names: list[str] = []
    if not source_code.strip():
        return {"valid": False, "errors": ["\u6e90\u7801\u4e0d\u80fd\u4e3a\u7a7a"], "warnings": warnings, "functions": function_names}
    try:
        tree = ast.parse(source_code, filename="<strategy>")
        compile(source_code, "<strategy>", "exec")
        function_names = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
        if "main" not in function_names:
            errors.append("\u0046\u004d\u005a\u0020\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u7b56\u7565\u5fc5\u987b\u5b9a\u4e49\u0020\u006d\u0061\u0069\u006e\u0028\u0029\u0020\u5165\u53e3\u51fd\u6570")
        if "GetRecords" not in source_code:
            warnings.append("\u6ca1\u6709\u68c0\u6d4b\u5230\u0020\u0047\u0065\u0074\u0052\u0065\u0063\u006f\u0072\u0064\u0073\u0020\u8c03\u7528\uff0c\u8bf7\u786e\u8ba4\u7b56\u7565\u662f\u5426\u6309\u0020\u0046\u004d\u005a\u0020\u884c\u60c5\u8bfb\u53d6\u65b9\u5f0f\u7f16\u5199")
        if "exchange." not in source_code:
            warnings.append("\u6ca1\u6709\u68c0\u6d4b\u5230\u0020\u0065\u0078\u0063\u0068\u0061\u006e\u0067\u0065\u002e\u0020\u5bf9\u8c61\u8c03\u7528\uff0c\u8bf7\u786e\u8ba4\u7b56\u7565\u662f\u5426\u6309\u0020\u0046\u004d\u005a\u0020\u4ea4\u6613\u63a5\u53e3\u7f16\u5199")
    except SyntaxError as exc:
        errors.append(f"\u7b2c {exc.lineno} \u884c\u8bed\u6cd5\u9519\u8bef\uff1a{exc.msg}")
    except Exception as exc:
        errors.append(str(exc))
    return {"valid": not errors, "errors": errors, "warnings": warnings, "functions": function_names}


class LoginRequest(BaseModel):
    email: str
    password: str


class BacktestRequest(BaseModel):
    strategyId: str
    brokerTarget: str = "binance:production"
    startTime: str | None = "2025-01-01 00:00:00"
    endTime: str | None = "2026-03-21 08:00:00"
    period: str = "4h"
    basePeriod: str = "1h"
    mode: str = "模拟级"
    initialCapital: float = Field(default=10000, gt=0)
    quoteAsset: str = "USDT"
    tolerancePct: float = Field(default=50, ge=0)
    openFeePct: float = Field(default=0.03, ge=0)
    closeFeePct: float = Field(default=0.03, ge=0)
    slippagePoints: float = Field(default=0, ge=0)
    candleLimit: int = Field(default=300, ge=10, le=5000)
    chartDisplay: str = "显示"
    depthMin: int = Field(default=20, ge=1)
    depthMax: int = Field(default=200, ge=1)
    recordEvents: bool = False
    leverage: float | None = None
    chartBars: int = Field(default=3000, ge=200, le=10000)
    delayMs: int = Field(default=200, ge=0, le=5000)
    logLimit: int = Field(default=8000, ge=100, le=50000)
    profitLimit: int = Field(default=50000, ge=100, le=50000)
    dataSource: str = "默认"
    orderMode: str = "已成交"
    distributor: str = "本地回测引擎: Python3 - 12 vCPU / 4G RAM"


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
    if isinstance(db, MongoDb):
        user = db.find_one("users", {"email": payload.email.strip().lower()})
    else:
        state = db.read()
        user = next((item for item in state["users"] if item["email"] == payload.email.strip().lower()), None)
    if not user or user["passwordHash"] != sha256(payload.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    session = {"token": create_id("sess"), "userId": user["id"], "createdAt": now_ms(), "expiresAt": now_ms() + SESSION_TTL_MS}
    if isinstance(db, MongoDb):
        sessions = db.list_collection("sessions", filter_query={"expiresAt": {"$gt": now_ms()}}, sort=[("createdAt", -1)], limit=200)
        db.replace_collection("sessions", [*sessions, session])
    else:
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
    return [get_strategy_summary(item) for item in list_strategies()]


@app.post("/api/platform/strategies")
def save_strategy(payload: StrategyRequest, authorization: str | None = Header(default=None)):
    require_user(authorization)
    existing = next((item for item in list_strategies() if item["id"] == payload.id), None)
    timestamp = now_ms()
    compiler = None
    if payload.template == "python":
        compiler = compile_python_strategy(payload.sourceCode or "")
        if not compiler["valid"]:
            raise HTTPException(status_code=400, detail=f"\u0046\u004d\u005a\u0020\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u7b56\u7565\u7f16\u8bd1\u5931\u8d25\uff1a{'; '.join(compiler['errors'])}")
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
    if isinstance(db, MongoDb):
        db.upsert_one("strategies", strategy)
    else:
        db.update(lambda current: {**current, "strategies": [item for item in current["strategies"] if item["id"] != strategy["id"]] + [strategy]})
    return get_strategy_summary(strategy)


@app.post("/api/platform/strategies/compile")
def compile_strategy(payload: StrategyCompileRequest, authorization: str | None = Header(default=None)):
    require_user(authorization)
    result = compile_python_strategy(payload.sourceCode)
    return {**result, "checkedAt": now_ms()}


def build_backtest_contract(payload: BacktestRequest, strategy: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], FmzBacktestConfig]:
    effective_leverage = max(float(payload.leverage or strategy.get("risk", {}).get("maxLeverage") or 1), 1)
    params = {
        "strategyId": payload.strategyId,
        "brokerTarget": payload.brokerTarget,
        "startTime": payload.startTime,
        "endTime": payload.endTime,
        "period": payload.period,
        "basePeriod": payload.basePeriod,
        "mode": payload.mode,
        "initialCapital": payload.initialCapital,
        "quoteAsset": payload.quoteAsset,
        "tolerancePct": payload.tolerancePct,
        "openFeePct": payload.openFeePct,
        "closeFeePct": payload.closeFeePct,
        "slippagePoints": payload.slippagePoints,
        "candleLimit": payload.candleLimit,
        "chartDisplay": payload.chartDisplay,
        "depthMin": payload.depthMin,
        "depthMax": payload.depthMax,
        "recordEvents": payload.recordEvents,
        "chartBars": payload.chartBars,
        "delayMs": payload.delayMs,
        "logLimit": payload.logLimit,
        "profitLimit": payload.profitLimit,
        "dataSource": payload.dataSource,
        "orderMode": payload.orderMode,
        "distributor": payload.distributor,
        "leverage": effective_leverage,
        "symbol": strategy.get("symbol") or "ETHUSDT",
        "marketType": strategy.get("marketType") or "futures",
    }
    engine_config = {
        "brokerTarget": payload.brokerTarget,
        "symbol": params["symbol"],
        "marketType": params["marketType"],
        "period": payload.period,
        "basePeriod": payload.basePeriod,
        "startTime": payload.startTime,
        "endTime": payload.endTime,
        "mode": payload.mode,
        "quoteAsset": payload.quoteAsset,
        "tolerancePct": payload.tolerancePct,
        "candleLimit": payload.candleLimit,
        "chartDisplay": payload.chartDisplay,
        "depthMin": payload.depthMin,
        "depthMax": payload.depthMax,
        "recordEvents": payload.recordEvents,
        "dataSource": payload.dataSource,
        "orderMode": payload.orderMode,
        "distributor": payload.distributor,
        "leverage": effective_leverage,
        "slippagePoints": payload.slippagePoints,
        "logLimit": payload.logLimit,
        "profitLimit": payload.profitLimit,
        "chartBars": payload.chartBars,
        "delayMs": payload.delayMs,
        "initialCapital": payload.initialCapital,
        "openFeePct": payload.openFeePct,
        "closeFeePct": payload.closeFeePct,
    }
    config = FmzBacktestConfig(
        strategy_id=payload.strategyId,
        broker_target=payload.brokerTarget,
        symbol=params["symbol"],
        market_type=params["marketType"],
        period=payload.period or strategy.get("interval") or "4h",
        base_period=payload.basePeriod,
        start_time=payload.startTime,
        end_time=payload.endTime,
        mode=payload.mode,
        initial_capital=payload.initialCapital,
        quote_asset=payload.quoteAsset,
        tolerance_pct=payload.tolerancePct,
        open_fee_pct=payload.openFeePct,
        close_fee_pct=payload.closeFeePct,
        slippage_points=payload.slippagePoints,
        candle_limit=payload.candleLimit,
        chart_display=payload.chartDisplay,
        depth_min=payload.depthMin,
        depth_max=payload.depthMax,
        record_events=payload.recordEvents,
        leverage=effective_leverage,
        chart_bars=payload.chartBars,
        delay_ms=payload.delayMs,
        log_limit=payload.logLimit,
        profit_limit=payload.profitLimit,
        data_source=payload.dataSource,
        order_mode=payload.orderMode,
        distributor=payload.distributor,
    )
    return params, engine_config, config


@app.get("/api/platform/backtests")
def list_backtests(
    strategyId: str | None = None,
    includeDetails: bool = False,
    limit: int = 100,
    authorization: str | None = Header(default=None),
):
    require_user(authorization)
    normalized_limit = max(1, min(limit, 200))
    cache_key = f"backtests:list:{strategyId or 'all'}:{int(bool(includeDetails))}:{normalized_limit}"

    def load():
        if isinstance(db, MongoDb):
            filter_query = {"strategyId": strategyId} if strategyId else {}
            sorted_runs = db.list_collection("backtests", sort=[("updatedAt", -1)], limit=normalized_limit, filter_query=filter_query)
        else:
            state = db.read()
            runs = [item for item in state["backtests"] if not strategyId or item["strategyId"] == strategyId]
            sorted_runs = sorted(runs, key=backtest_sort_key, reverse=True)[: normalized_limit]
        if includeDetails:
            return [merge_backtest_record(item) for item in sorted_runs]
        return [strip_backtest_details(item) for item in sorted_runs]

    return cached_json(cache_key, 5000 if not includeDetails else 2000, load)


@app.get("/api/platform/backtests/{run_id}")
def get_backtest(run_id: str, authorization: str | None = Header(default=None)):
    require_user(authorization)
    run = find_backtest_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="未找到指定回测")
    return run


@app.get("/api/platform/backtests/{run_id}/status")
def get_backtest_status(run_id: str, authorization: str | None = Header(default=None)):
    require_user(authorization)
    run = find_backtest_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="未找到指定回测")
    return strip_backtest_details(run)


@app.post("/api/platform/backtests")
async def run_backtest(payload: BacktestRequest, authorization: str | None = Header(default=None)):
    actor = require_user(authorization)
    strategy = next((item for item in list_strategies() if item["id"] == payload.strategyId), None)
    if not strategy:
        raise HTTPException(status_code=404, detail="未找到指定策略")
    if strategy.get("template") != "python":
        raise HTTPException(status_code=400, detail="当前仅支持 FMZ Python 策略回测")

    queued_at = now_ms()
    params, engine_config, _ = build_backtest_contract(payload, strategy)
    result = {
        "id": create_id("bt"),
        "strategyId": payload.strategyId,
        "source": "fmz-official-local",
        "status": "queued",
        "progressPct": 0,
        "queuedAt": queued_at,
        "startedAt": None,
        "completedAt": None,
        "updatedAt": queued_at,
        "errorMessage": None,
        "params": params,
        "engineConfig": engine_config,
        "metrics": {
            "totalReturnPct": 0.0,
            "sharpe": 0.0,
            "maxDrawdownPct": 0.0,
            "winRatePct": 0.0,
            "trades": 0,
            "endingEquity": payload.initialCapital,
        },
        "equityCurve": [],
        "trades": [],
        "marketRows": [],
        "logs": [],
        "assetRows": [],
        "statusInfo": {
            "backtestStatus": 0,
            "finished": False,
            "progress": 0,
            "logsCount": 0,
            "loadBytes": 0,
            "loadElapsed": 0,
            "elapsed": 0,
            "lastPrice": 0,
            "equity": payload.initialCapital,
            "utilization": 0,
            "longAmount": 0,
            "shortAmount": 0,
            "estimatedProfit": 0,
            "tradeCount": 0,
            "mode": payload.mode,
            "quoteAsset": payload.quoteAsset,
            "tolerancePct": payload.tolerancePct,
            "candleLimit": payload.candleLimit,
            "chartDisplay": payload.chartDisplay,
            "depthMin": payload.depthMin,
            "depthMax": payload.depthMax,
            "recordEvents": payload.recordEvents,
            "leverage": params["leverage"],
            "chartBars": payload.chartBars,
            "delayMs": payload.delayMs,
            "logLimit": payload.logLimit,
            "profitLimit": payload.profitLimit,
            "dataSource": payload.dataSource,
            "orderMode": payload.orderMode,
        },
        "summary": {
            "barCount": 0,
            "orderCount": 0,
            "dataSource": "fmz-official-local-engine",
            "startedAtText": payload.startTime,
            "endedAtText": payload.endTime,
            "durationMs": 0,
            "period": payload.period,
            "basePeriod": payload.basePeriod,
            "mode": payload.mode,
            "quoteAsset": payload.quoteAsset,
            "tolerancePct": payload.tolerancePct,
            "candleLimit": payload.candleLimit,
            "chartDisplay": payload.chartDisplay,
            "depthMin": payload.depthMin,
            "depthMax": payload.depthMax,
            "recordEvents": payload.recordEvents,
            "leverage": params["leverage"],
            "chartBars": payload.chartBars,
            "delayMs": payload.delayMs,
            "logLimit": payload.logLimit,
            "profitLimit": payload.profitLimit,
            "orderMode": payload.orderMode,
        },
    }
    summary, details = split_backtest_record(result)
    write_backtest_details(summary["id"], details)
    if isinstance(db, MongoDb):
        db.upsert_one("backtests", summary)
    else:
        db.update(lambda current: {**current, "backtests": [summary, *current["backtests"]][:200]})
    audit_event(actor["id"], "backtest.run.queued", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": result["id"]})
    start_backtest_job(result["id"], actor["id"], strategy, payload)
    return strip_backtest_details(summary)


@app.get("/api/platform/runtime/connectivity")
def runtime_connectivity(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return get_cached_runtime_connectivity()


@app.get("/api/platform/runtime/latency")
def runtime_latency_test(brokerTarget: str, authorization: str | None = Header(default=None)):
    require_user(authorization)
    try:
        return measure_broker_latency(brokerTarget)
    except Exception as exc:
        _, _, normalized = parse_broker_target(brokerTarget)
        return {
            "brokerTarget": normalized,
            "ok": False,
            "error": str(exc),
            "checkedAt": now_ms(),
        }


@app.get("/api/platform/runtime/config")
def runtime_config(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return {
        "appPort": APP_PORT,
        "localMode": DEV_LOCAL_MODE,
        "databasePath": str(DB_PATH),
        "strategyStoreRoot": str(STRATEGY_STORE_ROOT),
        "proxy": get_proxy_runtime_summary(),
        "checkedAt": now_ms(),
    }


@app.get("/api/platform/audit")
def audit(authorization: str | None = Header(default=None)):
    user = require_user(authorization)
    return list_audit_events(user["id"])


@app.get("/research/modules")
def research_modules(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return [
        {"id": "research", "label": "Research", "capabilities": ["strategy registry", "factor research", "alpha experiments"]},
        {"id": "simulation", "label": "Local Validation", "capabilities": ["local backtests", "parameter sweeps", "historical replay"]},
        {"id": "operations", "label": "Operations", "capabilities": ["network checks", "deployment checklist", "runtime visibility"]},
    ]


@app.get("/research/strategies")
def research_strategies(authorization: str | None = Header(default=None)):
    require_user(authorization)
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
    return [{"id": "portfolio", "label": "Portfolio", "capabilities": ["allocation views", "exposure oversight", "runtime mix"]}]


@app.get("/governance/modules")
def governance_modules(authorization: str | None = Header(default=None)):
    require_user(authorization)
    return [{"id": "governance", "label": "Governance", "capabilities": ["audit trail", "configuration review", "runtime controls"]}]


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
