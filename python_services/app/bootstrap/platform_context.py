from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any

try:
    from .platform_registry import build_broker_summaries
    from pymongo import MongoClient
except ImportError:
    try:
        from platform_registry import build_broker_summaries
    except ImportError:
        build_broker_summaries = None  # type: ignore[assignment]
    MongoClient = None  # type: ignore[assignment]

try:
    import redis
except ImportError:
    redis = None  # type: ignore[assignment]


def load_local_env() -> None:
    root = Path(__file__).resolve().parent.parent.parent
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
            if key:
                os.environ[key] = value


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

    def update(self, fn):
        with self.lock:
            state = self.read()
            next_state = fn(state)
            self._write_unlocked(next_state)
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
            payload = self.client.get(key)
            return json.loads(payload) if payload else None
        except Exception:
            return None

    def set_json(self, key: str, value: Any, ttl_ms: int) -> None:
        if not self.enabled or self.client is None:
            return
        try:
            self.client.set(key, json.dumps(value, ensure_ascii=False), px=max(ttl_ms, 1))
        except Exception:
            pass

    def delete(self, *keys: str) -> None:
        if not self.enabled or self.client is None or not keys:
            return
        try:
            self.client.delete(*keys)
        except Exception:
            pass

    def clear_prefix(self, prefix: str) -> None:
        if not self.enabled or self.client is None:
            return
        try:
            for key in self.client.scan_iter(f"{prefix}*"):
                self.client.delete(key)
        except Exception:
            pass

    @contextmanager
    def lock(self, name: str, timeout: int = 10):
        if not self.enabled or self.client is None:
            yield
            return
        lock = self.client.lock(name, timeout=timeout, blocking_timeout=max(timeout, 1))
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
            raise RuntimeError("MongoDB backend enabled but pymongo is not installed.")
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
        with self.lock:
            self._write_unlocked(state)

    def update(self, fn):
        with self.lock:
            state = self.read()
            next_state = fn(state)
            self._write_unlocked(next_state)
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
        return self.database[self.collection_names[field]].find_one(filter_query, {"_id": 0})

    def upsert_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None:
        collection = self.database[self.collection_names[field]]
        item_id = item.get(key)
        if not item_id:
            raise ValueError(f"{field} missing primary key {key}")
        collection.replace_one({key: item_id}, {**item, "_id": item_id}, upsert=True)

    def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None:
        collection = self.database[self.collection_names[field]]
        collection.delete_many({})
        if items:
            collection.insert_many([{**item, "_id": item.get(key) or f"{field}-{index}"} for index, item in enumerate(items)], ordered=False)


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


BROKER_SUMMARIES = build_broker_summaries() if build_broker_summaries else []


def create_platform_context() -> dict[str, Any]:
    load_local_env()

    app_port = int(os.getenv("PY_PLATFORM_PORT", "8800"))
    db_path = Path(os.getenv("PY_PLATFORM_DB_PATH", Path(__file__).resolve().parent.parent.parent / "data" / "platform_db.json"))
    strategy_store_root = Path(os.getenv("PY_PLATFORM_STRATEGY_STORE", Path(__file__).resolve().parent.parent.parent / "strategy_store"))
    backtest_store_root = Path(os.getenv("PY_PLATFORM_BACKTEST_STORE", Path(__file__).resolve().parent.parent.parent / "data" / "backtests"))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    strategy_store_root.mkdir(parents=True, exist_ok=True)
    backtest_store_root.mkdir(parents=True, exist_ok=True)

    session_ttl_ms = 1000 * 60 * 60 * 12
    local_mode = os.getenv("PY_PLATFORM_LOCAL_MODE", "1").lower() not in {"0", "false", "off"}
    mongodb_uri = (os.getenv("MONGODB_URI") or "").strip()
    mongodb_db_name = (os.getenv("MONGODB_DB_NAME") or "quantx_platform").strip()
    redis_url = (os.getenv("REDIS_URL") or "").strip()
    storage_backend = (os.getenv("PY_PLATFORM_STORAGE_BACKEND") or ("mongo" if mongodb_uri else "json")).strip().lower()
    cache_prefix = "quantx:platform:"

    redis_cache = RedisCache(redis_url)

    def invalidate_state_caches() -> None:
        redis_cache.clear_prefix(cache_prefix + "strategies:")
        redis_cache.clear_prefix(cache_prefix + "backtests:")
        redis_cache.clear_prefix(cache_prefix + "audit:")
        redis_cache.clear_prefix(cache_prefix + "sessions:")
        redis_cache.delete(cache_prefix + "runtime:connectivity")

    def cached_json(key: str, ttl_ms: int, loader) -> Any:
        namespaced_key = cache_prefix + key
        cached = redis_cache.get_json(namespaced_key)
        if cached is not None:
            return cached
        value = loader()
        redis_cache.set_json(namespaced_key, value, ttl_ms)
        return value

    class InvalidatingJsonDb(JsonDb):
        def write(self, state: dict[str, Any]) -> None:
            super().write(state)
            invalidate_state_caches()

        def update(self, fn):
            result = super().update(fn)
            invalidate_state_caches()
            return result

    class InvalidatingMongoDb(MongoDb):
        def write(self, state: dict[str, Any]) -> None:
            with self.lock, redis_cache.lock(cache_prefix + "lock:storage-write"):
                self._write_unlocked(state)
                invalidate_state_caches()

        def update(self, fn):
            with self.lock, redis_cache.lock(cache_prefix + "lock:storage-update"):
                state = self.read()
                next_state = fn(state)
                self._write_unlocked(next_state)
                invalidate_state_caches()
                return next_state

        def upsert_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None:
            super().upsert_one(field, item, key=key)
            invalidate_state_caches()

        def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None:
            super().replace_collection(field, items, key=key)
            invalidate_state_caches()

    def create_storage_backend():
        if storage_backend == "mongo" and mongodb_uri:
            try:
                return InvalidatingMongoDb(mongodb_uri, mongodb_db_name)
            except Exception:
                pass
        return InvalidatingJsonDb(db_path)

    return {
        "app_port": app_port,
        "db_path": db_path,
        "strategy_store_root": strategy_store_root,
        "backtest_store_root": backtest_store_root,
        "session_ttl_ms": session_ttl_ms,
        "local_mode": local_mode,
        "redis_cache": redis_cache,
        "cached_json": cached_json,
        "db": create_storage_backend(),
        "now_ms": now_ms,
        "create_id": create_id,
        "sha256": sha256,
        "default_python_strategy": DEFAULT_PYTHON_STRATEGY,
        "broker_summaries": BROKER_SUMMARIES,
    }
