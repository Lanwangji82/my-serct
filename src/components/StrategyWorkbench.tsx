import React, { useEffect, useState } from "react";
import { Badge } from "./ui";
import { BacktestRunsPanel } from "./BacktestRunsPanel";
import { ExecutionConsolePanel } from "./ExecutionConsolePanel";
import { PythonStrategy, PythonStrategyEditorPanel } from "./PythonStrategyEditorPanel";
import { StrategyRegistryPanel } from "./StrategyRegistryPanel";
import {
  authorizedFetch,
  type BrokerRegistrySummary,
  type BrokerTarget,
  getBrokerTargetLabel,
  getRuntimeExecutionTarget,
  PLATFORM_API_BASE,
} from "../lib/platform-client";

type Strategy = PythonStrategy;

type BacktestRun = {
  id: string;
  strategyId: string;
  source?: string;
  params?: {
    lookback?: number;
    initialCapital?: number;
    feeBps?: number;
    slippageBps?: number;
  };
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    winRatePct: number;
    trades: number;
    endingEquity: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: Array<{ time: number; side: string; price: number; quantity: number; pnl?: number }>;
  completedAt: number;
};

type CredentialSummary = {
  id: string;
  label: string;
  brokerTarget: string;
  updatedAt: number;
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

type CompilerResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checkedAt?: number;
};

type ConnectivityStatus = {
  proxy?: { configured: boolean; httpProxy?: string; socksProxy?: string };
  brokers?: Array<{ brokerTarget: string; ok: boolean; error?: string }>;
} | null;

type BacktestConfig = {
  lookback: number;
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
};

