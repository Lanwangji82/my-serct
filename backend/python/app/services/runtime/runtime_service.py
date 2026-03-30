from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import RLock
from typing import Any, Callable

try:
    from ...adapters.interfaces import JsonCache
except ImportError:
    from backend.python.app.adapters.interfaces import JsonCache


class RuntimeService:
    def __init__(
        self,
        *,
        app_port: int,
        local_mode: bool,
        storage_backend_label: str,
        database_path: str,
        strategy_store_root: str,
        redis_cache: JsonCache,
        now_ms: Callable[[], int],
        measure_broker_latency: Callable[[str], dict[str, Any]],
        parse_broker_target: Callable[[str], tuple[str, str, str]],
        network_runtime_adapter: Any,
        broker_target_catalog: list[dict[str, Any]],
        network_adapter_catalog: list[dict[str, Any]],
        broker_latency_provider_catalog: list[dict[str, Any]],
        snapshot_repository: Any | None = None,
        refresh_scheduler_service: Any | None = None,
        background_job_queue: Any | None = None,
        background_worker_getter: Callable[[], Any] | None = None,
        data_provider_settings_getter: Callable[[], dict[str, Any]] | None = None,
        semantic_retriever_status_getter: Callable[[], dict[str, Any]] | None = None,
        intelligence_overview_getter: Callable[[bool], dict[str, Any]] | None = None,
        storage_runtime_status_getter: Callable[[], dict[str, Any]] | None = None,
        connectivity_cache_ttl_ms: int = 30_000,
    ) -> None:
        self.app_port = app_port
        self.local_mode = local_mode
        self.storage_backend_label = storage_backend_label
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
        self.snapshot_repository = snapshot_repository
        self.refresh_scheduler_service = refresh_scheduler_service
        self.background_job_queue = background_job_queue
        self.background_worker_getter = background_worker_getter
        self.data_provider_settings_getter = data_provider_settings_getter
        self.semantic_retriever_status_getter = semantic_retriever_status_getter
        self.intelligence_overview_getter = intelligence_overview_getter
        self.storage_runtime_status_getter = storage_runtime_status_getter
        self.connectivity_cache_ttl_ms = connectivity_cache_ttl_ms
        self._connectivity_cache: dict[str, Any] | None = None
        self._connectivity_cache_checked_at = 0
        self._connectivity_cache_lock = RLock()

    def build_storage_runtime_status(self) -> dict[str, Any]:
        status = self.storage_runtime_status_getter() if self.storage_runtime_status_getter else {}
        if status:
            return status
        redis_enabled = bool(getattr(self.redis_cache, "enabled", False))
        return {
            "requestedBackend": self.storage_backend_label,
            "activeBackend": self.storage_backend_label,
            "fallbackActive": False,
            "modeLabel": f"{self.storage_backend_label.title()} + Redis" if redis_enabled else f"{self.storage_backend_label.title()} only",
            "databasePath": self.database_path,
            "redis": {
                "configured": redis_enabled,
                "enabled": redis_enabled,
                "label": "Redis-compatible cache" if redis_enabled else "Redis unavailable",
            },
        }

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
        semantic_retrieval = self.semantic_retriever_status_getter() if self.semantic_retriever_status_getter else {}
        network_client_settings = self.network_runtime_adapter.get_network_client_settings()
        storage = self.build_storage_runtime_status()
        return {
            "appPort": self.app_port,
            "localMode": self.local_mode,
            "databasePath": self.database_path,
            "strategyStoreRoot": self.strategy_store_root,
            "networkClients": network_client_settings,
            "networkClientCatalog": network_client_settings.get("clientCatalog", []),
            "networkRouteCatalog": network_client_settings.get("routeCatalog", []),
            "networkAdapters": self.network_adapter_catalog,
            "brokerLatencyProviders": self.broker_latency_provider_catalog,
            "brokerTargets": self.broker_target_catalog,
            "dataProviders": data_providers,
            "semanticRetrieval": semantic_retrieval,
            "storage": storage,
            "proxy": self.network_runtime_adapter.get_runtime_summary(),
            "checkedAt": self.now_ms(),
        }

    def build_runtime_operations(self, *, force_refresh: bool = False) -> dict[str, Any]:
        data_providers = self.data_provider_settings_getter() if self.data_provider_settings_getter else {}
        semantic_retrieval = self.semantic_retriever_status_getter() if self.semantic_retriever_status_getter else {}
        storage = self.build_storage_runtime_status()
        overview = self.intelligence_overview_getter(force_refresh) if self.intelligence_overview_getter else {}
        connectivity = self.get_cached_runtime_connectivity(force_refresh=force_refresh)
        source_checks = [
            {
                "sourceId": str(item.get("sourceId") or ""),
                "label": str(item.get("label") or ""),
                "ok": bool(item.get("ok")),
                "detail": str(item.get("detail") or ""),
                "updatedAt": int(item.get("updatedAt") or 0),
            }
            for item in (overview.get("sources") or [])
            if item.get("sourceId")
        ]

        provider_checks = []
        tushare = data_providers.get("tushare", {}) if isinstance(data_providers, dict) else {}
        if tushare:
            status = tushare.get("status", {}) if isinstance(tushare.get("status"), dict) else {}
            provider_checks.append(
                {
                    "providerId": "tushare",
                    "label": "Tushare Pro",
                    "ok": bool(status.get("ok")) if tushare.get("enabled") else False,
                    "configured": bool(tushare.get("configured")),
                    "enabled": bool(tushare.get("enabled")),
                    "message": str(status.get("message") or ("已配置 Tushare Token。" if tushare.get("configured") else "未配置 Tushare Token。")),
                    "checkedAt": int(status.get("checkedAt") or 0),
                }
            )

        llm = data_providers.get("llm", {}) if isinstance(data_providers, dict) else {}
        if llm:
            status = llm.get("status", {}) if isinstance(llm.get("status"), dict) else {}
            provider_checks.append(
                {
                    "providerId": "llm",
                    "label": "LLM 新闻分析",
                    "ok": bool(status.get("ok")) if llm.get("enabled") else False,
                    "configured": bool(llm.get("configured")),
                    "enabled": bool(llm.get("enabled")),
                    "message": str(status.get("message") or ("LLM 新闻分析已启用。" if llm.get("enabled") else "未配置 LLM API，将回退到系统规则过滤。")),
                    "checkedAt": int(status.get("checkedAt") or 0),
                }
            )

        snapshot_status = self.snapshot_repository.build_snapshot_status() if self.snapshot_repository is not None else {}
        return {
            "checkedAt": self.now_ms(),
            "proxy": connectivity.get("proxy") or self.network_runtime_adapter.get_runtime_summary(),
            "connectivity": connectivity,
            "providerChecks": provider_checks,
            "semanticRetrieval": semantic_retrieval,
            "storage": storage,
            "eventSourceChecks": source_checks,
            "snapshotStatus": snapshot_status,
        }

    def save_runtime_network_clients(self, payload: Any) -> dict[str, Any]:
        settings = self.network_runtime_adapter.save_network_client_settings(payload)
        data_providers = self.data_provider_settings_getter() if self.data_provider_settings_getter else {}
        semantic_retrieval = self.semantic_retriever_status_getter() if self.semantic_retriever_status_getter else {}
        storage = self.build_storage_runtime_status()
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
            "semanticRetrieval": semantic_retrieval,
            "storage": storage,
            "proxy": self.network_runtime_adapter.get_runtime_summary(),
            "checkedAt": self.now_ms(),
        }
