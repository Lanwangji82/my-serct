from __future__ import annotations

from typing import Any


class PlatformRepository:
    def __init__(self, db: Any) -> None:
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
        items = list(self.db.read()[field])
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

        items = self.db.read()[field]
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
                field: [existing for existing in current[field] if existing.get(key) != item_id] + [item],
            }
        )

    def replace_collection(self, field: str, items: list[dict[str, Any]], *, key: str = "id") -> None:
        if hasattr(self.db, "replace_collection"):
            self.db.replace_collection(field, items, key=key)
            return
        self.db.update(lambda current: {**current, field: items})
