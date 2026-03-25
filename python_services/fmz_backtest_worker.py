from __future__ import annotations

import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

try:
    from .fmz_backtest import BacktestConfig, _run_fmz_backtest_direct
except ImportError:
    from fmz_backtest import BacktestConfig, _run_fmz_backtest_direct


def main() -> int:
    if len(sys.argv) >= 2:
        raw = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        raw = sys.stdin.read()
    if not raw.strip():
        raise RuntimeError("Missing worker payload")
    payload = json.loads(raw)
    config = BacktestConfig(**payload["config"])
    runtime_stdout = io.StringIO()
    runtime_stderr = io.StringIO()
    with redirect_stdout(runtime_stdout), redirect_stderr(runtime_stderr):
        result = _run_fmz_backtest_direct(payload["source_code"], config)
    encoded = json.dumps(result, ensure_ascii=False)
    if len(sys.argv) >= 3:
        Path(sys.argv[2]).write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.write(f"\n{exc}")
        raise SystemExit(1)
