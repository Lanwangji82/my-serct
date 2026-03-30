from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Any, Callable, Protocol


class DocumentDatabase(Protocol):
    def read(self) -> dict[str, Any]: ...

    def write(self, state: dict[str, Any]) -> None: ...

    def update(self, fn: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]: ...

    def list_collection(
        self,
        field: str,
        *,
        sort: list[tuple[str, int]] | None = None,
        limit: int | None = None,
        filter_query: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]: ...

    def find_one(self, field: str, filter_query: dict[str, Any]) -> dict[str, Any] | None: ...

    def upsert_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None: ...

    def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None: ...

    def count_collection(self, field: str, *, filter_query: dict[str, Any] | None = None) -> int: ...

    def delete_many(self, field: str, *, filter_query: dict[str, Any]) -> int: ...


class JsonCache(Protocol):
    enabled: bool

    def get_json(self, key: str) -> Any | None: ...

    def set_json(self, key: str, value: Any, ttl_ms: int) -> None: ...

    def delete(self, *keys: str) -> None: ...

    def clear_prefix(self, prefix: str) -> None: ...

    def set_if_absent(self, key: str, value: str, ttl_ms: int) -> bool: ...

    def enqueue_json(self, key: str, value: Any) -> None: ...

    def dequeue_json(self, key: str) -> Any | None: ...

    def list_length(self, key: str) -> int: ...

    def lock(self, name: str, timeout: int = 10) -> AbstractContextManager[Any]: ...


class CachedJsonLoader(Protocol):
    def __call__(self, key: str, ttl_ms: int, loader: Callable[[], Any]) -> Any: ...


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


class MarketSeriesProvider(Protocol):
    def build_catalog_source(self, *, now_ms: int) -> dict[str, Any]: ...

    def build_market_catalog(self) -> dict[str, Any]: ...

    def build_market_board(self, **kwargs: Any) -> dict[str, Any]: ...

    def build_series(self, *, symbol: str, interval: str, limit: int) -> dict[str, Any]: ...


class AShareIntelligenceProviderProtocol(Protocol):
    def fetch_market_data(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Any]: ...

    def fetch_sector_pulse(self) -> tuple[list[dict[str, Any]], Any]: ...

    def fetch_theme_pulse(self) -> tuple[list[dict[str, Any]], Any]: ...


class CryptoIntelligenceProviderProtocol(Protocol):
    def fetch_assets(self) -> tuple[list[dict[str, Any]], Any]: ...

    def fetch_event_feed(self) -> tuple[list[dict[str, Any]], Any]: ...


class NewsGroupingProviderProtocol(Protocol):
    def fetch_news_groups(
        self,
        market: str,
        source_prefix: str,
        queries: Any,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[Any]]: ...

    def build_themes(self, headlines: list[dict[str, Any]], market: str) -> list[dict[str, Any]]: ...

    def get_default_queries(self, market: str) -> Any: ...


class SemanticSearchDocument(Protocol):
    id: str
    text: str
    metadata: dict[str, Any]


class SemanticRetriever(Protocol):
    def index_documents(
        self,
        *,
        namespace: str,
        documents: list[dict[str, Any]],
    ) -> None: ...

    def search(
        self,
        *,
        query: str,
        namespace: str,
        documents: list[dict[str, Any]],
        limit: int,
    ) -> dict[str, Any]: ...

    def get_status(self) -> dict[str, Any]: ...
