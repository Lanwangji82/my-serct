from __future__ import annotations

import json
from pathlib import Path
from threading import Lock, Thread
from typing import Any, Callable


class BacktestService:
    def __init__(
        self,
        *,
        db: Any,
        backtest_store_root: Path,
        cached_json: Callable[[str, int, Callable[[], Any]], Any],
        now_ms: Callable[[], int],
        create_id: Callable[[str], str],
        audit_event: Callable[[str, str, dict[str, Any]], dict[str, Any]],
        run_fmz_backtest: Callable[..., dict[str, Any]],
        fmz_backtest_config_cls: Any,
        default_python_strategy: str,
    ) -> None:
        self.db = db
        self.backtest_store_root = backtest_store_root
        self.cached_json = cached_json
        self.now_ms = now_ms
        self.create_id = create_id
        self.audit_event = audit_event
        self.run_fmz_backtest = run_fmz_backtest
        self.fmz_backtest_config_cls = fmz_backtest_config_cls
        self.default_python_strategy = default_python_strategy
        self.backtest_detail_fields = ("equityCurve", "trades", "marketRows", "logs", "assetRows", "statusInfo", "summary")
        self.non_persisted_backtest_fields = ("params", "engineConfig")
        self._backtest_detail_lock = Lock()

    def backtest_sort_key(self, item: dict[str, Any]) -> int:
        return int(item.get("completedAt") or item.get("startedAt") or item.get("queuedAt") or 0)

    def backtest_detail_path(self, run_id: str) -> Path:
        return self.backtest_store_root / f"{run_id}.json"

    def read_backtest_details(self, run_id: str) -> dict[str, Any]:
        path = self.backtest_detail_path(run_id)
        with self._backtest_detail_lock:
            if not path.exists():
                return {}
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                path.unlink(missing_ok=True)
                return {}

    def write_backtest_details(self, run_id: str, details: dict[str, Any]) -> None:
        path = self.backtest_detail_path(run_id)
        payload = {key: value for key, value in details.items() if key in self.backtest_detail_fields}
        with self._backtest_detail_lock:
            if not any(payload.get(key) for key in self.backtest_detail_fields):
                path.unlink(missing_ok=True)
                return
            temp_path = path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temp_path.replace(path)

    def split_backtest_record(self, item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        details = {key: item.get(key) for key in self.backtest_detail_fields if key in item}
        summary = {
            key: value
            for key, value in item.items()
            if key not in self.backtest_detail_fields and key not in self.non_persisted_backtest_fields
        }
        summary["hasDetails"] = any(details.get(key) for key in self.backtest_detail_fields)
        summary["detailCounts"] = {
            "equityCurve": len(details.get("equityCurve") or []),
            "trades": len(details.get("trades") or []),
            "marketRows": len(details.get("marketRows") or []),
            "logs": len(details.get("logs") or []),
            "assetRows": len(details.get("assetRows") or []),
        }
        return summary, details

    def merge_backtest_record(self, summary: dict[str, Any]) -> dict[str, Any]:
        return {**summary, **self.read_backtest_details(summary["id"])}

    def strip_backtest_details(self, item: dict[str, Any]) -> dict[str, Any]:
        compact = {key: value for key, value in item.items() if key not in self.backtest_detail_fields}
        if "detailCounts" not in compact:
            compact["detailCounts"] = {
                "equityCurve": len(item.get("equityCurve") or []),
                "trades": len(item.get("trades") or []),
                "marketRows": len(item.get("marketRows") or []),
                "logs": len(item.get("logs") or []),
                "assetRows": len(item.get("assetRows") or []),
            }
        compact["hasDetails"] = bool(compact.get("hasDetails") or any(compact["detailCounts"].values()))
        return compact

    def find_backtest_run(self, run_id: str) -> dict[str, Any] | None:
        def load() -> dict[str, Any] | None:
            if hasattr(self.db, "find_one"):
                summary = self.db.find_one("backtests", {"id": run_id})
            else:
                state = self.db.read()
                summary = next((item for item in state["backtests"] if item["id"] == run_id), None)
            return self.merge_backtest_record(summary) if summary else None

        return self.cached_json(f"backtests:detail:{run_id}", 5000, load)

    def migrate_backtests_to_file_store(self) -> None:
        state = self.db.read()
        migrated = False
        summaries: list[dict[str, Any]] = []
        for item in state["backtests"]:
            if any(key in item for key in self.backtest_detail_fields) or any(key in item for key in self.non_persisted_backtest_fields) or "detailCounts" not in item:
                summary, details = self.split_backtest_record(item)
                self.write_backtest_details(summary["id"], details)
                summaries.append(summary)
                migrated = True
            else:
                summaries.append(item)
        if migrated:
            self.db.write({**state, "backtests": summaries[:200]})

    def update_backtest_run(self, run_id: str, updater: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        if hasattr(self.db, "find_one"):
            summary = self.db.find_one("backtests", {"id": run_id})
            if not summary:
                return
            merged = self.merge_backtest_record(summary)
            next_item = updater(dict(merged))
            next_summary, details = self.split_backtest_record(next_item)
            self.write_backtest_details(run_id, details)
            self.db.upsert_one("backtests", next_summary)
            return

        def mutate(current: dict[str, Any]) -> dict[str, Any]:
            runs: list[dict[str, Any]] = []
            for item in current["backtests"]:
                if item["id"] == run_id:
                    merged = self.merge_backtest_record(item)
                    next_item = updater(dict(merged))
                    summary, details = self.split_backtest_record(next_item)
                    self.write_backtest_details(run_id, details)
                    item = summary
                runs.append(item)
            return {**current, "backtests": runs[:200]}

        self.db.update(mutate)

    def append_backtest_log(self, run_id: str, message: str, level: str = "system", progress_pct: int | None = None) -> None:
        timestamp = self.now_ms()

        def mutate(item: dict[str, Any]) -> dict[str, Any]:
            logs = list(item.get("logs") or [])
            logs.append({"time": timestamp, "level": level, "message": message})
            item["logs"] = logs[-300:]
            if progress_pct is not None:
                item["progressPct"] = progress_pct
            item["updatedAt"] = timestamp
            return item

        self.update_backtest_run(run_id, mutate)

    def build_backtest_contract(self, payload: Any, strategy: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], Any]:
        effective_leverage = max(float(payload.leverage or strategy.get("risk", {}).get("maxLeverage") or 1), 1)
        params = {
            "strategyId": payload.strategyId,
            "brokerTarget": payload.brokerTarget,
            "startTime": payload.startTime,
            "endTime": payload.endTime,
            "period": payload.period,
            "basePeriod": payload.basePeriod,
            "mode": payload.mode,
            "initialCapital": payload.initialCapital,
            "quoteAsset": payload.quoteAsset,
            "tolerancePct": payload.tolerancePct,
            "openFeePct": payload.openFeePct,
            "closeFeePct": payload.closeFeePct,
            "slippagePoints": payload.slippagePoints,
            "candleLimit": payload.candleLimit,
            "chartDisplay": payload.chartDisplay,
            "depthMin": payload.depthMin,
            "depthMax": payload.depthMax,
            "recordEvents": payload.recordEvents,
            "chartBars": payload.chartBars,
            "delayMs": payload.delayMs,
            "logLimit": payload.logLimit,
            "profitLimit": payload.profitLimit,
            "dataSource": payload.dataSource,
            "orderMode": payload.orderMode,
            "distributor": payload.distributor,
            "leverage": effective_leverage,
            "symbol": strategy.get("symbol") or "ETHUSDT",
            "marketType": strategy.get("marketType") or "futures",
        }
        engine_config = {
            "brokerTarget": payload.brokerTarget,
            "symbol": params["symbol"],
            "marketType": params["marketType"],
            "period": payload.period,
            "basePeriod": payload.basePeriod,
            "startTime": payload.startTime,
            "endTime": payload.endTime,
            "mode": payload.mode,
            "quoteAsset": payload.quoteAsset,
            "tolerancePct": payload.tolerancePct,
            "candleLimit": payload.candleLimit,
            "chartDisplay": payload.chartDisplay,
            "depthMin": payload.depthMin,
            "depthMax": payload.depthMax,
            "recordEvents": payload.recordEvents,
            "dataSource": payload.dataSource,
            "orderMode": payload.orderMode,
            "distributor": payload.distributor,
            "leverage": effective_leverage,
            "slippagePoints": payload.slippagePoints,
            "logLimit": payload.logLimit,
            "profitLimit": payload.profitLimit,
            "chartBars": payload.chartBars,
            "delayMs": payload.delayMs,
            "initialCapital": payload.initialCapital,
            "openFeePct": payload.openFeePct,
            "closeFeePct": payload.closeFeePct,
        }
        config = self.fmz_backtest_config_cls(
            strategy_id=payload.strategyId,
            broker_target=payload.brokerTarget,
            symbol=params["symbol"],
            market_type=params["marketType"],
            period=payload.period or strategy.get("interval") or "4h",
            base_period=payload.basePeriod,
            start_time=payload.startTime,
            end_time=payload.endTime,
            mode=payload.mode,
            initial_capital=payload.initialCapital,
            quote_asset=payload.quoteAsset,
            tolerance_pct=payload.tolerancePct,
            open_fee_pct=payload.openFeePct,
            close_fee_pct=payload.closeFeePct,
            slippage_points=payload.slippagePoints,
            candle_limit=payload.candleLimit,
            chart_display=payload.chartDisplay,
            depth_min=payload.depthMin,
            depth_max=payload.depthMax,
            record_events=payload.recordEvents,
            leverage=effective_leverage,
            chart_bars=payload.chartBars,
            delay_ms=payload.delayMs,
            log_limit=payload.logLimit,
            profit_limit=payload.profitLimit,
            data_source=payload.dataSource,
            order_mode=payload.orderMode,
            distributor=payload.distributor,
        )
        return params, engine_config, config

    def list_backtests(self, strategy_id: str | None = None, include_details: bool = False, limit: int = 100) -> list[dict[str, Any]]:
        normalized_limit = max(1, min(limit, 200))
        cache_key = f"backtests:list:{strategy_id or 'all'}:{int(bool(include_details))}:{normalized_limit}"

        def load():
            if hasattr(self.db, "list_collection"):
                filter_query = {"strategyId": strategy_id} if strategy_id else {}
                sorted_runs = self.db.list_collection("backtests", sort=[("updatedAt", -1)], limit=normalized_limit, filter_query=filter_query)
            else:
                state = self.db.read()
                runs = [item for item in state["backtests"] if not strategy_id or item["strategyId"] == strategy_id]
                sorted_runs = sorted(runs, key=self.backtest_sort_key, reverse=True)[: normalized_limit]
            if include_details:
                return [self.merge_backtest_record(item) for item in sorted_runs]
            return [self.strip_backtest_details(item) for item in sorted_runs]

        return self.cached_json(cache_key, 5000 if not include_details else 2000, load)

    def queue_backtest(self, payload: Any, actor_user_id: str, strategy: dict[str, Any]) -> dict[str, Any]:
        queued_at = self.now_ms()
        params, engine_config, _ = self.build_backtest_contract(payload, strategy)
        result = {
            "id": self.create_id("bt"),
            "strategyId": payload.strategyId,
            "source": "fmz-official-local",
            "status": "queued",
            "progressPct": 0,
            "queuedAt": queued_at,
            "startedAt": None,
            "completedAt": None,
            "updatedAt": queued_at,
            "errorMessage": None,
            "params": params,
            "engineConfig": engine_config,
            "metrics": {
                "totalReturnPct": 0.0,
                "sharpe": 0.0,
                "maxDrawdownPct": 0.0,
                "winRatePct": 0.0,
                "trades": 0,
                "endingEquity": payload.initialCapital,
            },
            "equityCurve": [],
            "trades": [],
            "marketRows": [],
            "logs": [],
            "assetRows": [],
            "statusInfo": {
                "backtestStatus": 0,
                "finished": False,
                "progress": 0,
                "logsCount": 0,
                "loadBytes": 0,
                "loadElapsed": 0,
                "elapsed": 0,
                "lastPrice": 0,
                "equity": payload.initialCapital,
                "utilization": 0,
                "longAmount": 0,
                "shortAmount": 0,
                "estimatedProfit": 0,
                "tradeCount": 0,
                "mode": payload.mode,
                "quoteAsset": payload.quoteAsset,
                "tolerancePct": payload.tolerancePct,
                "candleLimit": payload.candleLimit,
                "chartDisplay": payload.chartDisplay,
                "depthMin": payload.depthMin,
                "depthMax": payload.depthMax,
                "recordEvents": payload.recordEvents,
                "leverage": params["leverage"],
                "chartBars": payload.chartBars,
                "delayMs": payload.delayMs,
                "logLimit": payload.logLimit,
                "profitLimit": payload.profitLimit,
                "dataSource": payload.dataSource,
                "orderMode": payload.orderMode,
            },
            "summary": {
                "barCount": 0,
                "orderCount": 0,
                "dataSource": "fmz-official-local-engine",
                "startedAtText": payload.startTime,
                "endedAtText": payload.endTime,
                "durationMs": 0,
                "period": payload.period,
                "basePeriod": payload.basePeriod,
                "mode": payload.mode,
                "quoteAsset": payload.quoteAsset,
                "tolerancePct": payload.tolerancePct,
                "candleLimit": payload.candleLimit,
                "chartDisplay": payload.chartDisplay,
                "depthMin": payload.depthMin,
                "depthMax": payload.depthMax,
                "recordEvents": payload.recordEvents,
                "leverage": params["leverage"],
                "chartBars": payload.chartBars,
                "delayMs": payload.delayMs,
                "logLimit": payload.logLimit,
                "profitLimit": payload.profitLimit,
                "orderMode": payload.orderMode,
            },
        }
        summary, details = self.split_backtest_record(result)
        self.write_backtest_details(summary["id"], details)
        if hasattr(self.db, "upsert_one"):
            self.db.upsert_one("backtests", summary)
        else:
            self.db.update(lambda current: {**current, "backtests": [summary, *current["backtests"]][:200]})
        self.audit_event(actor_user_id, "backtest.run.queued", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": result["id"]})
        self.start_backtest_job(result["id"], actor_user_id, strategy, payload)
        return self.strip_backtest_details(summary)

    def start_backtest_job(self, run_id: str, actor_user_id: str, strategy: dict[str, Any], payload: Any) -> None:
        def worker():
            self.append_backtest_log(run_id, "回测任务已创建，等待执行。", progress_pct=5)

            def set_running(item: dict[str, Any]) -> dict[str, Any]:
                started_at = self.now_ms()
                item["status"] = "running"
                item["startedAt"] = started_at
                item["progressPct"] = 10
                item["updatedAt"] = started_at
                return item

            self.update_backtest_run(run_id, set_running)
            self.append_backtest_log(run_id, "FMZ 本地回测引擎已启动。", progress_pct=12)

            _, _, config = self.build_backtest_contract(payload, strategy)

            try:
                run = self.run_fmz_backtest(
                    strategy.get("sourceCode") or self.default_python_strategy,
                    config,
                    progress_callback=lambda progress, message: self.append_backtest_log(run_id, message, progress_pct=progress),
                )

                def finalize(item: dict[str, Any]) -> dict[str, Any]:
                    completed_at = self.now_ms()
                    logs = list(item.get("logs") or [])
                    result_logs = list(run.get("logs") or [])
                    item.update(run)
                    item["status"] = "completed"
                    item["progressPct"] = 100
                    item["completedAt"] = completed_at
                    item["updatedAt"] = completed_at
                    item["logs"] = (logs + result_logs)[-300:]
                    item["errorMessage"] = None
                    return item

                self.update_backtest_run(run_id, finalize)
                self.append_backtest_log(run_id, "回测完成。", progress_pct=100)
                self.audit_event(actor_user_id, "backtest.run.completed", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": run_id})
            except Exception as exc:
                error_text = str(exc)

                def fail(item: dict[str, Any]) -> dict[str, Any]:
                    failed_at = self.now_ms()
                    item["status"] = "failed"
                    item["errorMessage"] = error_text
                    item["completedAt"] = failed_at
                    item["updatedAt"] = failed_at
                    item["progressPct"] = min(int(item.get("progressPct") or 0), 95)
                    return item

                self.update_backtest_run(run_id, fail)
                self.append_backtest_log(run_id, f"回测失败：{error_text}", level="error")
                self.audit_event(actor_user_id, "backtest.run.failed", {"strategyId": payload.strategyId, "brokerTarget": payload.brokerTarget, "runId": run_id, "error": error_text})

        Thread(target=worker, daemon=True).start()
