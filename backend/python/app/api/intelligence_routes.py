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

    @app.get("/api/platform/intelligence/artifacts/{market}")
    def intelligence_artifacts(market: str, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return market_intelligence_service.get_market_artifacts(market)

    @app.get("/api/platform/intelligence/search")
    def intelligence_search(
        q: str,
        market: str | None = None,
        limit: int = 8,
        authorization: str | None = Header(default=None),
    ):
        auth_service.require_user(authorization)
        return market_intelligence_service.search_market_intelligence(query=q, market=market, limit=limit)

    @app.get("/api/platform/intelligence/brief")
    def intelligence_brief(market: str | None = None, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return market_intelligence_service.get_market_brief(market)
