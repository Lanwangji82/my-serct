from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI

try:
    from ..api.intelligence_routes import register_intelligence_routes
    from ..api.market_routes import register_market_routes
    from ..api.platform_routes import register_platform_routes
    from ..repositories.platform_repository import PlatformRepository
    from ..services.audit_service import AuditService
    from ..services.auth_service import AuthService
    from ..services.backtest_service import BacktestService
    from ..services.data_provider_service import DataProviderService
    from ..services.market_data_service import MarketDataService
    from ..services.market_intelligence_service import MarketIntelligenceService
    from ..services.runtime_service import RuntimeService
    from ..services.strategy_service import StrategyService
    from .platform_dependencies import PlatformAdapterBundle, PlatformServiceBundle
    from .platform_dependencies import create_platform_adapter_bundle, create_platform_service_bundle
    from .platform_context import create_platform_context
except ImportError:
    from api.intelligence_routes import register_intelligence_routes
    from api.market_routes import register_market_routes
    from api.platform_routes import register_platform_routes
    from repositories.platform_repository import PlatformRepository
    from services.audit_service import AuditService
    from services.auth_service import AuthService
    from services.backtest_service import BacktestService
    from services.data_provider_service import DataProviderService
    from services.market_data_service import MarketDataService
    from services.market_intelligence_service import MarketIntelligenceService
    from services.runtime_service import RuntimeService
    from services.strategy_service import StrategyService
    from platform_dependencies import PlatformAdapterBundle, PlatformServiceBundle
    from platform_dependencies import create_platform_adapter_bundle, create_platform_service_bundle
    from bootstrap.platform_context import create_platform_context


@dataclass(frozen=True)
class PlatformAppBundle:
    app: FastAPI
    app_port: int
    context: dict[str, Any]
    repository: PlatformRepository
    auth_service: AuthService
    audit_service: AuditService
    strategy_service: StrategyService
    backtest_service: BacktestService
    runtime_service: RuntimeService
    data_provider_service: DataProviderService
    market_data_service: MarketDataService
    market_intelligence_service: MarketIntelligenceService
    broker_latency_adapter: Any
    network_runtime_adapter: Any


def create_platform_app_bundle() -> PlatformAppBundle:
    context = create_platform_context()
    adapters = create_platform_adapter_bundle(context)
    services = create_platform_service_bundle(context, adapters)

    app = FastAPI(title="QuantX Python Platform", version="0.1.0")
    register_platform_routes(
        app,
        app_port=context["app_port"],
        broker_summaries=context["broker_summaries"],
        now_ms=context["now_ms"],
        auth_service=services.auth_service,
        audit_service=services.audit_service,
        strategy_service=services.strategy_service,
        backtest_service=services.backtest_service,
        runtime_service=services.runtime_service,
        data_provider_service=services.data_provider_service,
        broker_latency_adapter=adapters.broker_latency_adapter,
    )
    register_intelligence_routes(
        app,
        auth_service=services.auth_service,
        market_intelligence_service=services.market_intelligence_service,
    )
    register_market_routes(
        app,
        auth_service=services.auth_service,
        market_data_service=services.market_data_service,
    )

    return PlatformAppBundle(
        app=app,
        app_port=context["app_port"],
        context=context,
        repository=services.repository,
        auth_service=services.auth_service,
        audit_service=services.audit_service,
        strategy_service=services.strategy_service,
        backtest_service=services.backtest_service,
        runtime_service=services.runtime_service,
        data_provider_service=services.data_provider_service,
        market_data_service=services.market_data_service,
        market_intelligence_service=services.market_intelligence_service,
        broker_latency_adapter=adapters.broker_latency_adapter,
        network_runtime_adapter=adapters.network_runtime_adapter,
    )
