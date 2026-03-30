from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

try:
    from ...bootstrap.platform_registry import build_network_client_catalog, build_network_route_catalog
except ImportError:
    from backend.python.app.bootstrap.platform_registry import build_network_client_catalog, build_network_route_catalog

NetworkClientId = Literal["auto", "jp", "sg", "us", "hk", "direct"]

DEFAULT_NETWORK_CLIENT_PORTS: dict[NetworkClientId, int] = {
    "auto": 7890,
    "jp": 7891,
    "sg": 7892,
    "us": 7893,
    "hk": 7894,
    "direct": 7895,
}
DEFAULT_NETWORK_CLIENT_ROUTES: dict[str, NetworkClientId] = {
    "default": "auto",
    "binance": "jp",
    "okx": "auto",
}


class NetworkClientPortConfig(BaseModel):
    port: int = Field(ge=1, le=65535)


class NetworkClientSettingsPayload(BaseModel):
    clients: dict[str, NetworkClientPortConfig]
    routes: dict[str, str]


def now_ms() -> int:
    return int(time.time() * 1000)


def get_network_client_settings_path() -> Path:
    default_path = Path(__file__).resolve().parent.parent.parent.parent.parent.parent / "config" / "network-clients.json"
    legacy_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "network-clients.json"
    path = Path(os.getenv("PLATFORM_NETWORK_CLIENT_SETTINGS_PATH", default_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path == default_path and not path.exists() and legacy_path.exists():
        try:
            path.write_text(legacy_path.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            pass
    return path


def get_network_client_settings() -> dict[str, Any]:
    route_catalog = build_network_route_catalog()
    settings: dict[str, Any] = {
        "clients": {client_id: {"port": port} for client_id, port in DEFAULT_NETWORK_CLIENT_PORTS.items()},
        "routes": dict(DEFAULT_NETWORK_CLIENT_ROUTES),
        "clientCatalog": build_network_client_catalog(),
        "routeCatalog": route_catalog,
        "updatedAt": 0,
    }

    settings_path = get_network_client_settings_path()
    if not settings_path.exists():
        return settings

    try:
        saved = json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception:
        return settings

    for client_id in DEFAULT_NETWORK_CLIENT_PORTS:
        port = saved.get("clients", {}).get(client_id, {}).get("port")
        if isinstance(port, int) and 0 < port <= 65535:
            settings["clients"][client_id]["port"] = port

    for route_name in {item["routeId"] for item in route_catalog}:
        route_value = saved.get("routes", {}).get(route_name)
        if route_value in DEFAULT_NETWORK_CLIENT_PORTS:
            settings["routes"][route_name] = route_value

    updated_at = saved.get("updatedAt")
    if isinstance(updated_at, int):
        settings["updatedAt"] = updated_at

    return settings


def save_network_client_settings(payload: NetworkClientSettingsPayload) -> dict[str, Any]:
    settings = get_network_client_settings()
    valid_route_ids = {item["routeId"] for item in settings["routeCatalog"]}

    for client_id in DEFAULT_NETWORK_CLIENT_PORTS:
        if client_id not in payload.clients:
            raise HTTPException(status_code=400, detail=f"Missing client config: {client_id}")
        settings["clients"][client_id]["port"] = payload.clients[client_id].port

    for route_name in valid_route_ids:
        route_value = payload.routes.get(route_name)
        if route_value not in DEFAULT_NETWORK_CLIENT_PORTS:
            raise HTTPException(status_code=400, detail=f"Invalid route for {route_name}: {route_value}")
        settings["routes"][route_name] = route_value

    settings["updatedAt"] = now_ms()
    get_network_client_settings_path().write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    return settings


def get_default_client_url(client_id: NetworkClientId) -> str:
    return f"http://127.0.0.1:{get_network_client_settings()['clients'][client_id]['port']}"


def get_preferred_network_client_id(broker_target: str | None = None) -> NetworkClientId:
    normalized = (broker_target or "default").split(":", 1)[0].strip().lower()
    saved_route = get_network_client_settings()["routes"].get(normalized)
    if saved_route in DEFAULT_NETWORK_CLIENT_PORTS:
        return saved_route  # type: ignore[return-value]

    configured = (os.getenv(f"PLATFORM_CLIENT_ROUTE_{normalized.upper()}") or "").strip().lower()
    if configured in DEFAULT_NETWORK_CLIENT_PORTS:
        return configured  # type: ignore[return-value]

    return DEFAULT_NETWORK_CLIENT_ROUTES.get(normalized, "auto")  # type: ignore[return-value]


def get_network_client_proxy_environment(broker_target: str | None = None) -> dict[str, str]:
    client_id = get_preferred_network_client_id(broker_target)
    if client_id == "direct":
        return {
            "clientId": client_id,
            "httpProxy": "",
            "httpsProxy": "",
            "socksProxy": "",
            "wsProxy": "",
            "wssProxy": "",
            "proxySource": "network-client",
        }

    upper = client_id.upper()
    client_url = (os.getenv(f"PLATFORM_CLIENT_{upper}_URL") or get_default_client_url(client_id)).strip()
    ws_url = (os.getenv(f"PLATFORM_CLIENT_{upper}_WS_URL") or client_url).strip()
    wss_url = (os.getenv(f"PLATFORM_CLIENT_{upper}_WSS_URL") or client_url).strip()
    return {
        "clientId": client_id,
        "httpProxy": client_url,
        "httpsProxy": client_url,
        "socksProxy": client_url,
        "wsProxy": ws_url,
        "wssProxy": wss_url,
        "proxySource": "network-client",
    }


def get_proxy_environment() -> dict[str, str]:
    explicit_http = (os.getenv("PLATFORM_HTTP_PROXY") or os.getenv("CCXT_HTTP_PROXY") or os.getenv("HTTP_PROXY") or "").strip()
    explicit_https = (os.getenv("PLATFORM_HTTPS_PROXY") or os.getenv("CCXT_HTTPS_PROXY") or os.getenv("HTTPS_PROXY") or "").strip()
    explicit_socks = (os.getenv("PLATFORM_SOCKS_PROXY") or os.getenv("CCXT_SOCKS_PROXY") or os.getenv("ALL_PROXY") or "").strip()
    system_http = os.getenv("http_proxy", "").strip()
    system_https = os.getenv("https_proxy", "").strip()
    system_all = os.getenv("all_proxy", "").strip()

    return {
        "httpProxy": explicit_http or system_http,
        "httpsProxy": explicit_https or system_https,
        "socksProxy": explicit_socks or system_all,
        "wsProxy": (os.getenv("PLATFORM_WS_PROXY") or os.getenv("CCXT_WS_PROXY") or "").strip(),
        "wssProxy": (os.getenv("PLATFORM_WSS_PROXY") or os.getenv("CCXT_WSS_PROXY") or "").strip(),
        "proxySource": "explicit" if any((explicit_http, explicit_https, explicit_socks)) else ("system" if any((system_http, system_https, system_all)) else "none"),
    }


def get_proxy_runtime_summary() -> dict[str, Any]:
    raw_proxy = get_proxy_environment()
    settings = get_network_client_settings()
    default_client = get_network_client_proxy_environment()
    binance_client = get_network_client_proxy_environment("binance")
    okx_client = get_network_client_proxy_environment("okx")

    active_mode = "none"
    active_value = ""
    if raw_proxy["socksProxy"]:
        active_mode = "socks"
        active_value = raw_proxy["socksProxy"]
    elif raw_proxy["httpsProxy"]:
        active_mode = "https"
        active_value = raw_proxy["httpsProxy"]
    elif raw_proxy["httpProxy"]:
        active_mode = "http"
        active_value = raw_proxy["httpProxy"]

    if active_mode == "none":
        network_client_proxy = next(
            (
                proxy
                for proxy in (
                    default_client["httpProxy"],
                    binance_client["httpProxy"],
                    okx_client["httpProxy"],
                )
                if proxy
            ),
            "",
        )
        if network_client_proxy:
            active_mode = "network-client"
            active_value = network_client_proxy

    return {
        "configured": active_mode != "none",
        "mode": active_mode,
        "activeProxy": active_value,
        "source": raw_proxy.get("proxySource", "none") if active_mode not in {"none", "network-client"} else ("network-client" if active_mode == "network-client" else "none"),
        "httpProxy": raw_proxy["httpProxy"],
        "httpsProxy": raw_proxy["httpsProxy"],
        "socksProxy": raw_proxy["socksProxy"],
        "wsProxy": raw_proxy["wsProxy"],
        "wssProxy": raw_proxy["wssProxy"],
        "settings": settings,
        "networkClients": {
            "default": default_client,
            "binance": binance_client,
            "okx": okx_client,
        },
    }
