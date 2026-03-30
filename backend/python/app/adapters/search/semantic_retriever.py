from __future__ import annotations

import hashlib
import math
import re
from typing import Any, Callable


class LocalSemanticRetriever:
    def __init__(self, *, now_ms: Callable[[], int]) -> None:
        self.now_ms = now_ms
        self._documents_by_namespace: dict[str, list[dict[str, Any]]] = {}

    def get_status(self) -> dict[str, Any]:
        return {
            "mode": "local",
            "label": "本地混合检索",
            "milvusEnabled": False,
            "uriConfigured": False,
            "remoteReady": False,
            "collection": None,
            "checkedAt": self.now_ms(),
        }

    def index_documents(
        self,
        *,
        namespace: str,
        documents: list[dict[str, Any]],
    ) -> None:
        self._documents_by_namespace[namespace] = [dict(document) for document in documents]

    def search(
        self,
        *,
        query: str,
        namespace: str,
        documents: list[dict[str, Any]],
        limit: int,
    ) -> dict[str, Any]:
        normalized_query = query.strip()
        if not normalized_query:
            return {"mode": "hybrid_semantic", "items": []}
        source_documents = documents or self._documents_by_namespace.get(namespace, [])

        query_tokens = set(self._title_tokens(normalized_query))
        query_vector = self._semantic_vector(normalized_query)
        results: list[dict[str, Any]] = []
        for document in source_documents:
            metadata = dict(document.get("metadata") or {})
            title = str(metadata.get("title") or "")
            summary = str(metadata.get("summary") or "")
            tags = [str(tag) for tag in metadata.get("tags") or []]
            published_at = int(metadata.get("publishedAt") or 0)
            score = self._score_candidate(
                query_tokens=query_tokens,
                query_vector=query_vector,
                title=title,
                summary=summary,
                tags=tags,
                published_at=published_at,
            )
            if score <= 0:
                continue
            results.append(
                {
                    **metadata,
                    "id": document.get("id"),
                    "score": round(score, 4),
                    "searchMode": "hybrid",
                }
            )
        results.sort(key=lambda item: (-float(item.get("score") or 0), -int(item.get("publishedAt") or 0)))
        return {"mode": "hybrid_semantic", "items": results[: max(1, min(limit, 20))]}

    def _score_candidate(
        self,
        *,
        query_tokens: set[str],
        query_vector: dict[int, float],
        title: str,
        summary: str,
        tags: list[str],
        published_at: int,
    ) -> float:
        title_tokens = set(self._title_tokens(title))
        summary_tokens = set(self._title_tokens(summary))
        tag_tokens = {token for tag in tags for token in self._title_tokens(tag)}
        overlap_title = len(query_tokens & title_tokens)
        overlap_summary = len(query_tokens & summary_tokens)
        overlap_tags = len(query_tokens & tag_tokens)
        candidate_vector = self._semantic_vector(" ".join([title, summary, " ".join(tags)]))
        semantic_score = self._cosine_similarity(query_vector, candidate_vector)
        if overlap_title == 0 and overlap_summary == 0 and overlap_tags == 0 and semantic_score < 0.12:
            joined = " ".join([title.lower(), summary.lower(), " ".join(tag.lower() for tag in tags)])
            if query_tokens and not any(token in joined for token in query_tokens):
                return 0.0
        recency_bonus = 0.0
        if published_at > 0:
            age_hours = max((self.now_ms() - published_at) / 3_600_000, 0)
            recency_bonus = max(0.0, 0.5 - min(age_hours / 240, 0.5))
        lexical_score = overlap_title * 1.5 + overlap_summary * 0.8 + overlap_tags * 1.2
        return lexical_score + semantic_score * 3.0 + recency_bonus

    def _semantic_vector(self, value: str) -> dict[int, float]:
        terms = self._semantic_terms(value)
        vector: dict[int, float] = {}
        for term in terms:
            bucket = int(hashlib.sha1(term.encode("utf-8")).hexdigest(), 16) % 256
            vector[bucket] = vector.get(bucket, 0.0) + 1.0
        norm = math.sqrt(sum(weight * weight for weight in vector.values()))
        if norm <= 0:
            return {}
        return {bucket: weight / norm for bucket, weight in vector.items()}

    def _semantic_terms(self, value: str) -> list[str]:
        lowered = value.lower()
        tokens = self._title_tokens(lowered)
        cjk_chars = [char for char in lowered if "\u4e00" <= char <= "\u9fff"]
        bigrams = [f"{cjk_chars[index]}{cjk_chars[index + 1]}" for index in range(len(cjk_chars) - 1)]
        trigrams = [f"{cjk_chars[index]}{cjk_chars[index + 1]}{cjk_chars[index + 2]}" for index in range(len(cjk_chars) - 2)]
        return [*tokens, *bigrams, *trigrams]

    def _cosine_similarity(self, left: dict[int, float], right: dict[int, float]) -> float:
        if not left or not right:
            return 0.0
        if len(left) > len(right):
            left, right = right, left
        return sum(weight * right.get(bucket, 0.0) for bucket, weight in left.items())

    def _title_tokens(self, value: str) -> list[str]:
        normalized = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", value.lower())
        return [token for token in normalized.split() if len(token) >= 2]
