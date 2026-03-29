from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field


SUPPORTED_LLM_PROVIDERS = {"openai", "zhipu"}

DEFAULT_TUSHARE_BASE_URL = "http://api.tushare.pro"
DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
DEFAULT_LLM_MODEL = "gpt-5.4-mini"
ZHIPU_LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_LLM_MODEL = "glm-4.5"


class TushareConfigPayload(BaseModel):
    enabled: bool = True
    token: str = Field(default="", max_length=256)
    baseUrl: str = Field(default=DEFAULT_TUSHARE_BASE_URL, max_length=512)


class LlmConfigPayload(BaseModel):
    enabled: bool = False
    provider: str = Field(default="openai", max_length=64)
    apiKey: str = Field(default="", max_length=512)
    baseUrl: str = Field(default=DEFAULT_LLM_BASE_URL, max_length=512)
    model: str = Field(default=DEFAULT_LLM_MODEL, max_length=128)


def now_ms() -> int:
    return int(time.time() * 1000)


def _mask_secret(value: str) -> str:
    secret = value.strip()
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}{'*' * (len(secret) - 8)}{secret[-4:]}"


def _normalize_tushare_base_url(value: str) -> str:
    base = (value or "").strip()
    if not base:
        return DEFAULT_TUSHARE_BASE_URL
    lowered = base.lower()
    if "tushare.pro/document" in lowered or "doc_id=" in lowered:
        return DEFAULT_TUSHARE_BASE_URL
    return base.rstrip("/")


def _normalize_llm_provider(value: str) -> str:
    provider = (value or "openai").strip().lower()
    return provider if provider in SUPPORTED_LLM_PROVIDERS else "openai"


def _default_llm_base_url(provider: str) -> str:
    if _normalize_llm_provider(provider) == "zhipu":
        return ZHIPU_LLM_BASE_URL
    return DEFAULT_LLM_BASE_URL


def _default_llm_model(provider: str) -> str:
    if _normalize_llm_provider(provider) == "zhipu":
        return ZHIPU_LLM_MODEL
    return DEFAULT_LLM_MODEL


def _normalize_llm_base_url(value: str, provider: str = "openai") -> str:
    base = (value or "").strip()
    if not base:
        return _default_llm_base_url(provider)
    return base.rstrip("/")


def _normalize_llm_model(value: str, provider: str = "openai") -> str:
    model = (value or "").strip()
    if model:
        return model
    return _default_llm_model(provider)


def _default_public_settings() -> dict[str, Any]:
    return {
        "tushare": {
            "enabled": False,
            "configured": False,
            "baseUrl": DEFAULT_TUSHARE_BASE_URL,
            "tokenMasked": "",
            "status": {"ok": False, "message": "尚未配置 Tushare Token。", "checkedAt": 0},
        },
        "llm": {
            "enabled": False,
            "configured": False,
            "provider": "openai",
            "baseUrl": DEFAULT_LLM_BASE_URL,
            "model": DEFAULT_LLM_MODEL,
            "apiKeyMasked": "",
            "mode": "system",
            "status": {"ok": False, "message": "未配置大模型 API，将使用系统规则过滤。", "checkedAt": 0},
        },
    }


