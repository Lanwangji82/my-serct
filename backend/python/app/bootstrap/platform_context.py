from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any

try:
    from .platform_registry import build_broker_summaries
    from ..adapters.interfaces import CachedJsonLoader, DocumentDatabase, JsonCache
    from pymongo import MongoClient
except ImportError:
    try:
        from platform_registry import build_broker_summaries
    except ImportError:
        build_broker_summaries = None  # type: ignore[assignment]
    try:
        from adapters.interfaces import CachedJsonLoader, DocumentDatabase, JsonCache
    except ImportError:
        CachedJsonLoader = Any  # type: ignore[assignment]
        DocumentDatabase = Any  # type: ignore[assignment]
        JsonCache = Any  # type: ignore[assignment]
    MongoClient = None  # type: ignore[assignment]

try:
    import redis
except ImportError:
    redis = None  # type: ignore[assignment]


def load_local_env() -> None:
    current = Path(__file__).resolve()
    roots = [current.parent.parent.parent.parent, current.parent.parent.parent]
    for root in roots:
        for filename in (".env", ".env.local"):
            env_path = root / filename
            if not env_path.exists():
                continue
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.lstrip("\ufeff").strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.lstrip("\ufeff").strip()
                value = value.strip().strip("'").strip('"')
                if key:
                    os.environ[key] = value


def now_ms() -> int:
    return int(time.time() * 1000)


