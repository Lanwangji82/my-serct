from __future__ import annotations

from typing import Any, Protocol


class NetworkRuntimeAdapter(Protocol):
    def get_runtime_summary(self) -> dict[str, Any]: ...

    def get_proxy_environment(self, broker_target: str | None = None) -> dict[str, str]: ...

    def get_network_client_settings(self) -> dict[str, Any]: ...

    def save_network_client_settings(self, payload: Any) -> dict[str, Any]: ...


class BrokerLatencyProvider(Protocol):
    def parse_broker_target(self, target: str | None) -> tuple[str, str, str]: ...

    def measure_broker_latency(self, broker_target: str, market_type: str = "futures") -> dict[str, Any]: ...

    def list_supported_targets(self) -> list[str]: ...


class NetworkRuntimeAdapterFactory(Protocol):
    def __call__(self, context: dict[str, Any]) -> NetworkRuntimeAdapter: ...


class BrokerLatencyProviderFactory(Protocol):
    def __call__(
        self,
        *,
        context: dict[str, Any],
        network_runtime_adapter: NetworkRuntimeAdapter,
    ) -> BrokerLatencyProvider: ...
