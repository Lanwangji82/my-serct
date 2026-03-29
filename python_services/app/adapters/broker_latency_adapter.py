from __future__ import annotations

import os
import time
from typing import Any, Callable

import httpx


class BrokerLatencyAdapter:
    endpoints: dict[str, dict[str, str]] = {
        "binance:sandbox": {
            "url": "https://testnet.binancefuture.com/fapi/v1/time",
            "label": "Binance Sandbox",
        },
        "binance:production": {
            "url": "https://fapi.binance.com/fapi/v1/time",
            "label": "Binance Production",
        },
        "okx:sandbox": {
            "url": "https://www.okx.com/api/v5/public/time",
            "label": "OKX Sandbox",
        },
        "okx:production": {
            "url": "https://www.okx.com/api/v5/public/time",
            "label": "OKX Production",
        },
    }

    def __init__(
        self,
        *,
        now_ms: Callable[[], int],
        proxy_environment_resolver: Callable[[str | None], dict[str, str]],
    ) -> None:
        self.now_ms = now_ms
        self.proxy_environment_resolver = proxy_environment_resolver

    def parse_broker_target(self, target: str | None) -> tuple[str, str, str]:
        if not target or target == "paper":
            return "paper", "paper", "paper"
        broker_id, broker_mode = target.split(":", 1)
        if broker_id not in {"binance", "okx", "bybit", "ibkr"}:
            broker_id = "binance"
        if broker_mode != "production":
            broker_mode = "sandbox"
        return broker_id, broker_mode, f"{broker_id}:{broker_mode}"

    def build_httpx_client(self, broker_target: str | None = None) -> httpx.Client:
        proxy_env = self.proxy_environment_resolver(broker_target)
        proxy = ""
        if proxy_env["socksProxy"]:
            proxy = proxy_env["socksProxy"]
        elif proxy_env["httpsProxy"]:
            proxy = proxy_env["httpsProxy"]
        elif proxy_env["httpProxy"]:
            proxy = proxy_env["httpProxy"]

        timeout_seconds = max(int(os.getenv("PLATFORM_HTTP_TIMEOUT_MS", "10000")) / 1000.0, 1.0)
        return httpx.Client(
            proxy=proxy or None,
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=True,
            headers={
                "User-Agent": "QuantX/0.1",
                "Accept": "application/json",
            },
        )

    def fetch_json_via_http(self, url: str, broker_target: str | None = None, retries: int = 1) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                with self.build_httpx_client(broker_target) as client:
                    response = client.get(url)
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as exc:
                raise RuntimeError(f"HTTP {exc.response.status_code}: {url}") from exc
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt >= retries:
                    break
                time.sleep(0.25)
        raise RuntimeError(f"Network error: {last_error}")

    def parse_remote_time(self, normalized_target: str, payload: dict[str, Any]) -> int | None:
        if normalized_target.startswith("binance:"):
            server_time = payload.get("serverTime")
            return int(server_time) if server_time is not None else None
        if normalized_target.startswith("okx:"):
            data = payload.get("data") or []
            if data and isinstance(data[0], dict):
                ts = data[0].get("ts")
                return int(ts) if ts is not None else None
        return None

    def measure_broker_latency(self, broker_target: str, market_type: str = "futures") -> dict[str, Any]:
        _, _, normalized = self.parse_broker_target(broker_target)
        endpoint = self.endpoints.get(normalized)
        if not endpoint:
            raise RuntimeError(f"Unsupported broker target: {normalized}")
        started_at = self.now_ms()
        started_perf = time.perf_counter()
        payload = self.fetch_json_via_http(endpoint["url"], normalized)
        latency_ms = round((time.perf_counter() - started_perf) * 1000, 2)
        remote_time = self.parse_remote_time(normalized, payload)
        return {
            "brokerTarget": normalized,
            "ok": True,
            "latencyMs": latency_ms,
            "remoteTime": remote_time,
            "label": endpoint["label"],
            "checkedAt": started_at,
        }

    def list_supported_targets(self) -> list[str]:
        return list(self.endpoints.keys())
