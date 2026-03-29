from __future__ import annotations

from typing import Any, Callable

from fastapi import HTTPException

try:
    from ..repositories.platform_repository import PlatformRepository
except ImportError:
    from repositories.platform_repository import PlatformRepository


class AuthService:
    def __init__(
        self,
        *,
        repository: PlatformRepository,
        now_ms: Callable[[], int],
        create_id: Callable[[str], str],
        sha256: Callable[[str], str],
        local_mode: bool,
        session_ttl_ms: int,
        bootstrap_email: str,
        bootstrap_password: str,
    ) -> None:
        self.repository = repository
        self.now_ms = now_ms
        self.create_id = create_id
        self.sha256 = sha256
        self.local_mode = local_mode
        self.session_ttl_ms = session_ttl_ms
        self.bootstrap_email = bootstrap_email
        self.bootstrap_password = bootstrap_password

    def sanitize_user(self, user: dict[str, Any]) -> dict[str, Any]:
        return {"id": user["id"], "email": user["email"], "roles": user["roles"], "createdAt": user["createdAt"]}

    def ensure_bootstrap_user(self) -> dict[str, Any]:
        existing = self.repository.list_collection("users", limit=1)
        if existing:
            return existing[0]
        user = {
            "id": self.create_id("user"),
            "email": self.bootstrap_email,
            "passwordHash": self.sha256(self.bootstrap_password),
            "roles": ["admin", "trader"],
            "createdAt": self.now_ms(),
        }
        self.repository.upsert_one("users", user)
        return user

    def require_user(self, authorization: str | None) -> dict[str, Any]:
        user = self.ensure_bootstrap_user()
        if self.local_mode and (not authorization or not authorization.startswith("Bearer ")):
            return self.sanitize_user(user)
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing session token")

        token = authorization[7:].strip()
        session = self.repository.find_one("sessions", {"token": token, "expiresAt": {"$gt": self.now_ms()}})
        if not session:
            raise HTTPException(status_code=401, detail="Session expired or invalid")

        current_user = self.repository.find_one("users", {"id": session["userId"]})
        if not current_user:
            raise HTTPException(status_code=401, detail="User not found")
        return self.sanitize_user(current_user)

    def login(self, email: str, password: str) -> tuple[dict[str, Any], dict[str, Any]]:
        self.ensure_bootstrap_user()
        user = self.repository.find_one("users", {"email": email.strip().lower()})
        if not user or user["passwordHash"] != self.sha256(password):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        now = self.now_ms()
        session = {
            "token": self.create_id("sess"),
            "userId": user["id"],
            "createdAt": now,
            "expiresAt": now + self.session_ttl_ms,
        }
        sessions = self.repository.list_collection(
            "sessions",
            filter_query={"expiresAt": {"$gt": now}},
            sort=[("createdAt", -1)],
            limit=200,
        )
        self.repository.replace_collection("sessions", [*sessions, session])
        return session, self.sanitize_user(user)