export function StrategyWorkbench() {
  const [user, setUser] = useState<{ email: string; roles: string[] } | null>(null);
  const [brokers, setBrokers] = useState<BrokerRegistrySummary[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [paperAccount, setPaperAccount] = useState<any>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [brokerTarget, setBrokerTarget] = useState<BrokerTarget>("paper");
  const [credentialTarget, setCredentialTarget] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(null);
  const [status, setStatus] = useState("正在连接本地策略工作台...");
  const [busy, setBusy] = useState(false);
  const [backtestConfig, setBacktestConfig] = useState<BacktestConfig>({
    lookback: 500,
    initialCapital: 10000,
    feeBps: 4,
    slippageBps: 2,
  });

  const selectedStrategy = strategies.find((item) => item.id === selectedStrategyId) || strategies[0] || null;

  const loadWorkspace = async () => {
    const [
      me,
      nextBrokers,
      nextStrategies,
      nextBacktests,
      nextCredentials,
      nextAudit,
      nextPaper,
      nextConnectivity,
    ] = await Promise.all([
      authorizedFetch<{ user: { email: string; roles: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
      authorizedFetch<BrokerRegistrySummary[]>(`${PLATFORM_API_BASE}/brokers`, ""),
      authorizedFetch<Strategy[]>(`${PLATFORM_API_BASE}/strategies`, ""),
      authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests`, ""),
      authorizedFetch<CredentialSummary[]>(`${PLATFORM_API_BASE}/credentials`, ""),
      authorizedFetch<AuditEvent[]>(`${PLATFORM_API_BASE}/audit`, ""),
      authorizedFetch<any>(`${PLATFORM_API_BASE}/paper-account`, "").catch(() => null),
      authorizedFetch<ConnectivityStatus>(`${PLATFORM_API_BASE}/runtime/connectivity`, "").catch(() => null),
    ]);

    setUser(me.user);
    setBrokers(nextBrokers);
    setStrategies(nextStrategies);
    setBacktests(nextBacktests);
    setCredentials(nextCredentials);
    setAuditEvents(nextAudit);
    setPaperAccount(nextPaper);
    setConnectivity(nextConnectivity);

    const nextSelected = nextStrategies.find((item) => item.id === selectedStrategyId) || nextStrategies[0] || null;
    if (nextSelected) {
      setSelectedStrategyId(nextSelected.id || "");
      setBrokerTarget(getRuntimeExecutionTarget(nextSelected.runtime, nextBrokers));
    }

    setCredentialTarget(
      (current) => (
        current
        || nextBrokers.flatMap((item) => item.targets).find((item) => item.mode === "sandbox")?.target
        || nextBrokers.flatMap((item) => item.targets)[0]?.target
        || ""
      ),
    );
  };

  useEffect(() => {
    void loadWorkspace().catch((error) => {
      setStatus(error instanceof Error ? error.message : "加载工作台失败");
    });
  }, []);

  const handleSaveCredential = async () => {
    setBusy(true);
    try {
      const nextCredentials = await authorizedFetch<CredentialSummary[]>(`${PLATFORM_API_BASE}/credentials`, "", {
        method: "POST",
        body: JSON.stringify({
          brokerTarget: credentialTarget,
          label: getBrokerTargetLabel(credentialTarget, brokers),
          apiKey,
          apiSecret,
          apiPassphrase,
        }),
      });
      setCredentials(nextCredentials);
      setApiKey("");
      setApiSecret("");
      setApiPassphrase("");
      setStatus(`已保存 ${getBrokerTargetLabel(credentialTarget, brokers)} 的凭证`);
      await loadWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存凭证失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRunBacktest = async () => {
    if (!selectedStrategy) {
      return;
    }

    setBusy(true);
    try {
      const run = await authorizedFetch<BacktestRun>(`${PLATFORM_API_BASE}/backtests`, "", {
        method: "POST",
        body: JSON.stringify({
          strategyId: selectedStrategy.id,
          lookback: backtestConfig.lookback,
          initialCapital: backtestConfig.initialCapital,
          feeBps: backtestConfig.feeBps,
          slippageBps: backtestConfig.slippageBps,
        }),
      });
      setBacktests((prev) => [run, ...prev.filter((item) => item.id !== run.id)]);
      setStatus(`回测完成：收益率 ${run.metrics.totalReturnPct.toFixed(2)}%，最大回撤 ${run.metrics.maxDrawdownPct.toFixed(2)}%，交易 ${run.metrics.trades} 次`);
      await loadWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "回测失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCompileStrategy = async (sourceCode: string): Promise<CompilerResult> => {
    const result = await authorizedFetch<CompilerResult>(`${PLATFORM_API_BASE}/strategies/compile`, "", {
      method: "POST",
      body: JSON.stringify({ sourceCode }),
    });
    setStatus(result.valid ? "Python 策略编译通过" : "Python 策略编译未通过，请先修复错误");
    return result;
  };

  const handleSaveStrategy = async (strategy: Strategy) => {
    setBusy(true);
    try {
      const saved = await authorizedFetch<Strategy>(`${PLATFORM_API_BASE}/strategies`, "", {
        method: "POST",
        body: JSON.stringify({
          id: strategy.id || null,
          name: strategy.name,
          description: strategy.description,
          marketType: strategy.marketType,
          symbol: strategy.symbol,
          interval: strategy.interval,
          runtime: strategy.runtime,
          template: "python",
          parameters: strategy.parameters,
          risk: strategy.risk,
          sourceCode: strategy.sourceCode || "",
        }),
      });
      await loadWorkspace();
      setSelectedStrategyId(saved.id || "");
      setStatus(`策略“${saved.name}”已保存到平台`);
    } catch (error: any) {
      const message = typeof error?.message === "string" ? error.message : "保存策略失败";
      setStatus(message);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const handleExecute = async (side: "BUY" | "SELL") => {
    if (!selectedStrategy) {
      return;
    }

    setBusy(true);
    try {
      const result = await authorizedFetch<any>(`${PLATFORM_API_BASE}/execution`, "", {
        method: "POST",
        body: JSON.stringify({
          strategyId: selectedStrategy.id,
          brokerTarget,
          side,
        }),
      });

      setStatus(
        result.accepted
          ? `执行请求已通过，已发送到 ${result.broker || result.brokerTarget}`
          : `执行被拒绝：${(result.risk?.breaches || []).join(", ")}`,
      );
      await loadWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "执行失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">策略工作流</h1>
          <p className="mt-1 text-sm text-zinc-500">
            在一个工作流里完成策略编写、参数管理、回测验证、凭证维护和执行准备。
          </p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <StrategyRegistryPanel
          strategies={strategies}
          brokers={brokers}
          selectedStrategy={selectedStrategy}
          onSelectStrategy={(strategyId, target) => {
            setSelectedStrategyId(strategyId);
            setBrokerTarget(target as BrokerTarget);
          }}
        />

        <BacktestRunsPanel
          selectedStrategy={selectedStrategy}
          backtests={backtests}
          busy={busy}
          config={backtestConfig}
          onConfigChange={setBacktestConfig}
          onRunBacktest={handleRunBacktest}
        />
      </div>

      <PythonStrategyEditorPanel
        selectedStrategy={selectedStrategy}
        busy={busy}
        onCompile={handleCompileStrategy}
        onSave={handleSaveStrategy}
      />

      <ExecutionConsolePanel
        brokers={brokers}
        brokerTarget={brokerTarget}
        credentialTarget={credentialTarget}
        credentials={credentials}
        selectedStrategy={selectedStrategy}
        paperAccount={paperAccount}
        auditEvents={auditEvents}
        apiKey={apiKey}
        apiSecret={apiSecret}
        apiPassphrase={apiPassphrase}
        connectivity={connectivity}
        busy={busy}
        onBrokerTargetChange={setBrokerTarget}
        onCredentialTargetChange={setCredentialTarget}
        onApiKeyChange={setApiKey}
        onApiSecretChange={setApiSecret}
        onApiPassphraseChange={setApiPassphrase}
        onSaveCredential={handleSaveCredential}
        onExecute={handleExecute}
      />

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
