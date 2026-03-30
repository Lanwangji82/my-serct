from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class BrokerTargetSpec:
    target: str
    broker_id: str
    mode: str
    label: str
    supports_market_data: bool = True
    supports_execution: bool = True


@dataclass(frozen=True)
class NetworkAdapterSpec:
    adapter_id: str
    label: str
    kind: str
    configurable: bool
    description: str
    factory: Callable[[dict[str, Any]], Any]


@dataclass(frozen=True)
class BrokerLatencyProviderSpec:
    provider_id: str
    label: str
    supported_targets: tuple[str, ...]
    factory: Callable[..., Any]


@dataclass(frozen=True)
class NetworkClientSpec:
    client_id: str
    label: str
    default_port: int
    kind: str


NETWORK_CLIENT_SPECS: tuple[NetworkClientSpec, ...] = (
    NetworkClientSpec(client_id="auto", label="自动分流", default_port=7890, kind="smart"),
    NetworkClientSpec(client_id="jp", label="日本", default_port=7891, kind="regional"),
    NetworkClientSpec(client_id="sg", label="新加坡", default_port=7892, kind="regional"),
    NetworkClientSpec(client_id="us", label="美国", default_port=7893, kind="regional"),
    NetworkClientSpec(client_id="hk", label="香港", default_port=7894, kind="regional"),
    NetworkClientSpec(client_id="direct", label="直连", default_port=7895, kind="direct"),
)


BROKER_TARGET_SPECS: tuple[BrokerTargetSpec, ...] = (
    BrokerTargetSpec(
        target="binance:sandbox",
        broker_id="binance",
        mode="sandbox",
        label="Binance Sandbox",
    ),
    BrokerTargetSpec(
        target="binance:production",
        broker_id="binance",
        mode="production",
        label="Binance Production",
    ),
    BrokerTargetSpec(
        target="okx:sandbox",
        broker_id="okx",
        mode="sandbox",
        label="OKX Sandbox",
    ),
    BrokerTargetSpec(
        target="okx:production",
        broker_id="okx",
        mode="production",
        label="OKX Production",
    ),
)

NETWORK_ADAPTER_SPECS: tuple[NetworkAdapterSpec, ...] = (
    NetworkAdapterSpec(
        adapter_id="network-runtime-config",
        label="Network Runtime Config",
        kind="local-config",
        configurable=True,
        description="Loads local proxy and port routing from the shared runtime config store.",
        factory=lambda _context: _create_network_runtime_config_adapter(),
    ),
)

BROKER_LATENCY_PROVIDER_SPECS: tuple[BrokerLatencyProviderSpec, ...] = (
    BrokerLatencyProviderSpec(
        provider_id="default-http",
        label="Default HTTP Broker Latency",
        supported_targets=tuple(spec.target for spec in BROKER_TARGET_SPECS),
        factory=lambda *, context, network_runtime_adapter: _create_default_broker_latency_adapter(
            context=context,
            network_runtime_adapter=network_runtime_adapter,
        ),
    ),
)


def _create_network_runtime_config_adapter():
    try:
        from ..adapters.runtime.network_runtime_adapter import NetworkRuntimeConfigAdapter
    except ImportError:
        from adapters.runtime.network_runtime_adapter import NetworkRuntimeConfigAdapter
    return NetworkRuntimeConfigAdapter()


def _create_default_broker_latency_adapter(*, context: dict[str, Any], network_runtime_adapter: Any):
    try:
        from ..adapters.runtime.broker_latency_adapter import BrokerLatencyAdapter
    except ImportError:
        from adapters.runtime.broker_latency_adapter import BrokerLatencyAdapter
    return BrokerLatencyAdapter(
            now_ms=context["now_ms"],
            proxy_environment_resolver=network_runtime_adapter.get_proxy_environment,
    )


def build_broker_summaries() -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for spec in BROKER_TARGET_SPECS:
        existing = grouped.get(spec.broker_id)
        if existing is None:
            existing = {
                "brokerId": spec.broker_id,
                "label": spec.broker_id.upper() if spec.broker_id == "okx" else spec.broker_id.capitalize(),
                "supportsMarketData": spec.supports_market_data,
                "supportsExecution": spec.supports_execution,
                "targets": [],
            }
            grouped[spec.broker_id] = existing
        existing["supportsMarketData"] = existing["supportsMarketData"] or spec.supports_market_data
        existing["supportsExecution"] = existing["supportsExecution"] or spec.supports_execution
        existing["targets"].append(
            {
                "target": spec.target,
                "mode": spec.mode,
                "label": spec.label,
            }
        )
    return list(grouped.values())


def build_broker_target_catalog() -> list[dict[str, Any]]:
    return [
        {
            "target": spec.target,
            "brokerId": spec.broker_id,
            "mode": spec.mode,
            "label": spec.label,
            "supportsMarketData": spec.supports_market_data,
            "supportsExecution": spec.supports_execution,
        }
        for spec in BROKER_TARGET_SPECS
    ]


def build_network_adapter_catalog() -> list[dict[str, Any]]:
    return [
        {
            "adapterId": spec.adapter_id,
            "label": spec.label,
            "kind": spec.kind,
            "configurable": spec.configurable,
            "description": spec.description,
        }
        for spec in NETWORK_ADAPTER_SPECS
    ]


def build_network_client_catalog() -> list[dict[str, Any]]:
    return [
        {
            "clientId": spec.client_id,
            "label": spec.label,
            "defaultPort": spec.default_port,
            "kind": spec.kind,
        }
        for spec in NETWORK_CLIENT_SPECS
    ]


def build_network_route_catalog() -> list[dict[str, Any]]:
    return [
        {
            "routeId": "default",
            "label": "默认出口",
            "kind": "default",
        },
        *[
            {
                "routeId": summary["brokerId"],
                "label": summary["label"],
                "kind": "broker",
            }
            for summary in build_broker_summaries()
        ],
    ]


def build_broker_latency_provider_catalog() -> list[dict[str, Any]]:
    return [
        {
            "providerId": spec.provider_id,
            "label": spec.label,
            "supportedTargets": list(spec.supported_targets),
        }
        for spec in BROKER_LATENCY_PROVIDER_SPECS
    ]


def create_network_runtime_adapter(context: dict[str, Any], adapter_id: str = "network-runtime-config"):
    for spec in NETWORK_ADAPTER_SPECS:
        if spec.adapter_id == adapter_id:
            return spec.factory(context)
    raise ValueError(f"Unsupported network adapter: {adapter_id}")


def create_broker_latency_provider(
    *,
    context: dict[str, Any],
    network_runtime_adapter: Any,
    provider_id: str = "default-http",
):
    for spec in BROKER_LATENCY_PROVIDER_SPECS:
        if spec.provider_id == provider_id:
            return spec.factory(context=context, network_runtime_adapter=network_runtime_adapter)
    raise ValueError(f"Unsupported broker latency provider: {provider_id}")
