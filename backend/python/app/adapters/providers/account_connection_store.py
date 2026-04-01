from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException


SUPPORTED_CRYPTO_PROVIDERS = {"binance", "okx"}
SUPPORTED_A_SHARE_PROVIDERS = {"manual"}


def now_ms() -> int:
    return int(time.time() * 1000)


def _mask_secret(value: str) -> str:
    secret = (value or "").strip()
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}{'*' * (len(secret) - 8)}{secret[-4:]}"


def get_account_connections_path() -> Path:
    default_path = Path(__file__).resolve().parent.parent.parent.parent.parent.parent / "config" / "account-connections.json"
    legacy_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "account-connections.json"
    path = Path(os.getenv("PLATFORM_ACCOUNT_CONNECTIONS_PATH", default_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path == default_path and not path.exists() and legacy_path.exists():
        try:
            path.write_text(legacy_path.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            pass
    return path


def _empty_payload() -> dict[str, Any]:
    return {"accounts": []}


def _normalize_provider_ids(market: str, provider_id: str) -> tuple[str, str]:
    normalized_market = (market or "crypto").strip().lower()
    normalized_provider = (provider_id or "").strip().lower()
    if normalized_market == "crypto":
        if normalized_provider not in SUPPORTED_CRYPTO_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unsupported crypto provider: {provider_id}")
        return normalized_market, normalized_provider
    if normalized_market == "a_share":
        if normalized_provider not in SUPPORTED_A_SHARE_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unsupported A-share provider: {provider_id}")
        return normalized_market, normalized_provider
    raise HTTPException(status_code=400, detail=f"Unsupported market: {market}")


def _normalize_scope(raw_scope: dict[str, Any], *, account_market: str, create_id, now_value: int) -> dict[str, Any]:
    account_type = str(raw_scope.get("accountType") or ("stock" if account_market == "a_share" else "spot")).strip().lower()
    connection_mode = str(raw_scope.get("connectionMode") or "live").strip().lower()
    if connection_mode not in {"live", "paper"}:
        raise HTTPException(status_code=400, detail=f"Unsupported connection mode: {connection_mode}")
    scope_id = str(raw_scope.get("scopeId") or "").strip() or create_id("scope")
    status = raw_scope.get("status") if isinstance(raw_scope.get("status"), dict) else {}
    extra_config = raw_scope.get("extraConfig") if isinstance(raw_scope.get("extraConfig"), dict) else {}
    return {
        "scopeId": scope_id,
        "accountType": account_type,
        "connectionMode": connection_mode,
        "enabled": bool(raw_scope.get("enabled", True)),
        "extraConfig": extra_config,
        "status": {
            "ok": bool(status.get("ok")),
            "code": str(status.get("code") or ""),
            "message": str(status.get("message") or ""),
            "checkedAt": int(status.get("checkedAt") or 0),
        },
        "createdAt": int(raw_scope.get("createdAt") or now_value),
        "updatedAt": int(raw_scope.get("updatedAt") or now_value),
    }


def _read_raw_settings() -> dict[str, Any]:
    path = get_account_connections_path()
    if not path.exists():
        return _empty_payload()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return _empty_payload()

    if isinstance(payload, dict) and isinstance(payload.get("accounts"), list):
        return payload

    # Backward-compatible migration from the old flat `connections` shape.
    if isinstance(payload, dict) and isinstance(payload.get("connections"), list):
        grouped: dict[str, dict[str, Any]] = {}
        for item in payload.get("connections", []):
            if not isinstance(item, dict):
                continue
            market, provider_id = _normalize_provider_ids(str(item.get("market") or "crypto"), str(item.get("providerId") or item.get("exchangeId") or ""))
            account_id = str(item.get("accountId") or "")
            if not account_id:
                continue
            account = grouped.setdefault(
                account_id,
                {
                    "accountId": account_id,
                    "label": str(item.get("label") or provider_id.upper()),
                    "market": market,
                    "providerId": provider_id,
                    "brokerId": str(item.get("brokerId") or provider_id),
                    "exchangeId": str(item.get("exchangeId") or provider_id),
                    "enabled": bool(item.get("enabled", True)),
                    "mode": "readonly",
                    "credentials": item.get("credentials") if isinstance(item.get("credentials"), dict) else {},
                    "status": item.get("status") if isinstance(item.get("status"), dict) else {},
                    "createdAt": int(item.get("createdAt") or 0),
                    "updatedAt": int(item.get("updatedAt") or 0),
                    "scopes": [],
                },
            )
            account["scopes"].append(
                {
                    "scopeId": f"{account_id}:{item.get('accountType') or 'spot'}:{item.get('connectionMode') or 'live'}",
                    "accountType": str(item.get("accountType") or ("stock" if market == "a_share" else "spot")),
                    "connectionMode": str(item.get("connectionMode") or "live"),
                    "enabled": bool(item.get("enabled", True)),
                    "extraConfig": item.get("extraConfig") if isinstance(item.get("extraConfig"), dict) else {},
                    "status": item.get("status") if isinstance(item.get("status"), dict) else {},
                    "createdAt": int(item.get("createdAt") or 0),
                    "updatedAt": int(item.get("updatedAt") or 0),
                }
            )
        return {"accounts": list(grouped.values())}

    return _empty_payload()


def _write_raw_settings(payload: dict[str, Any]) -> None:
    get_account_connections_path().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_public_account(raw: dict[str, Any]) -> dict[str, Any]:
    credentials = raw.get("credentials") if isinstance(raw.get("credentials"), dict) else {}
    status = raw.get("status") if isinstance(raw.get("status"), dict) else {}
    market = str(raw.get("market") or "crypto")
    provider_id = str(raw.get("providerId") or "")
    exchange_id = str(raw.get("exchangeId") or provider_id or "")
    scopes = raw.get("scopes") if isinstance(raw.get("scopes"), list) else []
    public_scopes = []
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        scope_status = scope.get("status") if isinstance(scope.get("status"), dict) else {}
        public_scopes.append(
            {
                "scopeId": str(scope.get("scopeId") or ""),
                "accountType": str(scope.get("accountType") or ("stock" if market == "a_share" else "spot")),
                "connectionMode": str(scope.get("connectionMode") or "live"),
                "enabled": bool(scope.get("enabled", True)),
                "extraConfig": scope.get("extraConfig") if isinstance(scope.get("extraConfig"), dict) else {},
                "status": {
                    "ok": bool(scope_status.get("ok")),
                    "code": str(scope_status.get("code") or ""),
                    "message": str(scope_status.get("message") or ""),
                    "checkedAt": int(scope_status.get("checkedAt") or 0),
                },
                "createdAt": int(scope.get("createdAt") or 0),
                "updatedAt": int(scope.get("updatedAt") or 0),
            }
        )
    return {
        "accountId": str(raw.get("accountId") or ""),
        "label": str(raw.get("label") or exchange_id.upper()),
        "market": market,
        "providerId": provider_id,
        "brokerId": str(raw.get("brokerId") or provider_id),
        "exchangeId": exchange_id,
        "mode": "readonly",
        "enabled": bool(raw.get("enabled", True)),
        "apiKeyMasked": _mask_secret(str(credentials.get("apiKey") or "")),
        "apiSecretMasked": _mask_secret(str(credentials.get("apiSecret") or "")),
        "passphraseMasked": _mask_secret(str(credentials.get("passphrase") or "")),
        "status": {
            "ok": bool(status.get("ok")),
            "code": str(status.get("code") or ""),
            "message": str(status.get("message") or ""),
            "checkedAt": int(status.get("checkedAt") or 0),
        },
        "scopes": public_scopes,
        "createdAt": int(raw.get("createdAt") or 0),
        "updatedAt": int(raw.get("updatedAt") or 0),
    }


def list_account_connections() -> list[dict[str, Any]]:
    payload = _read_raw_settings()
    return [_build_public_account(item) for item in payload.get("accounts", []) if isinstance(item, dict)]


def list_raw_account_connections() -> list[dict[str, Any]]:
    payload = _read_raw_settings()
    return [item for item in payload.get("accounts", []) if isinstance(item, dict)]


def iter_raw_account_scopes() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    items: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for account in list_raw_account_connections():
        scopes = account.get("scopes") if isinstance(account.get("scopes"), list) else []
        for scope in scopes:
            if isinstance(scope, dict):
                items.append((account, scope))
    return items


def get_account_connection(account_id: str) -> dict[str, Any] | None:
    for item in list_raw_account_connections():
        if str(item.get("accountId") or "") == account_id:
            return item
    return None


def save_account_connection(payload: dict[str, Any], *, create_id, now_value: int | None = None) -> dict[str, Any]:
    now_ts = now_value or now_ms()
    account_id = str(payload.get("accountId") or "").strip() or create_id("acct")
    market, provider_id = _normalize_provider_ids(str(payload.get("market") or "crypto"), str(payload.get("providerId") or payload.get("exchangeId") or ""))
    label = str(payload.get("label") or provider_id.upper()).strip()
    exchange_id = str(payload.get("exchangeId") or provider_id).strip().lower()
    enabled = bool(payload.get("enabled", True))
    credentials = payload.get("credentials") if isinstance(payload.get("credentials"), dict) else {}
    scopes_payload = payload.get("scopes") if isinstance(payload.get("scopes"), list) else []

    raw = _read_raw_settings()
    accounts = [item for item in raw.get("accounts", []) if isinstance(item, dict)]
    current = next((item for item in accounts if str(item.get("accountId") or "") == account_id), None)
    current_credentials = current.get("credentials") if isinstance(current and current.get("credentials"), dict) else {}
    next_credentials = {
        "apiKey": str(credentials.get("apiKey") or current_credentials.get("apiKey") or "").strip(),
        "apiSecret": str(credentials.get("apiSecret") or current_credentials.get("apiSecret") or "").strip(),
        "passphrase": str(credentials.get("passphrase") or current_credentials.get("passphrase") or "").strip(),
    }

    normalized_scopes = [
        _normalize_scope(scope, account_market=market, create_id=create_id, now_value=now_ts)
        for scope in scopes_payload
        if isinstance(scope, dict)
    ]
    if not normalized_scopes:
        normalized_scopes = [_normalize_scope({}, account_market=market, create_id=create_id, now_value=now_ts)]

    if market == "crypto" and any(scope["enabled"] and scope["connectionMode"] == "live" for scope in normalized_scopes):
        if not next_credentials["apiKey"] or not next_credentials["apiSecret"]:
            raise HTTPException(status_code=400, detail="Readonly crypto account requires apiKey and apiSecret for live scopes")

    next_row = {
        "accountId": account_id,
        "label": label,
        "market": market,
        "providerId": provider_id,
        "brokerId": provider_id,
        "exchangeId": exchange_id,
        "enabled": enabled,
        "mode": "readonly",
        "credentials": next_credentials,
        "status": current.get("status") if isinstance(current and current.get("status"), dict) else {},
        "scopes": normalized_scopes,
        "createdAt": int(current.get("createdAt") or now_ts) if current else now_ts,
        "updatedAt": now_ts,
    }

    next_accounts = [item for item in accounts if str(item.get("accountId") or "") != account_id]
    next_accounts.append(next_row)
    raw["accounts"] = sorted(next_accounts, key=lambda item: (str(item.get("market") or ""), str(item.get("label") or "")))
    if "connections" in raw:
        del raw["connections"]
    _write_raw_settings(raw)
    return _build_public_account(next_row)


def set_account_connection_status(account_id: str, *, enabled: bool) -> dict[str, Any]:
    raw = _read_raw_settings()
    found = None
    next_accounts: list[dict[str, Any]] = []
    for item in raw.get("accounts", []):
        if not isinstance(item, dict):
            continue
        if str(item.get("accountId") or "") == account_id:
            item = {**item, "enabled": enabled, "updatedAt": now_ms()}
            found = item
        next_accounts.append(item)
    if found is None:
        raise HTTPException(status_code=404, detail="Account connection not found")
    raw["accounts"] = next_accounts
    _write_raw_settings(raw)
    return _build_public_account(found)


def delete_account_connection(account_id: str) -> dict[str, Any]:
    raw = _read_raw_settings()
    accounts = [item for item in raw.get("accounts", []) if isinstance(item, dict)]
    found = next((item for item in accounts if str(item.get("accountId") or "") == account_id), None)
    if found is None:
        raise HTTPException(status_code=404, detail="Account connection not found")
    raw["accounts"] = [item for item in accounts if str(item.get("accountId") or "") != account_id]
    _write_raw_settings(raw)
    return {"accountId": account_id, "deleted": True}


def update_account_connection_status(account_id: str, *, ok: bool, code: str = "", message: str) -> dict[str, Any]:
    raw = _read_raw_settings()
    found = None
    next_accounts: list[dict[str, Any]] = []
    for item in raw.get("accounts", []):
        if not isinstance(item, dict):
            continue
        if str(item.get("accountId") or "") == account_id:
            item = {**item, "status": {"ok": ok, "code": code, "message": message, "checkedAt": now_ms()}, "updatedAt": now_ms()}
            found = item
        next_accounts.append(item)
    if found is None:
        raise HTTPException(status_code=404, detail="Account connection not found")
    raw["accounts"] = next_accounts
    _write_raw_settings(raw)
    return _build_public_account(found)
