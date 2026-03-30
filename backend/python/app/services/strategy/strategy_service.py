from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any, Callable

try:
    from ...adapters.interfaces import CachedJsonLoader
    from ...repositories.platform_repository import PlatformRepository
except ImportError:
    from backend.python.app.adapters.interfaces import CachedJsonLoader
    from backend.python.app.repositories.platform_repository import PlatformRepository


class StrategyService:
    def __init__(
        self,
        *,
        db: PlatformRepository,
        strategy_store_root: Path,
        default_python_strategy: str,
        now_ms: Callable[[], int],
        create_id: Callable[[str], str],
        cached_json: CachedJsonLoader,
    ) -> None:
        self.db = db
        self.strategy_store_root = strategy_store_root
        self.default_python_strategy = default_python_strategy
        self.now_ms = now_ms
        self.create_id = create_id
        self.cached_json = cached_json

    @staticmethod
    def looks_corrupted_text(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        stripped = value.strip()
        if not stripped:
            return False
        return all(char == "?" for char in stripped)

    def normalize_strategy_record(self, strategy: dict[str, Any]) -> dict[str, Any]:
        normalized = {**strategy}
        template = normalized.get("template")
        symbol = normalized.get("symbol", "UNKNOWN")
        interval = normalized.get("interval", "")

        if not normalized.get("name") or self.looks_corrupted_text(normalized.get("name")):
            normalized["name"] = (f"Python Strategy {symbol} {interval}" if template == "python" else f"Strategy {symbol} {interval}").strip()

        if not normalized.get("description") or self.looks_corrupted_text(normalized.get("description")):
            normalized["description"] = "Please document this strategy in your IDE workspace."

        return normalized

    def slugify_filename(self, value: str) -> str:
        normalized = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "-", value.strip())
        normalized = re.sub(r"-{2,}", "-", normalized).strip("-_")
        return normalized or "strategy"

    def normalize_artifact_paths(self, artifact_summary: dict[str, Any] | None, strategy_dir: Path) -> dict[str, Any]:
        summary = dict(artifact_summary or {})
        version = summary.get("version")
        root_dir = strategy_dir
        summary["rootDir"] = str(root_dir)
        if version:
            summary["sourceFile"] = str(root_dir / f"v{version}.py")
            summary["metadataFile"] = str(root_dir / f"v{version}.json")
        else:
            summary["sourceFile"] = summary.get("sourceFile") or str(root_dir / "latest.py")
            summary["metadataFile"] = summary.get("metadataFile") or str(root_dir / "latest.json")
        summary["latestSourceFile"] = str(root_dir / "latest.py")
        summary["latestMetadataFile"] = str(root_dir / "latest.json")
        return summary

    def build_strategy_from_latest_metadata(self, metadata_path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            return None

        strategy_dir = metadata_path.parent
        latest_source_path = strategy_dir / "latest.py"
        source_code = payload.get("sourceCode")
        if not source_code and latest_source_path.exists():
            try:
                source_code = latest_source_path.read_text(encoding="utf-8")
            except Exception:
                source_code = ""

        strategy = {
            "id": payload.get("id") or self.create_id("strat"),
            "name": payload.get("name") or strategy_dir.name,
            "description": payload.get("description") or f"导入自本地文件 {latest_source_path.name}",
            "symbol": payload.get("symbol") or "ETHUSDT",
            "interval": payload.get("interval") or "4h",
            "marketType": payload.get("marketType") or "futures",
            "runtime": payload.get("runtime") or "paper",
            "template": payload.get("template") or "python",
            "parameters": payload.get("parameters") or {},
            "risk": payload.get("risk") or {},
            "compiler": payload.get("compiler") or {"valid": True, "errors": [], "warnings": [], "functions": [], "checkedAt": payload.get("updatedAt") or self.now_ms()},
            "updatedAt": int(payload.get("updatedAt") or payload.get("version") or self.now_ms()),
            "createdAt": int(payload.get("createdAt") or payload.get("updatedAt") or payload.get("version") or self.now_ms()),
            "sourceCode": source_code or self.default_python_strategy,
            "artifactSummary": self.normalize_artifact_paths(payload.get("artifactSummary"), strategy_dir),
        }
        return self.normalize_strategy_record(strategy)

    def restore_strategies_from_store(self) -> int:
        existing = {item["id"]: item for item in self.db.list_collection("strategies")}
        restored = 0
        for metadata_path in sorted(self.strategy_store_root.glob("*/latest.json")):
            strategy = self.build_strategy_from_latest_metadata(metadata_path)
            if not strategy:
                continue
            current = existing.get(strategy["id"])
            merged = {**current, **strategy} if current else strategy
            merged["artifactSummary"] = self.normalize_artifact_paths((current or {}).get("artifactSummary") or strategy.get("artifactSummary"), metadata_path.parent)
            self.db.upsert_one("strategies", merged)
            existing[merged["id"]] = merged
            restored += 1 if current is None else 0
        return restored

    def strategy_artifact_exists(self, strategy: dict[str, Any]) -> bool:
        if strategy.get("template") != "python":
            return True
        artifact_summary = strategy.get("artifactSummary") or {}
        root_dir = artifact_summary.get("rootDir")
        strategy_name = str(strategy.get("name") or "").strip()
        fallback_dir = self.strategy_store_root / self.slugify_filename(strategy_name) if strategy_name else None
        if root_dir:
            root_path = Path(root_dir)
            if root_path.exists():
                return True
            if fallback_dir and fallback_dir.exists():
                strategy["artifactSummary"] = self.normalize_artifact_paths(artifact_summary, fallback_dir)
                return True
        if fallback_dir and fallback_dir.exists():
            strategy["artifactSummary"] = self.normalize_artifact_paths(artifact_summary, fallback_dir)
            return True
        return False

    def prune_missing_strategy_artifacts(self, strategies: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [item for item in strategies if self.strategy_artifact_exists(item)]

    def list_strategies(self) -> list[dict[str, Any]]:
        def load() -> list[dict[str, Any]]:
            raw_items = self.db.list_collection("strategies", sort=[("updatedAt", -1)])
            strategies = self.prune_missing_strategy_artifacts([self.normalize_strategy_record(item) for item in raw_items])
            if strategies != raw_items:
                self.db.replace_collection("strategies", strategies)
            return sorted(strategies, key=lambda item: item["updatedAt"], reverse=True)

        return self.cached_json("strategies:list", 10_000, load)

    def get_strategy_summary(self, strategy: dict[str, Any]) -> dict[str, Any]:
        if strategy["template"] != "python":
            return strategy
        return {
            **strategy,
            "sourceCode": strategy.get("sourceCode", ""),
            "compiler": strategy.get("compiler", {"valid": True, "checkedAt": strategy.get("updatedAt"), "errors": [], "warnings": []}),
        }

    def ensure_strategy_artifact(self, strategy: dict[str, Any]) -> dict[str, Any] | None:
        if strategy.get("template") != "python":
            return None

        strategy_id = strategy["id"]
        strategy_name = strategy.get("name") or strategy_id
        version = int(strategy.get("updatedAt") or self.now_ms())
        folder_name = self.slugify_filename(strategy_name)
        strategy_dir = self.strategy_store_root / folder_name
        strategy_dir.mkdir(parents=True, exist_ok=True)

        source_path = strategy_dir / f"v{version}.py"
        latest_source_path = strategy_dir / "latest.py"
        metadata_path = strategy_dir / f"v{version}.json"
        latest_metadata_path = strategy_dir / "latest.json"

        source_code = strategy.get("sourceCode") or self.default_python_strategy
        source_path.write_text(source_code, encoding="utf-8")
        latest_source_path.write_text(source_code, encoding="utf-8")

        metadata = {
            "id": strategy_id,
            "name": strategy_name,
            "description": strategy.get("description"),
            "symbol": strategy.get("symbol"),
            "interval": strategy.get("interval"),
            "marketType": strategy.get("marketType"),
            "runtime": strategy.get("runtime"),
            "template": strategy.get("template"),
            "parameters": strategy.get("parameters", {}),
            "risk": strategy.get("risk", {}),
            "compiler": strategy.get("compiler"),
            "version": version,
            "updatedAt": strategy.get("updatedAt"),
            "createdAt": strategy.get("createdAt"),
            "sourceFile": str(source_path),
            "latestSourceFile": str(latest_source_path),
        }
        metadata_text = json.dumps(metadata, ensure_ascii=False, indent=2)
        metadata_path.write_text(metadata_text, encoding="utf-8")
        latest_metadata_path.write_text(metadata_text, encoding="utf-8")

        return {
            "rootDir": str(strategy_dir),
            "sourceFile": str(source_path),
            "latestSourceFile": str(latest_source_path),
            "metadataFile": str(metadata_path),
            "latestMetadataFile": str(latest_metadata_path),
            "version": version,
        }

    def compile_python_strategy(self, source_code: str) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        function_names: list[str] = []
        if not source_code.strip():
            return {"valid": False, "errors": ["婧愮爜涓嶈兘涓虹┖"], "warnings": warnings, "functions": function_names}
        try:
            tree = ast.parse(source_code, filename="<strategy>")
            compile(source_code, "<strategy>", "exec")
            function_names = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
            if "main" not in function_names:
                errors.append("FMZ Python 绛栫暐蹇呴』瀹氫箟 main() 鍏ュ彛鍑芥暟")
            if "GetRecords" not in source_code:
                warnings.append("娌℃湁妫€娴嬪埌 GetRecords 璋冪敤锛岃纭绛栫暐鏄惁鎸?FMZ 琛屾儏璇诲彇鏂瑰紡缂栧啓")
            if "exchange." not in source_code:
                warnings.append("娌℃湁妫€娴嬪埌 exchange. 瀵硅薄璋冪敤锛岃纭绛栫暐鏄惁鎸?FMZ 浜ゆ槗鎺ュ彛缂栧啓")
        except SyntaxError as exc:
            errors.append(f"绗?{exc.lineno} 琛岃娉曢敊璇細{exc.msg}")
        except Exception as exc:
            errors.append(str(exc))
        return {"valid": not errors, "errors": errors, "warnings": warnings, "functions": function_names}

    def save_strategy(self, payload: Any) -> dict[str, Any]:
        existing = next((item for item in self.list_strategies() if item["id"] == payload.id), None)
        timestamp = self.now_ms()
        compiler = None
        if payload.template == "python":
            compiler = self.compile_python_strategy(payload.sourceCode or "")
            if not compiler["valid"]:
                raise ValueError("FMZ Python 绛栫暐缂栬瘧澶辫触锛�" + "; ".join(compiler["errors"]))
        strategy = {
            **payload.model_dump(),
            "sourceCode": payload.sourceCode if payload.template == "python" else None,
            "compiler": {**compiler, "checkedAt": timestamp} if compiler else None,
            "id": existing["id"] if existing else self.create_id("strat"),
            "createdAt": existing["createdAt"] if existing else timestamp,
            "updatedAt": timestamp,
        }
        artifact_summary = self.ensure_strategy_artifact(strategy)
        if artifact_summary:
            strategy["artifactSummary"] = artifact_summary
        self.db.upsert_one("strategies", strategy)
        return self.get_strategy_summary(strategy)