def create_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PlatformStorageBundle:
    db: DocumentDatabase
    redis_cache: JsonCache
    cached_json: CachedJsonLoader
    requested_storage_backend_label: str
    active_storage_backend_label: str
    redis_url: str

    @property
    def storage_backend_label(self) -> str:
        return self.active_storage_backend_label

    def build_runtime_status(self, *, database_path: str) -> dict[str, Any]:
        redis_enabled = bool(getattr(self.redis_cache, "enabled", False))
        redis_configured = bool(self.redis_url)
        active_mode = f"{self.active_storage_backend_label.title()} + Redis" if redis_enabled else f"{self.active_storage_backend_label.title()} only"
        fallback_active = self.requested_storage_backend_label != self.active_storage_backend_label
        return {
            "requestedBackend": self.requested_storage_backend_label,
            "activeBackend": self.active_storage_backend_label,
            "fallbackActive": fallback_active,
            "modeLabel": active_mode,
            "databasePath": database_path,
            "redis": {
                "configured": redis_configured,
                "enabled": redis_enabled,
                "label": "Redis-compatible cache" if redis_enabled else "Redis unavailable",
            },
        }


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
            "marketSnapshots": [],
            "intelligenceSnapshots": [],
        }

    def read(self) -> dict[str, Any]:
        with self.lock:
            try:
                with self.path.open("r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                    if isinstance(payload, dict):
                        defaults = self.default_state()
                        return {**defaults, **payload}
                    return self.default_state()
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

    def set_if_absent(self, key: str, value: str, ttl_ms: int) -> bool:
        if not self.enabled or self.client is None:
            return False
        try:
            return bool(self.client.set(key, value, nx=True, px=max(ttl_ms, 1)))
        except Exception:
            return False

    def enqueue_json(self, key: str, value: Any) -> None:
        if not self.enabled or self.client is None:
            return
        try:
            self.client.rpush(key, json.dumps(value, ensure_ascii=False))
        except Exception:
            pass

    def dequeue_json(self, key: str) -> Any | None:
        if not self.enabled or self.client is None:
            return None
        try:
            payload = self.client.lpop(key)
            return json.loads(payload) if payload else None
        except Exception:
            return None

    def list_length(self, key: str) -> int:
        if not self.enabled or self.client is None:
            return 0
        try:
            return int(self.client.llen(key))
        except Exception:
            return 0

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


class NamespacedCacheLoader:
    def __init__(self, *, redis_cache: RedisCache, cache_prefix: str):
        self.redis_cache = redis_cache
        self.cache_prefix = cache_prefix

    def __call__(self, key: str, ttl_ms: int, loader) -> Any:
        namespaced_key = self.cache_prefix + key
        cached = self.redis_cache.get_json(namespaced_key)
        if cached is not None:
            return cached
        value = loader()
        self.redis_cache.set_json(namespaced_key, value, ttl_ms)
        return value

    def invalidate(self, *keys: str) -> None:
        if not keys:
            return
        self.redis_cache.delete(*[self.cache_prefix + key for key in keys])


class MongoDb:
    collection_names = {
        "users": "users",
        "sessions": "sessions",
        "credentials": "credentials",
        "strategies": "strategies",
        "backtests": "backtests",
        "auditEvents": "audit_events",
        "paperAccounts": "paper_accounts",
        "marketSnapshots": "market_snapshots",
        "intelligenceSnapshots": "intelligence_snapshots",
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
        self._create_index("strategies", "id", unique=True)
        self._create_index("strategies", [("updatedAt", -1)])
        self._create_index("backtests", "id", unique=True)
        self._create_index("backtests", [("strategyId", 1), ("updatedAt", -1)])
        self._create_index("backtests", [("updatedAt", -1)])
        self._create_index("backtests", [("status", 1), ("updatedAt", -1)])
        self._create_index("backtests", [("startedAt", -1)])
        self._create_index("audit_events", "id", unique=True)
        self._create_index("audit_events", [("actorUserId", 1), ("createdAt", -1)])
        self._create_index("sessions", "token", unique=True)
        self._create_index("sessions", "expiresAt", expireAfterSeconds=0)
        self._create_index("users", "id", unique=True)
        self._create_index("users", "email", unique=True)
        self._create_index("market_snapshots", "id", unique=True)
        self._create_index("market_snapshots", [("updatedAt", -1)])
        self._create_index(
            "market_snapshots",
            [("market", 1), ("exchangeId", 1), ("symbol", 1), ("interval", 1), ("limit", 1)],
            unique=True,
        )
        self._create_index("intelligence_snapshots", "id", unique=True)
        self._create_index("intelligence_snapshots", [("snapshotType", 1), ("updatedAt", -1)])
        self._create_index("intelligence_snapshots", [("snapshotType", 1), ("market", 1), ("updatedAt", -1)])

    def _create_index(self, collection_name: str, keys, **kwargs) -> None:
        collection = self.database[collection_name]
        try:
            collection.create_index(keys, **kwargs)
        except Exception as exc:
            message = str(exc)
            if "IndexOptionsConflict" not in message and "equivalent index already exists" not in message:
                raise
            index_name = collection.create_index(keys)
            collection.drop_index(index_name)
            collection.create_index(keys, **kwargs)

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

    def count_collection(self, field: str, *, filter_query: dict[str, Any] | None = None) -> int:
        return int(self.database[self.collection_names[field]].count_documents(filter_query or {}))

    def delete_many(self, field: str, *, filter_query: dict[str, Any]) -> int:
        result = self.database[self.collection_names[field]].delete_many(filter_query)
        return int(result.deleted_count)


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


class BackgroundJobQueue:
    def __init__(self, redis_cache: RedisCache, queue_key: str):
        self.redis_cache = redis_cache
        self.queue_key = queue_key
        self._fallback_jobs: list[dict[str, Any]] = []
        self._fallback_lock = RLock()
        self._stats_lock = RLock()
        self._stats = {
            "enqueued": 0,
            "deduped": 0,
            "dequeued": 0,
            "lastEnqueuedAt": 0,
            "lastDequeuedAt": 0,
        }

    def enqueue_unique(self, dedupe_key: str, payload: dict[str, Any], ttl_ms: int = 30_000) -> bool:
        lock_key = f"{self.queue_key}:dedupe:{dedupe_key}"
        if self.redis_cache.set_if_absent(lock_key, "1", ttl_ms):
            self.redis_cache.enqueue_json(self.queue_key, payload)
            self._record_stat("enqueued", "lastEnqueuedAt")
            return True
        if self.redis_cache.enabled:
            self._record_stat("deduped")
            return False
        with self._fallback_lock:
            if any(job.get("_dedupe") == dedupe_key for job in self._fallback_jobs):
                self._record_stat("deduped")
                return False
            self._fallback_jobs.append({**payload, "_dedupe": dedupe_key})
            self._record_stat("enqueued", "lastEnqueuedAt")
            return True

    def pop(self) -> dict[str, Any] | None:
        payload = self.redis_cache.dequeue_json(self.queue_key)
        if payload is not None:
            self._record_stat("dequeued", "lastDequeuedAt")
            return payload
        with self._fallback_lock:
            if not self._fallback_jobs:
                return None
            payload = self._fallback_jobs.pop(0)
            self._record_stat("dequeued", "lastDequeuedAt")
            return payload

    def get_status(self) -> dict[str, Any]:
        with self._stats_lock, self._fallback_lock:
            return {
                **self._stats,
                "queueKey": self.queue_key,
                "redisEnabled": self.redis_cache.enabled,
                "queueLength": self.redis_cache.list_length(self.queue_key) if self.redis_cache.enabled else len(self._fallback_jobs),
                "fallbackQueueLength": len(self._fallback_jobs),
            }

    def _record_stat(self, counter_key: str, timestamp_key: str | None = None) -> None:
        with self._stats_lock:
            self._stats[counter_key] = int(self._stats.get(counter_key) or 0) + 1
            if timestamp_key:
                self._stats[timestamp_key] = now_ms()


class BackgroundWorker:
    def __init__(self, *, name: str, runner, interval_seconds: float = 0.5):
        self.name = name
        self.runner = runner
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._stats_lock = RLock()
        self._stats = {
            "running": False,
            "startedAt": 0,
            "lastHandledAt": 0,
            "lastIdleAt": 0,
            "lastErrorAt": 0,
            "lastError": "",
            "processedCount": 0,
            "idleCount": 0,
            "errorCount": 0,
        }

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        with self._stats_lock:
            self._stats["running"] = True
            self._stats["startedAt"] = now_ms()
            self._stats["lastError"] = ""
        self._thread = threading.Thread(target=self._loop, name=self.name, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        with self._stats_lock:
            self._stats["running"] = False

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                handled = bool(self.runner())
                if not handled:
                    with self._stats_lock:
                        self._stats["idleCount"] = int(self._stats["idleCount"]) + 1
                        self._stats["lastIdleAt"] = now_ms()
                    self._stop.wait(self.interval_seconds)
                else:
                    with self._stats_lock:
                        self._stats["processedCount"] = int(self._stats["processedCount"]) + 1
                        self._stats["lastHandledAt"] = now_ms()
            except Exception:
                with self._stats_lock:
                    self._stats["errorCount"] = int(self._stats["errorCount"]) + 1
                    self._stats["lastErrorAt"] = now_ms()
                    self._stats["lastError"] = "worker-loop-error"
                self._stop.wait(self.interval_seconds)

    def get_status(self) -> dict[str, Any]:
        with self._stats_lock:
            return {
                **self._stats,
                "name": self.name,
                "intervalSeconds": self.interval_seconds,
            }


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
    cache_loader = NamespacedCacheLoader(redis_cache=redis_cache, cache_prefix=cache_prefix)
    background_job_queue = BackgroundJobQueue(redis_cache, cache_prefix + "jobs:refresh")

    def invalidate_state_caches() -> None:
        redis_cache.clear_prefix(cache_prefix + "strategies:")
        redis_cache.clear_prefix(cache_prefix + "backtests:")
        redis_cache.clear_prefix(cache_prefix + "audit:")
        redis_cache.clear_prefix(cache_prefix + "sessions:")
        redis_cache.delete(cache_prefix + "runtime:connectivity")

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

    def create_storage_backend() -> tuple[DocumentDatabase, str]:
        if storage_backend == "mongo" and mongodb_uri:
            try:
                return InvalidatingMongoDb(mongodb_uri, mongodb_db_name), "mongo"
            except Exception:
                pass
        return InvalidatingJsonDb(db_path), "json"

    storage_db, active_storage_backend = create_storage_backend()

    storage_bundle = PlatformStorageBundle(
        db=storage_db,
        redis_cache=redis_cache,
        cached_json=cache_loader,
        requested_storage_backend_label=storage_backend,
        active_storage_backend_label=active_storage_backend,
        redis_url=redis_url,
    )

    return {
        "app_port": app_port,
        "storage_backend_label": storage_bundle.storage_backend_label,
        "db_path": db_path,
        "strategy_store_root": strategy_store_root,
        "backtest_store_root": backtest_store_root,
        "session_ttl_ms": session_ttl_ms,
        "local_mode": local_mode,
        "redis_cache": storage_bundle.redis_cache,
        "cached_json": storage_bundle.cached_json,
        "db": storage_bundle.db,
        "storage_bundle": storage_bundle,
        "background_job_queue": background_job_queue,
        "background_worker_factory": lambda runner: BackgroundWorker(name="quantx-refresh-worker", runner=runner),
        "now_ms": now_ms,
        "create_id": create_id,
        "sha256": sha256,
        "default_python_strategy": DEFAULT_PYTHON_STRATEGY,
        "broker_summaries": BROKER_SUMMARIES,
    }
