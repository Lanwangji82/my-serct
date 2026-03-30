import React, { useEffect, useMemo, useState } from "react";
import { BacktestRunsPanel, type BacktestConfig } from "../components/panels/BacktestRunsPanel";
import { StrategyRegistryPanel } from "../components/strategy/StrategyRegistryPanel";
import { Badge } from "../components/common/ui";
import type { BacktestRun, PlatformStrategy } from "../components/strategy/strategy-types";
import { authorizedFetch, PLATFORM_API_BASE } from "../lib/platform-client";

type Strategy = PlatformStrategy;

const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  brokerTarget: "binance:production",
  startTime: "2025-03-01 00:00:00",
  endTime: "2026-03-21 08:00:00",
  periodValue: 4,
  periodUnit: "h",
  basePeriodValue: 1,
  basePeriodUnit: "h",
  mode: "模拟盘",
  initialCapital: 10000,
  quoteAsset: "USDT",
  logLimit: 8000,
  profitLimit: 50000,
  chartBars: 3000,
  slippagePoints: 0,
  tolerancePct: 50,
  delayMs: 200,
  candleLimit: 300,
  openFeePct: 0.03,
  closeFeePct: 0.03,
  recordEvents: false,
  chartDisplay: "显示",
  depthMin: 20,
  depthMax: 200,
  dataSource: "默认",
  orderMode: "已成交",
  distributor: "本地回测引擎: Python3 - 12 vCPU / 4G RAM",
};

const DEFAULT_IMPORT_RISK = {
  maxNotional: 100000,
  maxLeverage: 5,
  maxDailyLoss: 0.08,
  allowedSymbols: ["ETHUSDT"],
};

function sortRuns(runs: BacktestRun[]) {
  return [...runs].sort((left, right) => {
    const rightKey = right.updatedAt || right.completedAt || right.startedAt || right.queuedAt || 0;
    const leftKey = left.updatedAt || left.completedAt || left.startedAt || left.queuedAt || 0;
    return rightKey - leftKey;
  });
}

function sortStrategies(items: Strategy[]) {
  return [...items].sort((left, right) => {
    const rightKey = right.updatedAt || right.createdAt || 0;
    const leftKey = left.updatedAt || left.createdAt || 0;
    return rightKey - leftKey;
  });
}

function splitPeriod(value: string | undefined) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+)([mhd])$/i);
  if (!match) return { value: 1, unit: "h" as const };
  return { value: Number(match[1]) || 1, unit: (match[2].toLowerCase() as "m" | "h" | "d") || "h" };
}

function buildRunStatus(run: BacktestRun | null) {
  if (!run) return "策略工作台已就绪。";
  if (run.status === "queued") return `回测已排队，当前进度 ${run.progressPct || 0}%`;
  if (run.status === "running") return `回测执行中，当前进度 ${run.progressPct || 0}%`;
  if (run.status === "failed") return run.errorMessage || "回测执行失败";
  if (run.status === "completed") {
    return `回测完成：收益率 ${run.metrics.totalReturnPct.toFixed(2)}%，最大回撤 ${run.metrics.maxDrawdownPct.toFixed(2)}%，交易 ${run.metrics.trades} 笔`;
  }
  return "策略工作台已就绪。";
}