def get_data_provider_settings_path() -> Path:
    default_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "data-providers.json"
    legacy_path = Path(__file__).resolve().parent.parent.parent / "config" / "data-providers.json"
    path = Path(os.getenv("PLATFORM_DATA_PROVIDER_SETTINGS_PATH", default_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path == default_path and not path.exists() and legacy_path.exists():
        try:
            path.write_text(legacy_path.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            pass
    return path


def _read_raw_settings() -> dict[str, Any]:
    path = get_data_provider_settings_path()
    if not path.exists():
        return {
            "tushare": {"enabled": False, "token": "", "baseUrl": DEFAULT_TUSHARE_BASE_URL, "status": {}},
            "llm": {
                "enabled": False,
                "provider": "openai",
                "apiKey": "",
                "baseUrl": DEFAULT_LLM_BASE_URL,
                "model": DEFAULT_LLM_MODEL,
                "status": {},
            },
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _write_raw_settings(payload: dict[str, Any]) -> None:
    get_data_provider_settings_path().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_public_tushare_summary(*, enabled: bool, token: str, base_url: str, status: dict[str, Any] | None = None) -> dict[str, Any]:
    current_status = status if isinstance(status, dict) else {}
    return {
        "enabled": bool(enabled) and bool(token),
        "configured": bool(token),
        "baseUrl": _normalize_tushare_base_url(base_url),
        "tokenMasked": _mask_secret(token),
        "status": {
            "ok": bool(current_status.get("ok")),
            "message": str(current_status.get("message") or ("已配置 Tushare Token。" if token else "尚未配置 Tushare Token。")),
            "checkedAt": int(current_status.get("checkedAt") or 0),
        },
    }


def _build_public_llm_summary(
    *,
    enabled: bool,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current_status = status if isinstance(status, dict) else {}
    normalized_provider = _normalize_llm_provider(provider)
    configured = bool(api_key.strip())
    active = bool(enabled) and configured
    return {
        "enabled": active,
        "configured": configured,
        "provider": normalized_provider,
        "baseUrl": _normalize_llm_base_url(base_url, normalized_provider),
        "model": _normalize_llm_model(model, normalized_provider),
        "apiKeyMasked": _mask_secret(api_key),
        "mode": "llm" if active else "system",
        "status": {
            "ok": bool(current_status.get("ok")) if active else False,
            "message": str(current_status.get("message") or ("大模型分析已启用。" if active else "未配置大模型 API，将使用系统规则过滤。")),
            "checkedAt": int(current_status.get("checkedAt") or 0),
        },
    }


def get_tushare_credentials() -> dict[str, str]:
    raw = _read_raw_settings().get("tushare", {})
    return {
        "token": str(raw.get("token") or "").strip(),
        "baseUrl": _normalize_tushare_base_url(str(raw.get("baseUrl") or DEFAULT_TUSHARE_BASE_URL)),
    }


def get_llm_credentials() -> dict[str, str]:
    raw = _read_raw_settings().get("llm", {})
    provider = _normalize_llm_provider(str(raw.get("provider") or "openai"))
    return {
        "provider": provider,
        "apiKey": str(raw.get("apiKey") or "").strip(),
        "baseUrl": _normalize_llm_base_url(str(raw.get("baseUrl") or _default_llm_base_url(provider)), provider),
        "model": _normalize_llm_model(str(raw.get("model") or _default_llm_model(provider)), provider),
    }


def is_llm_analysis_enabled() -> bool:
    settings = get_data_provider_settings().get("llm", {})
    return bool(settings.get("enabled")) and bool(settings.get("configured"))


def get_data_provider_settings() -> dict[str, Any]:
    defaults = _default_public_settings()
    raw = _read_raw_settings()
    tushare = raw.get("tushare", {})
    llm = raw.get("llm", {})
    defaults["tushare"] = _build_public_tushare_summary(
        enabled=bool(tushare.get("enabled")),
        token=str(tushare.get("token") or "").strip(),
        base_url=str(tushare.get("baseUrl") or DEFAULT_TUSHARE_BASE_URL),
        status=tushare.get("status") if isinstance(tushare.get("status"), dict) else {},
    )
    defaults["llm"] = _build_public_llm_summary(
        enabled=bool(llm.get("enabled")),
        provider=str(llm.get("provider") or "openai"),
        api_key=str(llm.get("apiKey") or "").strip(),
        base_url=str(llm.get("baseUrl") or DEFAULT_LLM_BASE_URL),
        model=str(llm.get("model") or DEFAULT_LLM_MODEL),
        status=llm.get("status") if isinstance(llm.get("status"), dict) else {},
    )
    return defaults


def save_tushare_settings(payload: TushareConfigPayload) -> dict[str, Any]:
    raw = _read_raw_settings()
    current = raw.get("tushare", {}) if isinstance(raw.get("tushare"), dict) else {}
    existing_token = str(current.get("token") or "").strip()
    next_token = payload.token.strip() or existing_token
    if payload.enabled and not next_token:
        raise HTTPException(status_code=400, detail="启用 Tushare 前请先填写 Token。")
    raw["tushare"] = {
        "enabled": bool(payload.enabled) and bool(next_token),
        "token": next_token,
        "baseUrl": _normalize_tushare_base_url(payload.baseUrl),
        "status": current.get("status") if isinstance(current.get("status"), dict) else {},
    }
    _write_raw_settings(raw)
    return get_data_provider_settings()


def save_llm_settings(payload: LlmConfigPayload) -> dict[str, Any]:
    raw = _read_raw_settings()
    current = raw.get("llm", {}) if isinstance(raw.get("llm"), dict) else {}
    existing_api_key = str(current.get("apiKey") or "").strip()
    current_provider = _normalize_llm_provider(str(current.get("provider") or "openai"))
    provider = _normalize_llm_provider(payload.provider or str(current.get("provider") or "openai"))
    next_api_key = payload.apiKey.strip() or existing_api_key
    current_base_url = str(current.get("baseUrl") or _default_llm_base_url(current_provider))
    current_model = str(current.get("model") or _default_llm_model(current_provider))
    next_base_url = _normalize_llm_base_url(
        payload.baseUrl or (current_base_url if provider == current_provider else _default_llm_base_url(provider)),
        provider,
    )
    next_model = _normalize_llm_model(
        payload.model or (current_model if provider == current_provider else _default_llm_model(provider)),
        provider,
    )
    raw["llm"] = {
        "enabled": bool(payload.enabled) and bool(next_api_key),
        "provider": provider,
        "apiKey": next_api_key,
        "baseUrl": next_base_url,
        "model": next_model,
        "status": current.get("status") if isinstance(current.get("status"), dict) else {},
    }
    if not next_api_key:
        raw["llm"]["status"] = {
            "ok": False,
            "message": "未配置大模型 API，将使用系统规则过滤。",
            "checkedAt": now_ms(),
        }
    _write_raw_settings(raw)
    return get_data_provider_settings()


def request_tushare_api(
    api_name: str,
    *,
    params: dict[str, Any] | None = None,
    fields: str = "",
    token: str | None = None,
    base_url: str | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    credentials = get_tushare_credentials()
    resolved_token = (token or credentials["token"]).strip()
    resolved_base_url = _normalize_tushare_base_url(base_url or credentials["baseUrl"] or DEFAULT_TUSHARE_BASE_URL)
    if not resolved_token:
        raise RuntimeError("Tushare token is not configured.")
    body = json.dumps(
        {"api_name": api_name, "token": resolved_token, "params": params or {}, "fields": fields}
    ).encode("utf-8")
    request = urllib.request.Request(
        resolved_base_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "QuantX/0.1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="ignore")
        payload = json.loads(raw)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.reason}") from exc
    except Exception as exc:
        raise RuntimeError(str(exc)) from exc
    code = int(payload.get("code") or 0)
    if code != 0:
        raise RuntimeError(str(payload.get("msg") or f"Tushare returned code {code}"))
    return payload


def request_llm_chat(messages: list[dict[str, str]], *, temperature: float = 0.2, timeout: int = 20) -> str:
    credentials = get_llm_credentials()
    api_key = credentials["apiKey"].strip()
    if not api_key:
        raise RuntimeError("LLM API key is not configured.")

    provider = _normalize_llm_provider(credentials["provider"])
    base_url = _normalize_llm_base_url(credentials["baseUrl"], provider)
    configured_model = _normalize_llm_model(credentials["model"], provider)
    fallback_models = [configured_model]

    if provider == "openai" and configured_model == "gpt-5.4-mini":
        fallback_models.append("gpt-5.4")
    if provider == "zhipu" and configured_model == ZHIPU_LLM_MODEL:
        fallback_models.append("glm-4-air")

    last_error: Exception | None = None

    for model in fallback_models:
        try:
            url = f"{base_url}/chat/completions"
            body = json.dumps(
                {
                    "model": model,
                    "temperature": temperature,
                    "messages": messages,
                }
            ).encode("utf-8")
            request = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "QuantX/0.1",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="ignore")
            payload = json.loads(raw)
            choices = payload.get("choices", []) or []
            if not choices:
                raise RuntimeError("LLM response does not contain choices.")
            content = choices[0].get("message", {}).get("content")
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("LLM response content is empty.")
            return content
        except urllib.error.HTTPError as exc:
            last_error = RuntimeError(f"HTTP {exc.code}: {exc.reason}")
        except Exception as exc:
            last_error = RuntimeError(str(exc))

    if last_error is not None:
        raise last_error
    raise RuntimeError("LLM request failed.")


def _request_tushare_validation(token: str, base_url: str, *, enabled: bool) -> dict[str, Any]:
    checked_at = now_ms()
    if not token:
        return {"ok": False, "message": "未提供 Tushare Token。", "checkedAt": checked_at, "enabled": False}
    try:
        payload = request_tushare_api(
            "trade_cal",
            token=token,
            base_url=base_url,
            params={"exchange": "SSE", "start_date": "20260101", "end_date": "20260110", "is_open": "1"},
            fields="exchange,cal_date,is_open",
        )
        items = payload.get("data", {}).get("items", []) or []
        return {
            "ok": True,
            "message": f"Tushare 已连通，trade_cal 测试成功，返回 {len(items)} 条记录。",
            "checkedAt": checked_at,
            "enabled": enabled,
        }
    except Exception as exc:
        return {"ok": False, "message": str(exc), "checkedAt": checked_at, "enabled": enabled}


def _request_llm_validation(
    *,
    api_key: str,
    provider: str,
    base_url: str,
    model: str,
    enabled: bool,
    checked_at: int,
) -> dict[str, Any]:
    if not api_key.strip():
        return {
            "ok": False,
            "message": "未配置大模型 API，将使用系统规则过滤。",
            "checkedAt": checked_at,
            "enabled": False,
        }
    try:
        normalized_provider = _normalize_llm_provider(provider)
        normalized_base_url = _normalize_llm_base_url(base_url, normalized_provider)
        normalized_model = _normalize_llm_model(model, normalized_provider)
        url = f"{normalized_base_url}/chat/completions"
        body = json.dumps(
            {
                "model": normalized_model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": '请只返回 JSON，例如 {"ok": true, "message": "pong"}。'},
                    {"role": "user", "content": "ping"},
                ],
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key.strip()}",
                "User-Agent": "QuantX/0.1",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="ignore")
        payload = json.loads(raw)
        choices = payload.get("choices", []) or []
        if not choices:
            raise RuntimeError("LLM response does not contain choices.")
        content = choices[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("LLM response content is empty.")
        return {
            "ok": True,
            "message": f"已验证 {normalized_provider} / {normalized_model}，大模型分析可用。",
            "checkedAt": checked_at,
            "enabled": enabled,
        }
    except Exception as exc:
        return {"ok": False, "message": str(exc), "checkedAt": checked_at, "enabled": enabled}


def validate_tushare_settings(payload: TushareConfigPayload | None = None) -> dict[str, Any]:
    if payload is None:
        creds = get_tushare_credentials()
        result = _request_tushare_validation(
            creds["token"],
            creds["baseUrl"],
            enabled=bool(get_data_provider_settings()["tushare"]["enabled"]),
        )
        _persist_tushare_status(result)
        return result
    current = get_tushare_credentials()
    result = _request_tushare_validation(
        payload.token.strip() or current["token"],
        payload.baseUrl.strip() or current["baseUrl"] or DEFAULT_TUSHARE_BASE_URL,
        enabled=bool(payload.enabled),
    )
    _persist_tushare_status(result)
    return result


def validate_llm_settings(payload: LlmConfigPayload | None = None) -> dict[str, Any]:
    checked_at = now_ms()
    if payload is None:
        creds = get_llm_credentials()
        result = _request_llm_validation(
            api_key=creds["apiKey"],
            provider=creds["provider"],
            base_url=creds["baseUrl"],
            model=creds["model"],
            enabled=bool(get_data_provider_settings()["llm"]["enabled"]),
            checked_at=checked_at,
        )
        _persist_llm_status(result)
        return result
    current = get_llm_credentials()
    provider = _normalize_llm_provider(payload.provider or current["provider"] or "openai")
    result = _request_llm_validation(
        api_key=payload.apiKey.strip() or current["apiKey"],
        provider=provider,
        base_url=payload.baseUrl.strip() or (current["baseUrl"] if provider == current["provider"] else _default_llm_base_url(provider)),
        model=payload.model.strip() or (current["model"] if provider == current["provider"] else _default_llm_model(provider)),
        enabled=bool(payload.enabled),
        checked_at=checked_at,
    )
    _persist_llm_status(result)
    return result


def build_tushare_validation_preview(payload: TushareConfigPayload, result: dict[str, Any]) -> dict[str, Any]:
    current = get_tushare_credentials()
    token = payload.token.strip() or current["token"]
    base_url = payload.baseUrl.strip() or current["baseUrl"] or DEFAULT_TUSHARE_BASE_URL
    return _build_public_tushare_summary(enabled=payload.enabled, token=token, base_url=base_url, status=result)


def build_llm_validation_preview(payload: LlmConfigPayload, result: dict[str, Any]) -> dict[str, Any]:
    current = get_llm_credentials()
    provider = _normalize_llm_provider(payload.provider or current["provider"] or "openai")
    api_key = payload.apiKey.strip() or current["apiKey"]
    base_url = payload.baseUrl.strip() or (current["baseUrl"] if provider == current["provider"] else _default_llm_base_url(provider))
    model = payload.model.strip() or (current["model"] if provider == current["provider"] else _default_llm_model(provider))
    return _build_public_llm_summary(
        enabled=payload.enabled,
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        status=result,
    )


def _persist_tushare_status(status: dict[str, Any]) -> None:
    raw = _read_raw_settings()
    current = raw.get("tushare", {}) if isinstance(raw.get("tushare"), dict) else {}
    raw["tushare"] = {
        "enabled": bool(current.get("enabled")),
        "token": str(current.get("token") or "").strip(),
        "baseUrl": _normalize_tushare_base_url(str(current.get("baseUrl") or DEFAULT_TUSHARE_BASE_URL)),
        "status": status,
    }
    _write_raw_settings(raw)


def _persist_llm_status(status: dict[str, Any]) -> None:
    raw = _read_raw_settings()
    current = raw.get("llm", {}) if isinstance(raw.get("llm"), dict) else {}
    provider = _normalize_llm_provider(str(current.get("provider") or "openai"))
    raw["llm"] = {
        "enabled": bool(current.get("enabled")) and bool(str(current.get("apiKey") or "").strip()),
        "provider": provider,
        "apiKey": str(current.get("apiKey") or "").strip(),
        "baseUrl": _normalize_llm_base_url(str(current.get("baseUrl") or _default_llm_base_url(provider)), provider),
        "model": _normalize_llm_model(str(current.get("model") or _default_llm_model(provider)), provider),
        "status": status,
    }
    _write_raw_settings(raw)
