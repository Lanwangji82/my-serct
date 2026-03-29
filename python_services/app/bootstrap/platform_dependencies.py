from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

try:
    from ..adapters.data_provider_store import (
        build_llm_validation_preview,
        build_tushare_validation_preview,
        get_data_provider_settings,
        save_llm_settings,
        save_tushare_settings,
        validate_llm_settings,
        validate_tushare_settings,
    )
    from ..adapters.interfaces import BrokerLatencyProvider, NetworkRuntimeAdapter
    from ..repositories.platform_repository import PlatformRepository
    from ..services.audit_service import AuditService
    from ..services.auth_service import AuthService
    from ..services.backtest_service import BacktestService
    from ..services.data_provider_service import DataProviderService
    from ..services.market_data_service import MarketDataService
    from ..services.market_intelligence_service import MarketIntelligenceService
    from ..services.runtime_service import RuntimeService
    from ..services.strategy_service import StrategyService
    from .platform_registry import (
        build_broker_latency_provider_catalog,
        build_broker_target_catalog,
        build_network_adapter_catalog,
        create_broker_latency_provider,
        create_network_runtime_adapter,
    )
    from ...fmz_backtest import BacktestConfig as FmzBacktestConfig
    from ...fmz_backtest import run_fmz_backtest
except ImportError:
    from adapters.data_provider_store import (
        build_llm_validation_preview,
        build_tushare_validation_preview,
        get_data_provider_settings,
        save_llm_settings,
        save_tushare_settings,
        validate_llm_settings,
        validate_tushare_settings,
    )
    from adapters.interfaces import BrokerLatencyProvider, NetworkRuntimeAdapter
    from repositories.platform_repository import PlatformRepository
    from services.audit_service import AuditService
    from services.auth_service import AuthService
    from services.backtest_service import BacktestService
    from services.data_provider_service import DataProviderService
    from services.market_data_service import MarketDataService
    from services.market_intelligence_service import MarketIntelligenceService
    from services.runtime_service import RuntimeService
    from services.strategy_service import StrategyService
    from platform_registry import (
        build_broker_latency_provider_catalog,
        build_broker_target_catalog,
        build_network_adapter_catalog,
        create_broker_latency_provider,
        create_network_runtime_adapter,
    )
    from fmz_backtest import BacktestConfig as FmzBacktestConfig
    from fmz_backtest import run_fmz_backtest


CONNECTIVITY_CACHE_TTL_MS = 30_000


@dataclass(frozen=True)
class PlatformAdapterBundle:
    broker_latency_adapter: BrokerLatencyProvider
    network_runtime_adapter: NetworkRuntimeAdapter


@dataclass(frozen=True)
class PlatformServiceBundle:
    repository: PlatformRepository
    auth_service: AuthService
    audit_service: AuditService
    strategy_service: StrategyService
    backtest_service: BacktestService
    runtime_service: RuntimeService
    data_provider_service: DataProviderService
    market_data_service: MarketDataService
    market_intelligence_service: MarketIntelligenceService


def create_platform_adapter_bundle(context: dict[str, Any]) -> PlatformAdapterBundle:
    network_runtime_adapter = create_network_runtime_adapter(context)
    broker_latency_adapter = create_broker_latency_provider(
        context=context,
        network_runtime_adapter=network_runtime_adapter,
    )
    return PlatformAdapterBundle(
        broker_latency_adapter=broker_latency_adapter,
        network_runtime_adapter=network_runtime_adapter,
    )


def create_platform_service_bundle(
    context: dict[str, Any],
    adapters: PlatformAdapterBundle,
) -> PlatformServiceBundle:
    repository = PlatformRepository(context["db"])

    strategy_service = StrategyService(
        db=repository,
        strategy_store_root=context["strategy_store_root"],
        default_python_strategy=context["default_python_strategy"],
        now_ms=context["now_ms"],
        create_id=context["create_id"],
        cached_json=context["cached_json"],
    )

    auth_service = AuthService(
        repository=repository,
        now_ms=context["now_ms"],
        create_id=context["create_id"],
        sha256=context["sha256"],
        local_mode=context["local_mode"],
        session_ttl_ms=context["session_ttl_ms"],
        bootstrap_email=os.getenv("AUTH_BOOTSTRAP_EMAIL", "admin@quantx.local").strip().lower(),
        bootstrap_password=os.getenv("AUTH_BOOTSTRAP_PASSWORD", "quantx-admin"),
    )

    audit_service = AuditService(
        repository=repository,
        cached_json=context["cached_json"],
        create_id=context["create_id"],
        now_ms=context["now_ms"],
    )

    backtest_service = BacktestService(
        db=repository,
        backtest_store_root=context["backtest_store_root"],
        cached_json=context["cached_json"],
        now_ms=context["now_ms"],
        create_id=context["create_id"],
        audit_event=audit_service.record,
        run_fmz_backtest=run_fmz_backtest,
        fmz_backtest_config_cls=FmzBacktestConfig,
        default_python_strategy=context["default_python_strategy"],
    )
    backtest_service.migrate_backtests_to_file_store()

    runtime_service = RuntimeService(
        app_port=context["app_port"],
        local_mode=context["local_mode"],
        database_path=str(context["db_path"]),
        strategy_store_root=str(context["strategy_store_root"]),
        redis_cache=context["redis_cache"],
        now_ms=context["now_ms"],
        measure_broker_latency=adapters.broker_latency_adapter.measure_broker_latency,
        parse_broker_target=adapters.broker_latency_adapter.parse_broker_target,
        network_runtime_adapter=adapters.network_runtime_adapter,
        broker_target_catalog=build_broker_target_catalog(),
        network_adapter_catalog=build_network_adapter_catalog(),
        broker_latency_provider_catalog=build_broker_latency_provider_catalog(),
        data_provider_settings_getter=get_data_provider_settings,
        connectivity_cache_ttl_ms=CONNECTIVITY_CACHE_TTL_MS,
    )

    data_provider_service = DataProviderService(
        app_port=context["app_port"],
        local_mode=context["local_mode"],
        database_path=str(context["db_path"]),
        strategy_store_root=str(context["strategy_store_root"]),
        runtime_summary_getter=adapters.network_runtime_adapter.get_runtime_summary,
        provider_settings_getter=get_data_provider_settings,
        save_tushare_settings=save_tushare_settings,
        validate_tushare_settings=validate_tushare_settings,
        build_tushare_validation_preview=build_tushare_validation_preview,
        save_llm_settings=save_llm_settings,
        validate_llm_settings=validate_llm_settings,
        build_llm_validation_preview=build_llm_validation_preview,
        now_ms=context["now_ms"],
    )

    market_data_service = MarketDataService(
        redis_cache=context["redis_cache"],
        now_ms=context["now_ms"],
        network_runtime_adapter=adapters.network_runtime_adapter,
    )

    market_intelligence_service = MarketIntelligenceService(
        redis_cache=context["redis_cache"],
        now_ms=context["now_ms"],
    )

    return PlatformServiceBundle(
        repository=repository,
        auth_service=auth_service,
        audit_service=audit_service,
        strategy_service=strategy_service,
        backtest_service=backtest_service,
        runtime_service=runtime_service,
        data_provider_service=data_provider_service,
        market_data_service=market_data_service,
        market_intelligence_service=market_intelligence_service,
    )