export function StrategyWorkbench() {
  const [user, setUser] = useState<{ email: string; roles: string[] } | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [backtestDetails, setBacktestDetails] = useState<Record<string, BacktestRun>>({});
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [status, setStatus] = useState("正在连接策略工作台...");
  const [busy, setBusy] = useState(false);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);
  const [backtestConfig, setBacktestConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);

  const selectedStrategy = useMemo(
    () => strategies.find((item) => item.id === selectedStrategyId) || strategies[0] || null,
    [selectedStrategyId, strategies]
  );

  const loadBacktestDetail = async (runId: string) => {
    setLoadingRunDetail(true);
    try {
      const detail = await authorizedFetch<BacktestRun>(`${PLATFORM_API_BASE}/backtests/${runId}`, "");
      setBacktestDetails((current) => (current[runId] === detail ? current : { ...current, [runId]: detail }));
      return detail;
    } finally {
      setLoadingRunDetail(false);
    }
  };

  const loadWorkspace = async () => {
    const [me, nextStrategies, nextBacktests] = await Promise.all([
      authorizedFetch<{ user: { email: string; roles: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
      authorizedFetch<Strategy[]>(`${PLATFORM_API_BASE}/strategies`, ""),
      authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests?limit=80`, ""),
    ]);

    setUser(me.user);
    setStrategies(sortStrategies(nextStrategies));
    setBacktests(sortRuns(nextBacktests));

    const nextSelected = nextStrategies.find((item) => item.id === selectedStrategyId) || nextStrategies[0] || null;
    if (nextSelected?.id) {
      setSelectedStrategyId(nextSelected.id);
    }
    setStatus(nextStrategies.length ? "策略工作台已连接。" : "策略工作台已连接，但当前还没有策略。");
  };

  useEffect(() => {
    void loadWorkspace().catch((error) => {
      setStatus(error instanceof Error ? error.message : "加载策略工作台失败");
    });
  }, []);

  useEffect(() => {
    if (!selectedStrategy) return;
    const nextPeriod = splitPeriod(selectedStrategy.interval);
    setBacktestConfig((current) => ({
      ...current,
      periodValue: nextPeriod.value,
      periodUnit: nextPeriod.unit,
      brokerTarget: selectedStrategy.marketType === "spot" ? "binance:production" : current.brokerTarget,
    }));
  }, [selectedStrategy?.id]);

  const selectedRuns = useMemo(
    () => sortRuns(backtests.filter((item) => item.strategyId === selectedStrategy?.id)),
    [backtests, selectedStrategy?.id]
  );
  const latestRunSummary = selectedRuns[0] || null;
  const latestRun = latestRunSummary ? backtestDetails[latestRunSummary.id] || latestRunSummary : null;
  const hasActiveRun = latestRunSummary?.status === "queued" || latestRunSummary?.status === "running";

  useEffect(() => {
    if (!latestRunSummary?.id) return;
    const detail = backtestDetails[latestRunSummary.id];
    const needsDetail =
      !detail ||
      (!detail.marketRows?.length && !detail.logs?.length && !detail.trades?.length && !detail.assetRows?.length && latestRunSummary.status === "completed");
    if (!needsDetail) return;
    void loadBacktestDetail(latestRunSummary.id).catch(() => {});
  }, [latestRunSummary?.id, latestRunSummary?.status]);

  useEffect(() => {
    if (!hasActiveRun || !latestRunSummary?.id) return;
    const timer = window.setInterval(() => {
      void authorizedFetch<BacktestRun>(`${PLATFORM_API_BASE}/backtests/${latestRunSummary.id}/status`, "")
        .then((run) => {
          setBacktests((current) => sortRuns([run, ...current.filter((item) => item.id !== run.id)]));
          if (run.status === "completed" || run.status === "failed") {
            void loadBacktestDetail(run.id).catch(() => {});
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, latestRunSummary?.id]);

  useEffect(() => {
    setStatus(buildRunStatus(latestRun));
  }, [latestRun?.id, latestRun?.status, latestRun?.progressPct, latestRun?.errorMessage]);

  const handleRunBacktest = async () => {
    if (!selectedStrategy || hasActiveRun) return;
    setBusy(true);
    try {
      const run = await authorizedFetch<BacktestRun>(`${PLATFORM_API_BASE}/backtests`, "", {
        method: "POST",
        body: JSON.stringify({
          strategyId: selectedStrategy.id,
          brokerTarget: backtestConfig.brokerTarget,
          startTime: backtestConfig.startTime,
          endTime: backtestConfig.endTime,
          period: `${backtestConfig.periodValue}${backtestConfig.periodUnit}`,
          basePeriod: `${backtestConfig.basePeriodValue}${backtestConfig.basePeriodUnit}`,
          mode: backtestConfig.mode,
          initialCapital: backtestConfig.initialCapital,
          quoteAsset: backtestConfig.quoteAsset,
          logLimit: backtestConfig.logLimit,
          profitLimit: backtestConfig.profitLimit,
          chartBars: backtestConfig.chartBars,
          slippagePoints: backtestConfig.slippagePoints,
          tolerancePct: backtestConfig.tolerancePct,
          delayMs: backtestConfig.delayMs,
          candleLimit: backtestConfig.candleLimit,
          openFeePct: backtestConfig.openFeePct,
          closeFeePct: backtestConfig.closeFeePct,
          recordEvents: backtestConfig.recordEvents,
          chartDisplay: backtestConfig.chartDisplay,
          depthMin: backtestConfig.depthMin,
          depthMax: backtestConfig.depthMax,
          dataSource: backtestConfig.dataSource,
          orderMode: backtestConfig.orderMode,
          distributor: backtestConfig.distributor,
        }),
      });
      setBacktests((current) => sortRuns([run, ...current.filter((item) => item.id !== run.id)]));
      setStatus("回测任务已提交，正在等待本地回测引擎启动...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "回测任务提交失败");
    } finally {
      setBusy(false);
    }
  };

  const handleImportStrategy = async (payload: { name: string; fileName: string; sourceCode: string }) => {
    setBusy(true);
    try {
      const base = selectedStrategy;
      const imported = await authorizedFetch<Strategy>(`${PLATFORM_API_BASE}/strategies`, "", {
        method: "POST",
        body: JSON.stringify({
          name: payload.name,
          description: `导入自本地文件 ${payload.fileName}`,
          marketType: base?.marketType || "futures",
          symbol: base?.symbol || "ETHUSDT",
          interval: base?.interval || "4h",
          runtime: base?.runtime || "paper",
          template: "python",
          parameters: base?.parameters || {},
          risk: base?.risk || DEFAULT_IMPORT_RISK,
          sourceCode: payload.sourceCode,
        }),
      });
      setStrategies((current) => sortStrategies([imported, ...current.filter((item) => item.id !== imported.id)]));
      if (imported.id) setSelectedStrategyId(imported.id);
      void loadWorkspace().catch(() => {});
      setStatus(`策略“${imported.name}”已从本地文件导入并保存到策略库。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导入策略失败");
      throw error;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">策略工作台</h1>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-zinc-500">
            这里集中管理 FMZ Python 策略、导入本地文件、执行回测，并查看行情、订单、日志和回测结果。
          </p>
        </div>
        {user ? <Badge variant="success">{user.email}</Badge> : null}
      </div>

      <StrategyRegistryPanel
        strategies={strategies}
        selectedStrategy={selectedStrategy}
        busy={busy || hasActiveRun}
        onRefresh={loadWorkspace}
        onSelectStrategy={(strategyId) => setSelectedStrategyId(strategyId)}
        onImportStrategy={handleImportStrategy}
      />

      <BacktestRunsPanel
        selectedStrategy={selectedStrategy}
        backtests={selectedRuns}
        latestRun={latestRun}
        busy={busy}
        loadingRunDetail={loadingRunDetail}
        config={backtestConfig}
        onConfigChange={setBacktestConfig}
        onRunBacktest={handleRunBacktest}
      />

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
