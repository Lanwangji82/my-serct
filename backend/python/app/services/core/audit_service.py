from __future__ import annotations

from typing import Any, Callable

try:
    from ...adapters.interfaces import CachedJsonLoader
    from ...repositories.platform_repository import PlatformRepository
except ImportError:
    from backend.python.app.adapters.interfaces import CachedJsonLoader
    from backend.python.app.repositories.platform_repository import PlatformRepository


class AuditService:
    def __init__(
        self,
        *,
        repository: PlatformRepository,
        cached_json: CachedJsonLoader,
        create_id: Callable[[str], str],
        now_ms: Callable[[], int],
    ) -> None:
        self.repository = repository
        self.cached_json = cached_json
        self.create_id = create_id
        self.now_ms = now_ms

    def record(self, actor_user_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        event = {
            "id": self.create_id("audit"),
            "type": event_type,
            "actorUserId": actor_user_id,
            "createdAt": self.now_ms(),
            "payload": payload,
        }
        self.repository.upsert_one("auditEvents", event)
        items = self.repository.list_collection("auditEvents", sort=[("createdAt", -1)], limit=500)
        if len(items) > 500:
            self.repository.replace_collection("auditEvents", items[:500])
        return event

    def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return self.cached_json(
            f"audit:{user_id}",
            5000,
            lambda: self.repository.list_collection(
                "auditEvents",
                sort=[("createdAt", -1)],
                limit=500,
                filter_query={"actorUserId": user_id},
            ),
        )
