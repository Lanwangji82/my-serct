from __future__ import annotations

from fastapi import FastAPI, Header


def register_market_routes(
    app: FastAPI,
    *,
    auth_service,
    market_data_service,
) -> None:
    @app.get("/api/platform/market/catalog")
    def market_catalog(forceRefresh: bool = False, authorization: str | None = Header(default=None)):
        auth_service.require_user(authorization)
        return market_data_service.get_catalog(force_refresh=forceRefresh)

    @app.get("/api/platform/market/series")
    def market_series(
        market: str,
        symbol: str,
        interval: str,
        exchangeId: str | None = None,
        limit: int = 180,
        forceRefresh: bool = False,
        authorization: str | None = Header(default=None),
    ):
        auth_service.require_user(authorization)
        return market_data_service.get_series(
            market=market,
            symbol=symbol,
            interval=interval,
            exchange_id=exchangeId,
            limit=limit,
            force_refresh=forceRefresh,
        )
