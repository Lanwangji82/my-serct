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
        marketType: str | None = None,
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
            market_type=marketType,
            limit=limit,
            force_refresh=forceRefresh,
        )

    @app.get("/api/platform/market/board")
    def market_board(
        market: str,
        exchangeId: str | None = None,
        marketType: str | None = None,
        page: int = 1,
        pageSize: int = 100,
        sortField: str = "changePct",
        sortDirection: str = "desc",
        forceRefresh: bool = False,
        authorization: str | None = Header(default=None),
    ):
        auth_service.require_user(authorization)
        return market_data_service.get_board(
            market=market,
            exchange_id=exchangeId,
            market_type=marketType,
            page=page,
            page_size=pageSize,
            sort_field=sortField,
            sort_direction=sortDirection,
            force_refresh=forceRefresh,
        )
