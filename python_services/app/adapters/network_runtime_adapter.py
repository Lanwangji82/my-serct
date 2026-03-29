from __future__ import annotations

from typing import Any

try:
    from .runtime_config_store import (
        NetworkClientSettingsPayload,
        get_network_client_proxy_environment,
        get_network_client_settings,
        get_proxy_runtime_summary,
        save_network_client_settings,
    )
except ImportError:
    from runtime_config_store import (
        NetworkClientSettingsPayload,
        get_network_client_proxy_environment,
        get_network_client_settings,
        get_proxy_runtime_summary,
        save_network_client_settings,
    )


class NetworkRuntimeConfigAdapter:
    payload_cls = NetworkClientSettingsPayload

    def get_network_client_settings(self) -> dict[str, Any]:
        return get_network_client_settings()

    def save_network_client_settings(self, payload: NetworkClientSettingsPayload) -> dict[str, Any]:
        return save_network_client_settings(payload)

    def get_runtime_summary(self) -> dict[str, Any]:
        return get_proxy_runtime_summary()

    def get_proxy_environment(self, broker_target: str | None = None) -> dict[str, str]:
        return get_network_client_proxy_environment(broker_target)
