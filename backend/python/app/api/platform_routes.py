from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

try:
    from ..adapters.runtime.runtime_config_store import NetworkClientSettingsPayload
    from .schemas import BacktestRequest, LlmConfigRequest, LoginRequest, StrategyCompileRequest, StrategyRequest, TushareConfigRequest
except ImportError:
    from adapters.runtime.runtime_config_store import NetworkClientSettingsPayload
    from api.schemas import BacktestRequest, LlmConfigRequest, LoginRequest, StrategyCompileRequest, StrategyRequest, TushareConfigRequest


def register_platform_routes(
    app: FastAPI,
    *,
    app_port: int,
    broker_summaries: list[dict[str, Any]],
    now_ms,
    auth_service,
    audit_service,
    strategy_service,
    backtest_service,
    runtime_service,
    data_provider_service,
    broker_latency_adapter,
) -> None:
    @app.get("/health")
    def health():
        return {"status": "ok", "service": "python-platform", "port": app_port}

    @app.post("/api/platform/auth/login")
    def login(payload: LoginRequest):
        session, user = auth_service.login(payload.email, payload.password)
        audit_service.record(user["id"], "auth.login", {"email": user["email"]})
        return {"session": session, "user": user}

    @app.get("/api/platform/me")
    def me(authorization: str | None = Header(default=None)):
        return {"user": auth_service.require_user(authorization)}

    @app.get("/api/platform/brokers")
    def brokers(authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return broker_summaries

    @app.get("/api/platform/strategies")
    def strategies(authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return [strategy_service.get_strategy_summary(item) for item in strategy_service.list_strategies()]

    @app.post("/api/platform/strategies")
    def save_strategy(payload: StrategyRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        try:
            return strategy_service.save_strategy(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/platform/strategies/compile")
    def compile_strategy(payload: StrategyCompileRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        result = strategy_service.compile_python_strategy(payload.sourceCode)
        return {**result, "checkedAt": now_ms()}

    @app.get("/api/platform/backtests")
    def list_backtests(
        strategyId: str | None = None,
        includeDetails: bool = False,
        limit: int = 100,
        authorization: str | None = Header(default=None),
    ):
        auth_service.require_user(authorization)
        return backtest_service.list_backtests(
            strategy_id=strategyId,
            include_details=includeDetails,
            limit=limit,
        )

    @app.get("/api/platform/backtests/{run_id}")
    def get_backtest(run_id: str, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        run = backtest_service.find_backtest_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="未找到指定回测")
        return run

    @app.get("/api/platform/backtests/{run_id}/status")
    def get_backtest_status(run_id: str, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        run = backtest_service.find_backtest_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="未找到指定回测")
        return backtest_service.strip_backtest_details(run)

    @app.post("/api/platform/backtests")
    async def run_backtest(payload: BacktestRequest, authorization: str | None = Header(default=None)):
        actor = auth_service.require_user(authorization)
        strategy = next((item for item in strategy_service.list_strategies() if item["id"] == payload.strategyId), None)
        if not strategy:
            raise HTTPException(status_code=404, detail="未找到指定策略")
        if strategy.get("template") != "python":
            raise HTTPException(status_code=400, detail="当前仅支持 FMZ Python 策略回测")
        return backtest_service.queue_backtest(payload, actor["id"], strategy)

    @app.get("/api/platform/runtime/connectivity")
    def runtime_connectivity(forceRefresh: bool = False, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return runtime_service.get_cached_runtime_connectivity(force_refresh=forceRefresh)

    @app.get("/api/platform/runtime/latency")
    def runtime_latency_test(brokerTarget: str, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        try:
            return broker_latency_adapter.measure_broker_latency(brokerTarget)
        except Exception as exc:
            _, _, normalized = broker_latency_adapter.parse_broker_target(brokerTarget)
            return {
                "brokerTarget": normalized,
                "ok": False,
                "error": str(exc),
                "checkedAt": now_ms(),
            }

    @app.get("/api/platform/runtime/config")
    def runtime_config(authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return runtime_service.build_runtime_config()

    @app.get("/api/platform/runtime/operations")
    def runtime_operations(forceRefresh: bool = False, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return runtime_service.build_runtime_operations(force_refresh=forceRefresh)

    @app.post("/api/platform/runtime/network-clients")
    def save_runtime_network_clients(payload: NetworkClientSettingsPayload, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return runtime_service.save_runtime_network_clients(payload)

    @app.get("/api/platform/runtime/data-providers")
    def runtime_data_providers(authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return data_provider_service.build_data_provider_config()

    @app.post("/api/platform/runtime/data-providers/tushare")
    def save_tushare_provider(payload: TushareConfigRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return data_provider_service.save_tushare_settings(payload)

    @app.post("/api/platform/runtime/data-providers/tushare/validate")
    def validate_tushare_provider(payload: TushareConfigRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return data_provider_service.validate_tushare_settings(payload)

    @app.post("/api/platform/runtime/data-providers/llm")
    def save_llm_provider(payload: LlmConfigRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return data_provider_service.save_llm_settings(payload)

    @app.post("/api/platform/runtime/data-providers/llm/validate")
    def validate_llm_provider(payload: LlmConfigRequest, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return data_provider_service.validate_llm_settings(payload)

    @app.get("/api/platform/audit")
    def audit(authorization: str | None = Header(default=None)):
        user = auth_service.require_user(authorization)
        return audit_service.list_for_user(user["id"])

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"message": exc.detail})
