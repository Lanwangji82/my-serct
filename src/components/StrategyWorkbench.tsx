import React, { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui";
import { BacktestRunsPanel, type BacktestConfig } from "./BacktestRunsPanel";
import { ExecutionConsolePanel } from "./ExecutionConsolePanel";
import { StrategyRegistryPanel } from "./StrategyRegistryPanel";
import type { PlatformStrategy } from "./strategy-types";
import { authorizedFetch, PLATFORM_API_BASE } from "../lib/platform-client";

type Strategy = PlatformStrategy;

type BacktestRun = {
  id: string;
  strategyId: string;
  source?: string;
  status?: "queued" | "running" | "completed" | "failed";
  progressPct?: number;
  queuedAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number | null;
  errorMessage?: string | null;
  params?: Record<string, unknown>;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    winRatePct: number;
    trades: number;
    endingEquity: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: Array<{
    id?: string;
    time: number;
    side: string;
    action?: string;
    eventCode?: string;
    label?: string;
    marker?: string;
    positionSide?: string;
    symbol?: string;
    message?: string;
    price: number;
    quantity: number;
    fee?: number;
    pnl?: number;
    lastPrice?: number;
    equity?: number;
    beforePosition?: { longAmount?: number; shortAmount?: number };
    afterPosition?: { longAmount?: number; shortAmount?: number };
  }>;
  marketRows?: Array<{
    time: number;
    lastPrice: number;
    equity: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    openInterest?: number;
    utilization: number;
    longAmount: number;
    longPrice: number;
    longProfit: number;
    shortAmount: number;
    shortPrice: number;
    shortProfit: number;
    events?: Array<{ id: string; label: string; marker: string; action: string; price: number; quantity: number; pnl: number; message: string }>;
  }>;
  logs?: Array<{ time: number; level: string; message: string; progressPct?: number }>;
  assetRows?: Array<{
    name: string;
    asset: string;
    balance: number;
    frozen: number;
    fees: number;
    equity: number;
    realizedPnl: number;
    positionPnl: number;
    margin: number;
    estimatedProfit: number;
  }>;
  summary?: {
    barCount?: number;
    orderCount?: number;
    dataSource?: string;
    startedAtText?: string;
    endedAtText?: string;
    durationMs?: number;
  };
  statusInfo?: {
    backtestStatus?: number;
    finished?: boolean;
    progress?: number;
    logsCount?: number;
    loadBytes?: number;
    loadElapsed?: number;
    elapsed?: number;
    lastPrice?: number;
    equity?: number;
    utilization?: number;
    longAmount?: number;
    shortAmount?: number;
    estimatedProfit?: number;
    tradeCount?: number;
  };
};

type AuditEvent = { id: string; type: string; createdAt: number; payload: Record<string, unknown> };
type ConnectivityStatus = {
  proxy?: { configured: boolean; httpProxy?: string; httpsProxy?: string; socksProxy?: string; mode?: string; source?: string };
  brokers?: Array<{ brokerTarget: string; ok: boolean; latencyMs?: number; error?: string }>;
} | null;

const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  brokerTarget: "binance:production",
  startTime: "2025-03-01 00:00:00",
  endTime: "2026-03-21 08:00:00",
  periodValue: 4,
  periodUnit: "h",
  basePeriodValue: 1,
  basePeriodUnit: "h",
  mode: "模拟级",
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
  const match = String(value || "").trim().match(/^(\d+)([mhd])$/i);
  if (!match) return { value: 1, unit: "h" as const };
  return { value: Number(match[1]) || 1, unit: (match[2].toLowerCase() as "m" | "h" | "d") || "h" };
}

export function StrategyWorkbench() {
  const [user, setUser] = useState<{ email: string; roles: string[] } | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(null);
  const [status, setStatus] = useState("正在连接策略工作台...");
  const [busy, setBusy] = useState(false);
  const [backtestConfig, setBacktestConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);

  const selectedStrategy = useMemo(
    () => strategies.find((item) => item.id === selectedStrategyId) || strategies[0] || null,
    [selectedStrategyId, strategies]
  );

  const loadWorkspace = async () => {
    const [me, nextStrategies, nextBacktests, nextAudit, nextConnectivity] = await Promise.all([
      authorizedFetch<{ user: { email: string; roles: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
      authorizedFetch<Strategy[]>(`${PLATFORM_API_BASE}/strategies`, ""),
      authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests`, ""),
      authorizedFetch<AuditEvent[]>(`${PLATFORM_API_BASE}/audit`, ""),
      authorizedFetch<ConnectivityStatus>(`${PLATFORM_API_BASE}/runtime/connectivity`, "").catch(() => null),
    ]);

    setUser(me.user);
    setStrategies(sortStrategies(nextStrategies));
    setBacktests(sortRuns(nextBacktests));
    setAuditEvents(nextAudit);
    setConnectivity(nextConnectivity);

    const nextSelected = nextStrategies.find((item) => item.id === selectedStrategyId) || nextStrategies[0] || null;
    if (nextSelected?.id) setSelectedStrategyId(nextSelected.id);
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
  const latestRun = selectedRuns[0] || null;
  const hasActiveRun = latestRun?.status === "queued" || latestRun?.status === "running";

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests`, ""),
        authorizedFetch<AuditEvent[]>(`${PLATFORM_API_BASE}/audit`, ""),
      ])
        .then(([runs, audit]) => {
          setBacktests(sortRuns(runs));
          setAuditEvents(audit);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun]);

  useEffect(() => {
    if (!latestRun) return;
    if (latestRun.status === "queued") return void setStatus(`回测已排队，当前进度 ${latestRun.progressPct || 0}%`);
    if (latestRun.status === "running") return void setStatus(`回测运行中，当前进度 ${latestRun.progressPct || 0}%`);
    if (latestRun.status === "failed") return void setStatus(latestRun.errorMessage || "回测执行失败");
    if (latestRun.status === "completed") {
      setStatus(`回测完成：收益率 ${latestRun.metrics.totalReturnPct.toFixed(2)}%，最大回撤 ${latestRun.metrics.maxDrawdownPct.toFixed(2)}%，交易 ${latestRun.metrics.trades} 笔`);
    }
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
      setStatus("回测任务已提交，正在等待 FMZ 本地回测引擎启动...");
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
      setStatus(`策略“${imported.name}”已从本地文件导入并保存到策略档案库。`);
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
            当前工作流围绕 FMZ 原生 Python 策略展开：在这里管理策略档案、导入本地 Python 文件、执行回测并查看日志结果。
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
        busy={busy}
        config={backtestConfig}
        onConfigChange={setBacktestConfig}
        onRunBacktest={handleRunBacktest}
      />

      <ExecutionConsolePanel selectedStrategy={selectedStrategy} auditEvents={auditEvents} connectivity={connectivity} />

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
