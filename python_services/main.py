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
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

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


db = JsonDb(DB_PATH)



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


def list_strategies() -> list[dict[str, Any]]:
    state = db.read()
    strategies = prune_missing_strategy_artifacts([normalize_strategy_record(item) for item in state["strategies"]])
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


def backtest_sort_key(item: dict[str, Any]) -> int:
    return int(item.get("completedAt") or item.get("startedAt") or item.get("queuedAt") or 0)


def update_backtest_run(run_id: str, updater):
    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        runs: list[dict[str, Any]] = []
        for item in current["backtests"]:
            if item["id"] == run_id:
                item = updater(dict(item))
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
def list_backtests(strategyId: str | None = None, authorization: str | None = Header(default=None)):
    require_user(authorization)
    state = db.read()
    runs = [item for item in state["backtests"] if not strategyId or item["strategyId"] == strategyId]
    return sorted(runs, key=backtest_sort_key, reverse=True)


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
    state = db.read()
    state["backtests"] = [result, *state["backtests"]][:200]
    db.write(state)
    audit_event(actor["id"], "backtest.run.queued", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": result["id"]})
    start_backtest_job(result["id"], actor["id"], strategy, payload)
    return result


@app.get("/api/platform/runtime/connectivity")
def runtime_connectivity(authorization: str | None = Header(default=None)):
    require_user(authorization)
    proxy_summary = get_proxy_runtime_summary()
    broker_checks: list[dict[str, Any]] = []
    for broker_target in ("okx:sandbox", "binance:sandbox", "binance:production", "okx:production"):
        try:
            broker_checks.append(measure_broker_latency(broker_target))
        except Exception as exc:
            _, _, normalized = parse_broker_target(broker_target)
            broker_checks.append({
                "brokerTarget": normalized,
                "ok": False,
                "error": str(exc),
                "checkedAt": now_ms(),
            })
    return {
        "proxy": proxy_summary,
        "brokers": broker_checks,
        "checkedAt": now_ms(),
    }


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
