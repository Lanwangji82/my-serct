from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

STABLE_QUOTE_ASSETS = {"USDT", "USDC", "BUSD", "FDUSD"}


class BasePortfolioProviderAdapter:
    provider_id = ""
    market = ""

    def validate_connection(self, connection: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def fetch_positions(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        raise NotImplementedError

    def normalize_position(self, raw: dict[str, Any], connection: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


def _scope_from_connection(connection: dict[str, Any]) -> dict[str, Any]:
    return connection.get("scope") if isinstance(connection.get("scope"), dict) else connection


class BinancePortfolioAdapter(BasePortfolioProviderAdapter):
    provider_id = "binance"
    market = "crypto"

    def __init__(self, *, ccxt_module: Any | None = None, proxy_environment_resolver: Callable[[str | None], dict[str, str]] | None = None) -> None:
        self.ccxt_module = ccxt_module
        self.proxy_environment_resolver = proxy_environment_resolver

    def _build_exchange(self, connection: dict[str, Any]):
        if self.ccxt_module is None:
            raise RuntimeError("ccxt is not installed")
        scope = _scope_from_connection(connection)
        credentials = connection.get("credentials") if isinstance(connection.get("credentials"), dict) else {}
        proxy_env = self.proxy_environment_resolver(f"{self.provider_id}:production") if self.proxy_environment_resolver else {}
        proxy_options: dict[str, Any] = {}
        if proxy_env.get("socksProxy"):
            proxy_options["socksProxy"] = str(proxy_env.get("socksProxy") or "")
        elif proxy_env.get("httpsProxy"):
            proxy_options["httpsProxy"] = str(proxy_env.get("httpsProxy") or "")
        elif proxy_env.get("httpProxy"):
            proxy_options["httpProxy"] = str(proxy_env.get("httpProxy") or "")
        exchange_cls = getattr(self.ccxt_module, "binance", None)
        if exchange_cls is None:
            raise RuntimeError("ccxt.binance is unavailable")
        account_type = str(scope.get("accountType") or "spot")
        return exchange_cls(
            {
                "apiKey": str(credentials.get("apiKey") or ""),
                "secret": str(credentials.get("apiSecret") or ""),
                "enableRateLimit": True,
                "timeout": 10_000,
                "wsProxy": str(proxy_env.get("wsProxy") or ""),
                "wssProxy": str(proxy_env.get("wssProxy") or ""),
                "options": {"defaultType": "future" if account_type in {"futures", "swap"} else "spot"},
                **proxy_options,
            }
        )

    def validate_connection(self, connection: dict[str, Any]) -> dict[str, Any]:
        scope = _scope_from_connection(connection)
        if str(scope.get("connectionMode") or "live") == "paper":
            samples = self._load_paper_positions(connection)
            return {"ok": True, "code": "paper_ready", "message": f"Paper scope ready, positions={len(samples)}"}

        exchange = self._build_exchange(connection)
        try:
            balance = exchange.fetch_balance()
            total_assets = len((balance or {}).get("total") or {})
            return {"ok": True, "code": "connected", "message": f"Connected to Binance readonly account, assets={total_assets}"}
        finally:
            try:
                exchange.close()
            except Exception:
                pass

    def fetch_positions(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        scope = _scope_from_connection(connection)
        if str(scope.get("connectionMode") or "live") == "paper":
            return self._load_paper_positions(connection)

        exchange = self._build_exchange(connection)
        try:
            account_type = str(scope.get("accountType") or "spot")
            if account_type in {"futures", "swap"} and hasattr(exchange, "fetch_positions"):
                return list(exchange.fetch_positions() or [])
            balance = exchange.fetch_balance()
            funding_payload = self._load_funding_wallet_payload(exchange)
            totals = (balance or {}).get("total") or {}
            free = (balance or {}).get("free") or {}
            used = (balance or {}).get("used") or {}
            price_assets = {str(asset).upper() for asset, total in totals.items() if float(total or 0) > 0 and str(asset).upper() not in STABLE_QUOTE_ASSETS}
            for item in funding_payload:
                funding_total = float(item.get("free") or 0) + float(item.get("locked") or 0) + float(item.get("freeze") or 0) + float(item.get("withdrawing") or 0)
                asset = str(item.get("asset") or "").upper()
                if funding_total > 0 and asset and asset not in STABLE_QUOTE_ASSETS:
                    price_assets.add(asset)
            tickers = self._load_relevant_tickers(exchange, sorted(price_assets))
            rows: list[dict[str, Any]] = []
            for asset, total in totals.items():
                quantity = float(total or 0)
                if quantity <= 0:
                    continue
                if asset.upper() in STABLE_QUOTE_ASSETS and quantity < 1:
                    continue
                is_stable_quote_asset = asset.upper() in STABLE_QUOTE_ASSETS
                symbol = f"{asset}/USDT" if not is_stable_quote_asset else asset.upper()
                ticker = tickers.get(symbol) or {}
                rows.append(
                    {
                        "symbol": symbol,
                        "asset": asset,
                        "contracts": quantity,
                        "free": float(free.get(asset) or 0),
                        "used": float(used.get(asset) or 0),
                        "markPrice": 1.0 if is_stable_quote_asset else float(ticker.get("last") or 0),
                        "entryPrice": 0.0,
                        "side": "long",
                        "walletType": "spot",
                    }
                )
            rows.extend(self._build_funding_wallet_rows(funding_payload, tickers))
            return rows
        finally:
            try:
                exchange.close()
            except Exception:
                pass

    def normalize_position(self, raw: dict[str, Any], connection: dict[str, Any]) -> dict[str, Any]:
        scope = _scope_from_connection(connection)
        symbol = str(raw.get("symbol") or raw.get("info", {}).get("symbol") or raw.get("asset") or "")
        quantity = float(raw.get("contracts") or raw.get("positionAmt") or raw.get("total") or 0)
        entry_price = float(raw.get("entryPrice") or 0)
        last_price = float(raw.get("markPrice") or raw.get("lastPrice") or raw.get("last") or 0)
        side = str(raw.get("side") or ("short" if quantity < 0 else "long")).lower()
        abs_quantity = abs(quantity)
        market_value = abs_quantity * last_price
        unrealized_pnl = float(raw.get("unrealizedPnl") or ((last_price - entry_price) * quantity if entry_price and last_price else 0))
        unrealized_pnl_pct = (unrealized_pnl / (entry_price * abs_quantity) * 100) if entry_price and abs_quantity else 0.0
        asset_label = symbol.split("/", 1)[0] if "/" in symbol else symbol
        wallet_type = str(raw.get("walletType") or "spot")
        account_type = str(scope.get("accountType") or "spot")
        connection_mode = str(scope.get("connectionMode") or "live")
        return {
            "positionId": f"{connection.get('accountId')}:{scope.get('scopeId') or 'scope'}:{symbol}",
            "accountId": str(connection.get("accountId") or ""),
            "accountLabel": str(connection.get("label") or ""),
            "scopeId": str(scope.get("scopeId") or ""),
            "market": "crypto",
            "providerId": self.provider_id,
            "exchangeId": str(connection.get("exchangeId") or self.provider_id),
            "connectionMode": connection_mode,
            "symbol": symbol,
            "label": asset_label if wallet_type == "spot" else f"{asset_label} ({wallet_type})",
            "assetType": wallet_type if wallet_type != "spot" else ("spot" if account_type == "spot" else "futures"),
            "side": "short" if side == "short" or quantity < 0 else "long",
            "quantity": abs_quantity,
            "availableQuantity": float(raw.get("free") or raw.get("available") or 0),
            "frozenQuantity": float(raw.get("used") or raw.get("frozen") or 0),
            "avgCost": entry_price,
            "lastPrice": last_price,
            "marketValue": market_value,
            "unrealizedPnl": unrealized_pnl,
            "unrealizedPnlPct": unrealized_pnl_pct,
            "currency": "USDT",
            "updatedAt": 0,
            "raw": raw,
        }

    def _load_funding_wallet_payload(self, exchange: Any) -> list[dict[str, Any]]:
        fetch_funding = getattr(exchange, "sapiPostAssetGetFundingAsset", None)
        if not callable(fetch_funding):
            return []
        try:
            payload = fetch_funding({})
        except Exception:
            return []
        return [item for item in payload or [] if isinstance(item, dict)]

    def _build_funding_wallet_rows(self, payload: list[dict[str, Any]], tickers: dict[str, Any]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for item in payload:
            asset = str(item.get("asset") or "")
            free_amount = float(item.get("free") or 0)
            locked_amount = float(item.get("locked") or 0)
            freeze_amount = float(item.get("freeze") or 0)
            withdrawing_amount = float(item.get("withdrawing") or 0)
            quantity = free_amount + locked_amount + freeze_amount + withdrawing_amount
            if not asset or quantity <= 0:
                continue
            if asset.upper() in STABLE_QUOTE_ASSETS and quantity < 1:
                continue
            is_stable_quote_asset = asset.upper() in STABLE_QUOTE_ASSETS
            symbol = f"{asset}/USDT" if not is_stable_quote_asset else asset.upper()
            ticker = tickers.get(symbol) or {}
            rows.append(
                {
                    "symbol": symbol,
                    "asset": asset,
                    "contracts": quantity,
                    "free": free_amount,
                    "used": locked_amount + freeze_amount + withdrawing_amount,
                    "markPrice": 1.0 if is_stable_quote_asset else float(ticker.get("last") or 0),
                    "entryPrice": 0.0,
                    "side": "long",
                    "walletType": "funding",
                }
            )
        return rows

    def _load_relevant_tickers(self, exchange: Any, assets: list[str]) -> dict[str, Any]:
        if not assets:
            return {}
        symbols = [f"{asset}/USDT" for asset in assets if asset and asset not in STABLE_QUOTE_ASSETS]
        if not symbols:
            return {}
        fetch_tickers = getattr(exchange, "fetch_tickers", None)
        if callable(fetch_tickers):
            try:
                return fetch_tickers(symbols)
            except Exception:
                pass
        fetch_ticker = getattr(exchange, "fetch_ticker", None)
        if not callable(fetch_ticker):
            return {}
        tickers: dict[str, Any] = {}
        for symbol in symbols:
            try:
                tickers[symbol] = fetch_ticker(symbol)
            except Exception:
                continue
        return tickers

    def _load_paper_positions(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        scope = _scope_from_connection(connection)
        extra_config = scope.get("extraConfig") if isinstance(scope.get("extraConfig"), dict) else {}
        configured_rows = extra_config.get("paperPositions")
        if isinstance(configured_rows, list) and configured_rows:
            return [item for item in configured_rows if isinstance(item, dict)]
        account_type = str(scope.get("accountType") or "spot")
        if account_type in {"futures", "swap"}:
            return [
                {"symbol": "BTC/USDT:USDT", "asset": "BTC", "contracts": 0.12, "free": 0.12, "used": 0.0, "markPrice": 84250.0, "entryPrice": 80100.0, "side": "long", "unrealizedPnl": 498.0},
                {"symbol": "ETH/USDT:USDT", "asset": "ETH", "contracts": -1.8, "free": 0.0, "used": 1.8, "markPrice": 4680.0, "entryPrice": 4825.0, "side": "short", "unrealizedPnl": 261.0},
            ]
        return [
            {"symbol": "BTC/USDT", "asset": "BTC", "contracts": 0.245, "free": 0.18, "used": 0.065, "markPrice": 84250.0, "entryPrice": 79120.0, "side": "long"},
            {"symbol": "ETH/USDT", "asset": "ETH", "contracts": 3.4, "free": 2.9, "used": 0.5, "markPrice": 4680.0, "entryPrice": 4315.0, "side": "long"},
            {"symbol": "SOL/USDT", "asset": "SOL", "contracts": 48.0, "free": 48.0, "used": 0.0, "markPrice": 192.0, "entryPrice": 168.0, "side": "long"},
        ]


class ManualASharePortfolioAdapter(BasePortfolioProviderAdapter):
    provider_id = "manual"
    market = "a_share"

    def validate_connection(self, connection: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "code": "connected", "message": f"A-share placeholder account ready: {connection.get('label')}"}

    def fetch_positions(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        return []

    def normalize_position(self, raw: dict[str, Any], connection: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class OkxPortfolioAdapter(BasePortfolioProviderAdapter):
    provider_id = "okx"
    market = "crypto"

    def __init__(self, *, proxy_environment_resolver: Callable[[str | None], dict[str, str]] | None = None) -> None:
        self.proxy_environment_resolver = proxy_environment_resolver

    def validate_connection(self, connection: dict[str, Any]) -> dict[str, Any]:
        scope = _scope_from_connection(connection)
        if str(scope.get("connectionMode") or "live") == "paper":
            return {"ok": True, "code": "paper_ready", "message": "OKX paper scope ready, sample positions enabled"}
        return {"ok": False, "code": "provider_unavailable", "message": "OKX readonly live adapter is reserved for the next step"}

    def fetch_positions(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        scope = _scope_from_connection(connection)
        if str(scope.get("connectionMode") or "live") == "paper":
            extra_config = scope.get("extraConfig") if isinstance(scope.get("extraConfig"), dict) else {}
            configured_rows = extra_config.get("paperPositions")
            if isinstance(configured_rows, list) and configured_rows:
                return [item for item in configured_rows if isinstance(item, dict)]
            return [
                {"symbol": "BTC/USDT", "asset": "BTC", "contracts": 0.08, "free": 0.08, "used": 0.0, "markPrice": 84250.0, "entryPrice": 82000.0, "side": "long"},
                {"symbol": "XRP/USDT", "asset": "XRP", "contracts": 3200.0, "free": 3200.0, "used": 0.0, "markPrice": 1.86, "entryPrice": 1.72, "side": "long"},
            ]
        raise RuntimeError("OKX readonly live adapter is not implemented in MVP")

    def normalize_position(self, raw: dict[str, Any], connection: dict[str, Any]) -> dict[str, Any]:
        return BinancePortfolioAdapter().normalize_position(raw, connection)


class PortfolioService:
    def __init__(
        self,
        *,
        now_ms: Callable[[], int],
        create_id: Callable[[str], str],
        account_connection_store: Any,
        market_regime_service: Any | None = None,
        market_intelligence_service: Any | None = None,
        provider_adapters: dict[str, BasePortfolioProviderAdapter] | None = None,
    ) -> None:
        self.now_ms = now_ms
        self.create_id = create_id
        self.account_connection_store = account_connection_store
        self.market_regime_service = market_regime_service
        self.market_intelligence_service = market_intelligence_service
        self.provider_adapters = provider_adapters or {}
        self._regime_cache: dict[str, Any] = {"expiresAt": 0, "value": {}}
        self._recent_event_cache: dict[str, Any] = {"expiresAt": 0, "value": {}}

    def list_account_connections(self) -> dict[str, Any]:
        return {"generatedAt": self.now_ms(), "connections": self.account_connection_store["list"]()}

    def save_account_connection(self, payload: dict[str, Any]) -> dict[str, Any]:
        connection = self.account_connection_store["save"](payload, create_id=self.create_id, now_value=self.now_ms())
        return {"connection": connection, "generatedAt": self.now_ms()}

    def set_account_connection_enabled(self, account_id: str, enabled: bool) -> dict[str, Any]:
        connection = self.account_connection_store["set_enabled"](account_id, enabled=enabled)
        return {"connection": connection, "generatedAt": self.now_ms()}

    def delete_account_connection(self, account_id: str) -> dict[str, Any]:
        result = self.account_connection_store["delete"](account_id)
        return {"result": result, "generatedAt": self.now_ms()}

    def test_account_connection(self, payload: dict[str, Any] | None = None, *, account_id: str | None = None) -> dict[str, Any]:
        raw_account = payload or (self.account_connection_store["get"](account_id) if account_id else None)
        if not raw_account:
            raise RuntimeError("Account connection not found")

        scopes = raw_account.get("scopes") if isinstance(raw_account.get("scopes"), list) else []
        enabled_scopes = [scope for scope in scopes if isinstance(scope, dict) and bool(scope.get("enabled", True))]
        if not enabled_scopes:
            result = {"ok": False, "code": "unknown_error", "message": "No enabled scopes configured for this account"}
        else:
            scope_results = []
            for scope in enabled_scopes:
                adapter = self.provider_adapters.get(str(raw_account.get("providerId") or ""))
                if adapter is None:
                    raise RuntimeError(f"Unsupported account provider: {raw_account.get('providerId')}")
                scoped_connection = {**raw_account, "scope": scope}
                try:
                    scope_result = adapter.validate_connection(scoped_connection)
                except Exception as exc:
                    scope_result = {"ok": False, **self._classify_connection_error(exc)}
                scope_results.append(
                    {
                        "scopeId": str(scope.get("scopeId") or ""),
                        "accountType": str(scope.get("accountType") or ""),
                        "connectionMode": str(scope.get("connectionMode") or ""),
                        **scope_result,
                    }
                )
            failures = [item for item in scope_results if not item.get("ok")]
            if failures:
                first = failures[0]
                result = {
                    "ok": False,
                    "code": str(first.get("code") or "unknown_error"),
                    "message": f"{first.get('accountType')}/{first.get('connectionMode')}: {first.get('message')}",
                    "scopes": scope_results,
                }
            else:
                summary = ", ".join(f"{item['accountType']}/{item['connectionMode']}" for item in scope_results)
                result = {
                    "ok": True,
                    "code": "connected",
                    "message": f"Account scopes ready: {summary}",
                    "scopes": scope_results,
                }

        if raw_account.get("accountId"):
            self.account_connection_store["update_status"](
                str(raw_account.get("accountId")),
                ok=bool(result.get("ok")),
                code=str(result.get("code") or ""),
                message=str(result.get("message") or ""),
            )
        return {
            "result": {
                "ok": bool(result.get("ok")),
                "code": str(result.get("code") or ""),
                "message": str(result.get("message") or ""),
                "scopes": result.get("scopes") or [],
                "checkedAt": self.now_ms(),
            },
            "generatedAt": self.now_ms(),
        }

    def get_positions(self, *, market: str | None = None, account_id: str | None = None, connection_mode: str | None = None) -> dict[str, Any]:
        regime_map = self._load_regime_map()
        event_map = self._load_recent_event_map()
        positions: list[dict[str, Any]] = []
        scope_jobs: list[tuple[dict[str, Any], dict[str, Any], BasePortfolioProviderAdapter]] = []
        for account, scope in self.account_connection_store["iter_scopes"]():
            if not bool(account.get("enabled", True)) or not bool(scope.get("enabled", True)):
                continue
            if market and str(account.get("market") or "") != market:
                continue
            if account_id and str(account.get("accountId") or "") != account_id:
                continue
            if connection_mode and str(scope.get("connectionMode") or "live") != connection_mode:
                continue
            adapter = self.provider_adapters.get(str(account.get("providerId") or ""))
            if adapter is None:
                continue
            scope_jobs.append((account, scope, adapter))

        def load_scope_positions(job: tuple[dict[str, Any], dict[str, Any], BasePortfolioProviderAdapter]) -> list[dict[str, Any]]:
            account_item, scope_item, adapter_item = job
            scoped_connection = {**account_item, "scope": scope_item}
            raw_positions = adapter_item.fetch_positions(scoped_connection)
            normalized_rows: list[dict[str, Any]] = []
            for raw_position in raw_positions:
                normalized = adapter_item.normalize_position(raw_position, scoped_connection)
                normalized["updatedAt"] = self.now_ms()
                normalized["entryRegime"] = ""
                normalized["currentRegime"] = regime_map.get(str(account_item.get("market") or ""), "震荡")
                normalized["strategyType"] = "账户持仓"
                normalized["thesis"] = f"{account_item.get('label')} 只读同步"
                normalized["exitRule"] = "只读持仓，不提供交易执行"
                linked_events = event_map.get(str(normalized.get("symbol") or ""), [])
                normalized["latestEvents"] = linked_events[:3]
                normalized["reminders"] = self._build_position_reminders(normalized, linked_events)
                normalized_rows.append(normalized)
            return normalized_rows

        max_workers = min(4, len(scope_jobs)) or 1
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(load_scope_positions, job): job for job in scope_jobs}
            for future in as_completed(future_map):
                account, _scope, _adapter = future_map[future]
                try:
                    positions.extend(future.result())
                except Exception as exc:
                    diagnosis = self._classify_connection_error(exc)
                    self.account_connection_store["update_status"](
                        str(account.get("accountId")),
                        ok=False,
                        code=diagnosis["code"],
                        message=diagnosis["message"],
                    )
                    continue

        positions.sort(key=lambda item: (str(item.get("market") or ""), str(item.get("accountLabel") or ""), -float(item.get("marketValue") or 0)))
        summary = self._build_position_summary(positions)
        return {"generatedAt": self.now_ms(), **summary}

    def _build_position_summary(self, positions: list[dict[str, Any]]) -> dict[str, Any]:
        total_market_value = sum(float(item.get("marketValue") or 0) for item in positions)
        total_unrealized_pnl = sum(float(item.get("unrealizedPnl") or 0) for item in positions)
        total_cost = sum(float(item.get("avgCost") or 0) * float(item.get("quantity") or 0) for item in positions)
        totals = {
            "marketValue": total_market_value,
            "unrealizedPnl": total_unrealized_pnl,
            "unrealizedPnlPct": (total_unrealized_pnl / total_cost * 100) if total_cost else 0.0,
            "positionCount": len(positions),
            "accountCount": len({str(item.get("accountId") or "") for item in positions}),
        }
        by_market: list[dict[str, Any]] = []
        for market in sorted({str(item.get("market") or "") for item in positions}):
            rows = [item for item in positions if str(item.get("market") or "") == market]
            by_market.append(
                {
                    "market": market,
                    "marketValue": sum(float(item.get("marketValue") or 0) for item in rows),
                    "unrealizedPnl": sum(float(item.get("unrealizedPnl") or 0) for item in rows),
                    "positionCount": len(rows),
                }
            )
        by_account: list[dict[str, Any]] = []
        for account in sorted({str(item.get("accountId") or "") for item in positions}):
            rows = [item for item in positions if str(item.get("accountId") or "") == account]
            head = rows[0] if rows else {}
            by_account.append(
                {
                    "accountId": account,
                    "accountLabel": str(head.get("accountLabel") or ""),
                    "market": str(head.get("market") or ""),
                    "providerId": str(head.get("providerId") or ""),
                    "exchangeId": str(head.get("exchangeId") or ""),
                    "marketValue": sum(float(item.get("marketValue") or 0) for item in rows),
                    "unrealizedPnl": sum(float(item.get("unrealizedPnl") or 0) for item in rows),
                    "positionCount": len(rows),
                    "scopes": sorted({f"{str(item.get('assetType') or '')}:{str(item.get('connectionMode') or '')}" for item in rows}),
                }
            )
        return {"totals": totals, "byMarket": by_market, "byAccount": by_account, "positions": positions}

    def _classify_connection_error(self, exc: Exception) -> dict[str, str]:
        message = str(exc)
        lower = message.lower()
        error_name = exc.__class__.__name__.lower()
        if '"code":-2015' in lower or "invalid api-key, ip, or permissions for action" in lower:
            return {"code": "permission_denied", "message": "Binance 返回 -2015，通常表示 API 受 IP 白名单或权限限制。请检查只读权限，并确认已放行当前代理出口 IP"}
        if "invalid api-key id" in lower or "api-key format invalid" in lower:
            return {"code": "invalid_key", "message": "API Key 或 Secret 无效，请检查是否填错、重置或复制不完整"}
        if "permission" in lower or "not authorized" in lower or "access denied" in lower:
            return {"code": "permission_denied", "message": "API 权限不足，请确认已开启只读查询权限"}
        if "requesttimeout" in lower or "timed out" in lower or error_name == "requesttimeout":
            return {"code": "network_timeout", "message": "连接交易所超时，请检查代理、端口路由或网络环境"}
        if "proxy" in lower or "socks" in lower or "407" in lower:
            return {"code": "proxy_error", "message": "代理链路异常，请检查 sing-box/Clash 和端口路由设置"}
        if "network error" in lower or "connection reset" in lower or "max retries" in lower:
            return {"code": "network_error", "message": "网络连接失败，请检查本机网络和代理出口"}
        if "reserved for next step" in lower or "not implemented" in lower:
            return {"code": "provider_unavailable", "message": message}
        return {"code": "unknown_error", "message": message}

    def _build_position_reminders(self, position: dict[str, Any], linked_events: list[dict[str, Any]]) -> list[str]:
        reminders: list[str] = []
        pnl_pct = float(position.get("unrealizedPnlPct") or 0)
        current_regime = str(position.get("currentRegime") or "")
        if current_regime and current_regime != "多头" and str(position.get("market") or "") == "crypto":
            reminders.append(f"当前市场状态为 {current_regime}，需要重新检查仓位节奏")
        if pnl_pct >= 8:
            reminders.append("浮盈已经较大，可以评估分批止盈")
        elif pnl_pct <= -5:
            reminders.append("回撤接近风控线，需要检查减仓条件")
        bearish_events = [event for event in linked_events if str(event.get("sentiment") or "") == "bearish"]
        if bearish_events:
            reminders.append(f"最近有 {len(bearish_events)} 条偏利空事件")
        return reminders[:4]

    def _load_regime_map(self) -> dict[str, str]:
        now_value = self.now_ms()
        if int(self._regime_cache.get("expiresAt") or 0) > now_value:
            return dict(self._regime_cache.get("value") or {})
        if self.market_regime_service is None:
            return {}
        try:
            payload = self.market_regime_service.get_regime_snapshot()
        except Exception:
            return {}
        value = {
            "a_share": str(((payload.get("markets") or {}).get("a_share") or {}).get("regimeLabel") or ""),
            "crypto": str(((payload.get("markets") or {}).get("crypto") or {}).get("regimeLabel") or ""),
        }
        self._regime_cache = {"expiresAt": now_value + 15_000, "value": value}
        return value

    def _load_recent_event_map(self) -> dict[str, list[dict[str, Any]]]:
        now_value = self.now_ms()
        if int(self._recent_event_cache.get("expiresAt") or 0) > now_value:
            return dict(self._recent_event_cache.get("value") or {})
        if self.market_intelligence_service is None:
            return {}
        event_map: dict[str, list[dict[str, Any]]] = {}
        for market in ("a_share", "crypto"):
            try:
                events = self.market_intelligence_service.get_feed_events(market=market, force_refresh=False)
            except Exception:
                continue
            for event in events[:40]:
                for asset in event.get("affectedAssets") or []:
                    symbol = str(asset.get("symbol") or "")
                    if not symbol:
                        continue
                    event_map.setdefault(symbol, []).append(
                        {
                            "eventId": str(event.get("eventId") or ""),
                            "title": str(event.get("title") or ""),
                            "sentiment": str(event.get("sentiment") or ""),
                            "sentimentLabel": str(event.get("sentimentLabel") or ""),
                            "executionLabel": str(event.get("executionLabel") or ""),
                            "publishedAt": int(event.get("publishedAt") or 0),
                        }
                    )
        self._recent_event_cache = {"expiresAt": now_value + 15_000, "value": event_map}
        return event_map
