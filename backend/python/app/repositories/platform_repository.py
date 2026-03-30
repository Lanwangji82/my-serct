from __future__ import annotations

from typing import Any

try:
    from ..adapters.interfaces import DocumentDatabase
except ImportError:
    from backend.python.app.adapters.interfaces import DocumentDatabase


class PlatformRepository:
    def __init__(self, db: DocumentDatabase) -> None:
        self.db = db

    def read(self) -> dict[str, Any]:
        return self.db.read()

    def write(self, state: dict[str, Any]) -> None:
        self.db.write(state)

    def update(self, fn):
        return self.db.update(fn)

    def list_collection(
        self,
        field: str,
        *,
        sort: list[tuple[str, int]] | None = None,
        limit: int | None = None,
        filter_query: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if hasattr(self.db, "list_collection"):
            return self.db.list_collection(field, sort=sort, limit=limit, filter_query=filter_query)
        items = list(self.db.read().get(field, []))
        if filter_query:
            items = [item for item in items if all(item.get(key) == value for key, value in filter_query.items())]
        if sort:
            for key, direction in reversed(sort):
                items.sort(key=lambda item: item.get(key) or 0, reverse=direction < 0)
        if limit is not None:
            items = items[:limit]
        return items

    def find_one(self, field: str, filter_query: dict[str, Any]) -> dict[str, Any] | None:
        if hasattr(self.db, "find_one"):
            return self.db.find_one(field, filter_query)

        items = self.db.read().get(field, [])
        for item in items:
            matched = True
            for key, value in filter_query.items():
                if isinstance(value, dict) and "$gt" in value:
                    if not (item.get(key) and item.get(key) > value["$gt"]):
                        matched = False
                        break
                elif item.get(key) != value:
                    matched = False
                    break
            if matched:
                return item
        return None

    def upsert_one(self, field: str, item: dict[str, Any], *, key: str = "id") -> None:
        if hasattr(self.db, "upsert_one"):
            self.db.upsert_one(field, item, key=key)
            return

        item_id = item.get(key)
        self.db.update(
            lambda current: {
                **current,
                field: [existing for existing in current.get(field, []) if existing.get(key) != item_id] + [item],
            }
        )

    def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None:
        if hasattr(self.db, "replace_collection"):
            self.db.replace_collection(field, items, key=key)
            return
        self.db.update(lambda current: {**current, field: items})

    def count_collection(self, field: str, *, filter_query: dict[str, Any] | None = None) -> int:
        if hasattr(self.db, "count_collection"):
            return int(self.db.count_collection(field, filter_query=filter_query))
        return len(self.list_collection(field, filter_query=filter_query))

    def delete_many(self, field: str, *, filter_query: dict[str, Any]) -> int:
        if hasattr(self.db, "delete_many"):
            return int(self.db.delete_many(field, filter_query=filter_query))

        removed = 0

        def updater(current: dict[str, Any]) -> dict[str, Any]:
            nonlocal removed
            items = list(current.get(field, []))
            kept: list[dict[str, Any]] = []
            for item in items:
                matched = True
                for key, value in filter_query.items():
                    current_value = item.get(key)
                    if isinstance(value, dict) and "$lt" in value:
                        if not (current_value is not None and current_value < value["$lt"]):
                            matched = False
                            break
                    elif isinstance(value, dict) and "$in" in value:
                        if current_value not in value["$in"]:
                            matched = False
                            break
                    elif current_value != value:
                        matched = False
                        break
                if matched:
                    removed += 1
                    continue
                kept.append(item)
            return {**current, field: kept}

        self.db.update(updater)
        return removed
