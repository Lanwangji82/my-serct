from __future__ import annotations

from typing import Any


class DataProviderService:
    def __init__(
        self,
        *,
        app_port: int,
        local_mode: bool,
        database_path: str,
        strategy_store_root: str,
        runtime_summary_getter,
        provider_settings_getter,
        save_tushare_settings,
        validate_tushare_settings,
        build_tushare_validation_preview,
        save_llm_settings,
        validate_llm_settings,
        build_llm_validation_preview,
        now_ms,
    ) -> None:
        self.app_port = app_port
        self.local_mode = local_mode
        self.database_path = database_path
        self.strategy_store_root = strategy_store_root
        self.runtime_summary_getter = runtime_summary_getter
        self.provider_settings_getter = provider_settings_getter
        self.save_tushare_settings_fn = save_tushare_settings
        self.validate_tushare_settings_fn = validate_tushare_settings
        self.build_tushare_validation_preview_fn = build_tushare_validation_preview
        self.save_llm_settings_fn = save_llm_settings
        self.validate_llm_settings_fn = validate_llm_settings
        self.build_llm_validation_preview_fn = build_llm_validation_preview
        self.now_ms = now_ms

    def build_data_provider_config(self) -> dict[str, Any]:
        return {
            "appPort": self.app_port,
            "localMode": self.local_mode,
            "databasePath": self.database_path,
            "strategyStoreRoot": self.strategy_store_root,
            "proxy": self.runtime_summary_getter(),
            "dataProviders": self.provider_settings_getter(),
            "checkedAt": self.now_ms(),
        }

    def save_tushare_settings(self, payload: Any) -> dict[str, Any]:
        settings = self.save_tushare_settings_fn(payload)
        return {
            "tushare": settings["tushare"],
            "checkedAt": self.now_ms(),
        }

    def validate_tushare_settings(self, payload: Any | None = None) -> dict[str, Any]:
        result = self.validate_tushare_settings_fn(payload)
        return {
            "tushare": self.build_tushare_validation_preview_fn(payload, result) if payload is not None else self.provider_settings_getter()["tushare"],
            "result": result,
            "checkedAt": self.now_ms(),
        }

    def save_llm_settings(self, payload: Any) -> dict[str, Any]:
        settings = self.save_llm_settings_fn(payload)
        return {
            "llm": settings["llm"],
            "checkedAt": self.now_ms(),
        }

    def validate_llm_settings(self, payload: Any | None = None) -> dict[str, Any]:
        result = self.validate_llm_settings_fn(payload)
        return {
            "llm": self.build_llm_validation_preview_fn(payload, result) if payload is not None else self.provider_settings_getter()["llm"],
            "result": result,
            "checkedAt": self.now_ms(),
        }
