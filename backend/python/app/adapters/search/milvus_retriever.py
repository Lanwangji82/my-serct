from __future__ import annotations

import hashlib
import os
from typing import Any, Callable

from .semantic_retriever import LocalSemanticRetriever


class MilvusSemanticRetriever:
    def __init__(
        self,
        *,
        now_ms: Callable[[], int],
        uri: str = "",
        token: str = "",
        collection_name: str = "market_intelligence",
        enabled: bool = True,
    ) -> None:
        self.now_ms = now_ms
        self.uri = uri.strip()
        self.token = token.strip()
        self.collection_name = collection_name
        self.enabled = bool(enabled and self.uri)
        self.fallback = LocalSemanticRetriever(now_ms=now_ms)
        self.client = None
        self._remote_ready = False
        if self.enabled:
            self._try_init_client()

    @property
    def remote_ready(self) -> bool:
        return bool(self._remote_ready and self.client is not None)

    def get_status(self) -> dict[str, Any]:
        return {
            "mode": "milvus" if self.remote_ready else "local",
            "label": "Milvus 向量检索" if self.remote_ready else "本地混合检索",
            "milvusEnabled": bool(self.enabled),
            "uriConfigured": bool(self.uri),
            "remoteReady": self.remote_ready,
            "collection": self.collection_name,
            "checkedAt": self.now_ms(),
        }

    def index_documents(
        self,
        *,
        namespace: str,
        documents: list[dict[str, Any]],
    ) -> None:
        self.fallback.index_documents(namespace=namespace, documents=documents)
        if not self.remote_ready or not documents:
            return
        rows = []
        for document in documents:
            metadata = dict(document.get("metadata") or {})
            vector = self._semantic_vector(str(document.get("text") or ""))
            rows.append(
                {
                    "id": str(document.get("id") or ""),
                    "namespace": namespace,
                    "text": str(document.get("text") or ""),
                    "vector": vector,
                    "metadata": metadata,
                    "updatedAt": int(metadata.get("publishedAt") or self.now_ms()),
                }
            )
        if not rows:
            return
        try:
            self.client.upsert(collection_name=self.collection_name, data=rows)
        except Exception:
            self._remote_ready = False

    def search(
        self,
        *,
        query: str,
        namespace: str,
        documents: list[dict[str, Any]],
        limit: int,
    ) -> dict[str, Any]:
        if not self.remote_ready:
            return self.fallback.search(query=query, namespace=namespace, documents=documents, limit=limit)

        try:
            vector = self._semantic_vector(query)
            search_kwargs: dict[str, Any] = {
                "collection_name": self.collection_name,
                "data": [vector],
                "limit": max(1, min(limit, 20)),
                "output_fields": ["metadata"],
            }
            if namespace:
                search_kwargs["filter"] = f'namespace == "{namespace}"'
            rows = self.client.search(**search_kwargs)
            items = []
            for row in (rows[0] if rows else []):
                metadata = dict(row.get("entity", {}).get("metadata") or {})
                items.append(
                    {
                        **metadata,
                        "id": row.get("id"),
                        "score": round(float(row.get("distance") or 0), 4),
                        "searchMode": "milvus",
                    }
                )
            return {"mode": "milvus", "items": items}
        except Exception:
            self._remote_ready = False
            return self.fallback.search(query=query, namespace=namespace, documents=documents, limit=limit)

    def _try_init_client(self) -> None:
        try:
            from pymilvus import MilvusClient  # type: ignore
        except Exception:
            self.client = None
            self._remote_ready = False
            return
        try:
            kwargs: dict[str, Any] = {"uri": self.uri}
            if self.token:
                kwargs["token"] = self.token
            self.client = MilvusClient(**kwargs)
            self._ensure_collection()
            self._remote_ready = True
        except Exception:
            self.client = None
            self._remote_ready = False

    def _ensure_collection(self) -> None:
        if self.client is None:
            return
        try:
            if self.client.has_collection(collection_name=self.collection_name):
                return
        except Exception:
            pass
        self.client.create_collection(
            collection_name=self.collection_name,
            dimension=256,
            primary_field_name="id",
            id_type="string",
            vector_field_name="vector",
            auto_id=False,
            enable_dynamic_field=True,
        )

    def _semantic_vector(self, value: str) -> list[float]:
        terms = self._semantic_terms(value)
        buckets = [0.0] * 256
        for term in terms:
            bucket = int(hashlib.sha1(term.encode("utf-8")).hexdigest(), 16) % 256
            buckets[bucket] += 1.0
        norm = sum(weight * weight for weight in buckets) ** 0.5
        if norm <= 0:
            return buckets
        return [weight / norm for weight in buckets]

    def _semantic_terms(self, value: str) -> list[str]:
        return self.fallback._semantic_terms(value)


def build_semantic_retriever(*, now_ms: Callable[[], int]) -> Any:
    uri = os.getenv("MILVUS_URI", "").strip()
    token = os.getenv("MILVUS_TOKEN", "").strip()
    enabled = os.getenv("MILVUS_ENABLED", "0").strip() in {"1", "true", "TRUE", "yes", "on"}
    collection_name = os.getenv("MILVUS_COLLECTION_MARKET_INTELLIGENCE", "market_intelligence").strip() or "market_intelligence"
    retriever = MilvusSemanticRetriever(
        now_ms=now_ms,
        uri=uri,
        token=token,
        collection_name=collection_name,
        enabled=enabled,
    )
    if retriever.remote_ready:
        return retriever
    return retriever
