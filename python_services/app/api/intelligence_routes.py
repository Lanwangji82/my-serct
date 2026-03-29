from __future__ import annotations

from fastapi import FastAPI, Header


def register_intelligence_routes(
    app: FastAPI,
    *,
    auth_service,
    market_intelligence_service,
) -> None:
    @app.get("/api/platform/intelligence/overview")
    def intelligence_overview(forceRefresh: bool = False, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return market_intelligence_service.get_overview(force_refresh=forceRefresh)
