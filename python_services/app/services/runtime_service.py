from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import RLock
from typing import Any, Callable


class RuntimeService:
    def __init__(
        self,
        *,
        app_port: int,
        local_mode: bool,
        database_path: str,
        strategy_store_root: str,
        redis_cache: Any,
        now_ms: Callable[[], int],
        measure_broker_latency: Callable[[str], dict[str, Any]],
        parse_broker_target: Callable[[str], tuple[str, str, str]],
        network_runtime_adapter: Any,
        broker_target_catalog: list[dict[str, Any]],
        network_adapter_catalog: list[dict[str, Any]],
        broker_latency_provider_catalog: list[dict[str, Any]],
        data_provider_settings_getter: Callable[[], dict[str, Any]] | None = None,
        connectivity_cache_ttl_ms: int = 30_000,
    ) -> None:
        self.app_port = app_port
        self.local_mode = local_mode
        self.database_path = database_path
        self.strategy_store_root = strategy_store_root
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.measure_broker_latency = measure_broker_latency
        self.parse_broker_target = parse_broker_target
        self.network_runtime_adapter = network_runtime_adapter
        self.broker_target_catalog = broker_target_catalog
        self.network_adapter_catalog = network_adapter_catalog
        self.broker_latency_provider_catalog = broker_latency_provider_catalog
        self.data_provider_settings_getter = data_provider_settings_getter
        self.connectivity_cache_ttl_ms = connectivity_cache_ttl_ms
        self._connectivity_cache: dict[str, Any] | None = None
        self._connectivity_cache_checked_at = 0
        self._connectivity_cache_lock = RLock()

    def collect_runtime_connectivity(self) -> dict[str, Any]:
        proxy_summary = self.network_runtime_adapter.get_runtime_summary()
        broker_checks: list[dict[str, Any]] = []
        broker_targets = tuple(item["target"] for item in self.broker_target_catalog)
        with ThreadPoolExecutor(max_workers=len(broker_targets)) as executor:
            futures = {executor.submit(self.measure_broker_latency, broker_target): broker_target for broker_target in broker_targets}
            for future in as_completed(futures):
                broker_target = futures[future]
                try:
                    broker_checks.append(future.result())
                except Exception as exc:
                    _, _, normalized = self.parse_broker_target(broker_target)
                    broker_checks.append(
                        {
                            "brokerTarget": normalized,
                            "ok": False,
                            "error": str(exc),
                            "checkedAt": self.now_ms(),
                        }
                    )
        broker_checks.sort(key=lambda item: item["brokerTarget"])
        return {
            "proxy": proxy_summary,
            "brokers": broker_checks,
            "checkedAt": self.now_ms(),
        }

    def get_cached_runtime_connectivity(self, force_refresh: bool = False) -> dict[str, Any]:
        with self._connectivity_cache_lock:
            current = self.now_ms()
            if not force_refresh and self._connectivity_cache and current - self._connectivity_cache_checked_at < self.connectivity_cache_ttl_ms:
                return self._connectivity_cache
            if not force_refresh:
                cached = self.redis_cache.get_json("runtime:connectivity")
                if cached is not None:
                    self._connectivity_cache = cached
                    self._connectivity_cache_checked_at = current
                    return cached
            snapshot = self.collect_runtime_connectivity()
            self._connectivity_cache = snapshot
            self._connectivity_cache_checked_at = current
            self.redis_cache.set_json("runtime:connectivity", snapshot, self.connectivity_cache_ttl_ms)
            return snapshot

    def build_runtime_config(self) -> dict[str, Any]:
        data_providers = self.data_provider_settings_getter() if self.data_provider_settings_getter else {}
        return {
            "appPort": self.app_port,
            "localMode": self.local_mode,
            "databasePath": self.database_path,
            "strategyStoreRoot": self.strategy_store_root,
            "networkClients": self.network_runtime_adapter.get_network_client_settings(),
            "networkClientCatalog": self.network_runtime_adapter.get_network_client_settings().get("clientCatalog", []),
            "networkRouteCatalog": self.network_runtime_adapter.get_network_client_settings().get("routeCatalog", []),
            "networkAdapters": self.network_adapter_catalog,
            "brokerLatencyProviders": self.broker_latency_provider_catalog,
            "brokerTargets": self.broker_target_catalog,
            "dataProviders": data_providers,
            "proxy": self.network_runtime_adapter.get_runtime_summary(),
            "checkedAt": self.now_ms(),
        }

    def save_runtime_network_clients(self, payload: Any) -> dict[str, Any]:
        settings = self.network_runtime_adapter.save_network_client_settings(payload)
        data_providers = self.data_provider_settings_getter() if self.data_provider_settings_getter else {}
        return {
            "networkClients": settings,
            "appPort": self.app_port,
            "localMode": self.local_mode,
            "databasePath": self.database_path,
            "strategyStoreRoot": self.strategy_store_root,
            "networkClientCatalog": settings.get("clientCatalog", []),
            "networkRouteCatalog": settings.get("routeCatalog", []),
            "networkAdapters": self.network_adapter_catalog,
            "brokerLatencyProviders": self.broker_latency_provider_catalog,
            "brokerTargets": self.broker_target_catalog,
            "dataProviders": data_providers,
            "proxy": self.network_runtime_adapter.get_runtime_summary(),
            "checkedAt": self.now_ms(),
        }
