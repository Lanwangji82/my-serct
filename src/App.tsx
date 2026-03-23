import React, { useEffect, useMemo, useState } from "react";
import { AppLayout } from "./components/Layout";
import { AlertProvider } from "./lib/AlertContext";
import { LanguageProvider } from "./lib/i18n";
import { ToastContainer } from "./components/NotificationCenter";
import { BacktestRunsPanel } from "./components/BacktestRunsPanel";
import { GovernanceWorkspace } from "./components/GovernanceWorkspace";
import { PortfolioWorkspace } from "./components/PortfolioWorkspace";
import { ResearchWorkspace } from "./components/ResearchWorkspace";
import { StrategyWorkbench } from "./components/StrategyWorkbench";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui";
import {
  authorizedFetch,
  formatDateTime,
  formatMoney,
  PLATFORM_API_BASE,
  type BrokerRegistrySummary,
} from "./lib/platform-client";

type StrategySummary = {
  id: string;
  name: string;
  description: string;
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
};

type BacktestRun = {
  id: string;
  strategyId: string;
  source?: string;
  completedAt: number;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    trades: number;
    endingEquity: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: Array<{ time: number; side: string; price: number; quantity: number; pnl?: number }>;
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

type ConnectivityBroker = {
  brokerTarget: string;
  ok: boolean;
  error?: string;
  remoteTime?: number;
  latencyMs?: number;
  checkedAt?: number;
};

type Connectivity = {
  proxy?: {
    configured: boolean;
    mode?: string;
    source?: string;
    activeProxy?: string;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string;
  };
  brokers?: ConnectivityBroker[];
  checkedAt?: number;
};

type RuntimeConfig = {
  appPort: number;
  localMode: boolean;
  databasePath: string;
  strategyStoreRoot: string;
  proxy: {
    configured: boolean;
    mode?: string;
    source?: string;
    activeProxy?: string;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string;
  };
  checkedAt: number;
};

type CredentialSummary = {
  id: string;
  label: string;
  brokerTarget: string;
  updatedAt: number;
};

type PaperAccount = {
  balanceUsd: number;
  realizedPnl: number;
  positions: Array<{
    symbol: string;
    quantity: number;
    avgEntryPrice: number;
    updatedAt: number;
  }>;
};

type Snapshot = ReturnType<typeof usePlatformSnapshot>;

function usePlatformSnapshot() {
  const [user, setUser] = useState<{ email: string; roles?: string[] } | null>(null);
  const [brokers, setBrokers] = useState<BrokerRegistrySummary[]>([]);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [paperAccount, setPaperAccount] = useState<PaperAccount | null>(null);
  const [connectivity, setConnectivity] = useState<Connectivity | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState("正在同步平台状态...");

  const reload = async () => {
    try {
      const [me, nextBrokers, nextStrategies, nextBacktests, nextAudit, nextCredentials, nextPaper, nextConnectivity, nextRuntime] = await Promise.all([
        authorizedFetch<{ user: { email: string; roles?: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
        authorizedFetch<BrokerRegistrySummary[]>(`${PLATFORM_API_BASE}/brokers`, ""),
        authorizedFetch<StrategySummary[]>(`${PLATFORM_API_BASE}/strategies`, ""),
        authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests`, ""),
        authorizedFetch<AuditEvent[]>(`${PLATFORM_API_BASE}/audit`, ""),
        authorizedFetch<CredentialSummary[]>(`${PLATFORM_API_BASE}/credentials`, ""),
        authorizedFetch<PaperAccount>(`${PLATFORM_API_BASE}/paper-account`, ""),
        authorizedFetch<Connectivity>(`${PLATFORM_API_BASE}/runtime/connectivity`, "").catch(() => null),
        authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/config`, "").catch(() => null),
      ]);

      setUser(me.user);
      setBrokers(nextBrokers);
      setStrategies(nextStrategies);
      setBacktests(nextBacktests);
      setAuditEvents(nextAudit);
      setCredentials(nextCredentials);
      setPaperAccount(nextPaper);
      setConnectivity(nextConnectivity);
      setRuntimeConfig(nextRuntime);
      setStatus("平台状态已更新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载平台状态失败");
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const mergeConnectivityBroker = (broker: ConnectivityBroker) => {
    setConnectivity((current) => {
      const previous = current?.brokers || [];
      const nextBrokers = previous.some((item) => item.brokerTarget === broker.brokerTarget)
        ? previous.map((item) => (item.brokerTarget === broker.brokerTarget ? { ...item, ...broker } : item))
        : [...previous, broker];
      return {
        ...(current || {}),
        brokers: nextBrokers,
        checkedAt: broker.checkedAt || Date.now(),
      };
    });
  };

  return {
    user,
    brokers,
    strategies,
    backtests,
    auditEvents,
    credentials,
    paperAccount,
    connectivity,
    runtimeConfig,
    status,
    reload,
    mergeConnectivityBroker,
  };
}

function StatCard(props: { label: string; value: string; hint: string; tone?: "default" | "success" | "warning" }) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-2 p-5">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{props.label}</div>
        <div className="text-2xl font-semibold text-zinc-50">{props.value}</div>
        <div className={`text-sm ${props.tone === "success" ? "text-emerald-400" : props.tone === "warning" ? "text-amber-400" : "text-zinc-500"}`}>
          {props.hint}
        </div>
      </div>
    </Card>
  );
}

function DashboardView(props: Snapshot) {
  const latestRun = props.backtests[0] || null;
  const healthyBrokers = (props.connectivity?.brokers || []).filter((item) => item.ok).length;
  const activePositions = props.paperAccount?.positions?.length || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">平台总览</h1>
          <p className="mt-1 text-sm text-zinc-500">
            这里展示团队每天最关心的运行状态：策略资产、回测结果、联通性、审计事件和当前纸面账户。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success">{props.user?.email || "本地工作区"}</Badge>
          <Button variant="outline" onClick={() => void props.reload()}>
            刷新状态
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <StatCard label="策略数量" value={`${props.strategies.length}`} hint="已保存到平台的策略资产" />
        <StatCard label="回测记录" value={`${props.backtests.length}`} hint={latestRun ? `最近一次：${formatDateTime(latestRun.completedAt)}` : "还没有回测记录"} />
        <StatCard label="可用交易所" value={`${healthyBrokers}/${props.connectivity?.brokers?.length || 0}`} hint="基于当前网络与代理检测" tone={healthyBrokers > 0 ? "success" : "warning"} />
        <StatCard label="纸面持仓" value={`${activePositions}`} hint={`账户权益 ${formatMoney(props.paperAccount?.balanceUsd)}`} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">最新回测摘要</h2>
              {latestRun ? <Badge variant="default">{latestRun.source || "回测引擎"}</Badge> : null}
            </div>
            {latestRun ? (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="text-xs text-zinc-500">收益率</div>
                  <div className={`mt-2 text-xl font-semibold ${latestRun.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {latestRun.metrics.totalReturnPct.toFixed(2)}%
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="text-xs text-zinc-500">夏普比率</div>
                  <div className="mt-2 text-xl font-semibold text-zinc-100">{latestRun.metrics.sharpe.toFixed(2)}</div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="text-xs text-zinc-500">最大回撤</div>
                  <div className="mt-2 text-xl font-semibold text-amber-400">{latestRun.metrics.maxDrawdownPct.toFixed(2)}%</div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="text-xs text-zinc-500">期末权益</div>
                  <div className="mt-2 text-xl font-semibold text-zinc-100">{formatMoney(latestRun.metrics.endingEquity)}</div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-6 text-sm text-zinc-500">
                还没有可展示的回测结果。先进入“策略”页保存策略并运行一次回测，这里就会自动同步。
              </div>
            )}
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">最近审计事件</h2>
              <Badge variant="warning">{props.auditEvents.length} 条</Badge>
            </div>
            <div className="space-y-3">
              {props.auditEvents.slice(0, 8).map((event) => (
                <div key={event.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-200">{event.type}</span>
                    <span className="text-xs text-zinc-500">{formatDateTime(event.createdAt)}</span>
                  </div>
                </div>
              ))}
              {props.auditEvents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
                  当前还没有审计记录。保存策略、回测和执行后，这里会自动沉淀团队操作轨迹。
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{props.status}</div>
    </div>
  );
}

function DataCenterView(props: Snapshot) {
  const strategySymbols = Array.from(new Set(props.strategies.map((item) => `${item.symbol} ${item.interval}`)));
  const backtestSources = Array.from(new Set(props.backtests.map((item) => item.source || "未知来源")));
  const brokerTargets = props.brokers.flatMap((broker) => broker.targets);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [latencyResult, setLatencyResult] = useState<ConnectivityBroker | null>(null);
  const [latencyBusy, setLatencyBusy] = useState(false);

  useEffect(() => {
    if (!selectedTarget) {
      setSelectedTarget(brokerTargets.find((item) => item.mode === "sandbox")?.target || brokerTargets[0]?.target || "");
    }
  }, [selectedTarget, brokerTargets]);

  const handleLatencyTest = async () => {
    if (!selectedTarget) {
      return;
    }
    setLatencyBusy(true);
    try {
      const result = await authorizedFetch<ConnectivityBroker>(`${PLATFORM_API_BASE}/runtime/latency?brokerTarget=${encodeURIComponent(selectedTarget)}`, "");
      setLatencyResult(result);
      props.mergeConnectivityBroker(result);
    } catch (error) {
      const failedResult: ConnectivityBroker = {
        brokerTarget: selectedTarget,
        ok: false,
        error: error instanceof Error ? error.message : "延迟测试失败",
        checkedAt: Date.now(),
      };
      setLatencyResult(failedResult);
      props.mergeConnectivityBroker(failedResult);
    } finally {
      setLatencyBusy(false);
    }
  };

  const connectivityRows = props.connectivity?.brokers || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">数据中心</h1>
          <p className="mt-1 text-sm text-zinc-500">
            这里展示当前平台实际用到的数据来源、交易所可达性、代理状态和最近一次延迟测量结果。
          </p>
        </div>
        <Button variant="outline" onClick={() => void props.reload()}>
          刷新数据
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">策略覆盖的数据范围</h2>
            <div className="flex flex-wrap gap-2">
              {strategySymbols.map((item) => (
                <Badge key={item} variant="default">{item}</Badge>
              ))}
              {strategySymbols.length === 0 ? <span className="text-sm text-zinc-500">还没有策略写入数据需求。</span> : null}
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">历史数据来源</h2>
            <div className="space-y-3">
              {backtestSources.map((item) => (
                <div key={item} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-200">
                  {item}
                </div>
              ))}
              {backtestSources.length === 0 ? <div className="text-sm text-zinc-500">回测运行后，这里会记录数据来源。</div> : null}
            </div>
          </div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">交易所联通与数据可达性</h2>
            <Badge variant={props.connectivity?.proxy?.configured ? "success" : "warning"}>
              {props.connectivity?.proxy?.configured
                ? `代理已配置 · ${props.connectivity?.proxy?.mode || "active"} · ${props.connectivity?.proxy?.source || "unknown"}`
                : "未检测到代理"}
            </Badge>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-3 text-sm font-medium text-zinc-100">延迟测试</div>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <select
                value={selectedTarget}
                onChange={(event) => setSelectedTarget(event.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              >
                {brokerTargets.map((item) => (
                  <option key={item.target} value={item.target}>
                    {item.label}
                  </option>
                ))}
              </select>
              <Button onClick={handleLatencyTest} disabled={latencyBusy || !selectedTarget}>
                {latencyBusy ? "测试中..." : "测试延迟"}
              </Button>
              {latencyResult ? (
                <div className={`text-sm ${latencyResult.ok ? "text-emerald-400" : "text-rose-400"}`}>
                  {latencyResult.ok
                    ? `${latencyResult.brokerTarget} 延迟 ${latencyResult.latencyMs?.toFixed(2) || "--"} ms`
                    : `${latencyResult.brokerTarget} 测试失败：${latencyResult.error || "未知错误"}`}
                </div>
              ) : (
                <div className="text-sm text-zinc-500">选择一个交易所目标，点击按钮即可主动测一次当前延迟。</div>
              )}
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>目标</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>延迟</TableHead>
                <TableHead>最近检查</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectivityRows.map((item) => (
                <TableRow key={item.brokerTarget}>
                  <TableCell>{item.brokerTarget}</TableCell>
                  <TableCell className={item.ok ? "text-emerald-400" : "text-rose-400"}>{item.ok ? "可达" : "失败"}</TableCell>
                  <TableCell>{item.ok && typeof item.latencyMs === "number" ? `${item.latencyMs.toFixed(2)} ms` : "--"}</TableCell>
                  <TableCell>{item.checkedAt ? formatDateTime(item.checkedAt) : props.connectivity?.checkedAt ? formatDateTime(props.connectivity.checkedAt) : "--"}</TableCell>
                  <TableCell className="text-zinc-400">
                    {item.ok ? "可用于拉取行情和执行前检查" : item.error || "未返回错误详情"}
                  </TableCell>
                </TableRow>
              ))}
              {connectivityRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-zinc-500">
                    暂无联通检测结果。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

function BacktestingView(props: Snapshot & { onOpenStrategies: () => void }) {
  const strategyMap = useMemo(() => new Map(props.strategies.map((item) => [item.id, item])), [props.strategies]);
  const latestRuns = props.backtests.slice(0, 12);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">回测中心</h1>
          <p className="mt-1 text-sm text-zinc-500">这里汇总平台最近的回测结果，方便团队复盘策略质量与风险表现。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void props.reload()}>刷新回测</Button>
          <Button onClick={props.onOpenStrategies}>进入策略工作流</Button>
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">最近回测记录</h2>
            <Badge variant="default">{latestRuns.length} 条</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>策略</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>收益率</TableHead>
                <TableHead>最大回撤</TableHead>
                <TableHead>交易次数</TableHead>
                <TableHead>期末权益</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latestRuns.map((run) => {
                const strategy = strategyMap.get(run.strategyId);
                return (
                  <TableRow key={run.id}>
                    <TableCell>{formatDateTime(run.completedAt)}</TableCell>
                    <TableCell>{strategy?.name || run.strategyId}</TableCell>
                    <TableCell>{run.source || "回测引擎"}</TableCell>
                    <TableCell className={run.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      {run.metrics.totalReturnPct.toFixed(2)}%
                    </TableCell>
                    <TableCell>{run.metrics.maxDrawdownPct.toFixed(2)}%</TableCell>
                    <TableCell>{run.metrics.trades}</TableCell>
                    <TableCell>{formatMoney(run.metrics.endingEquity)}</TableCell>
                  </TableRow>
                );
              })}
              {latestRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-zinc-500">
                    暂无回测记录，请先在策略页运行一次回测。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

function SettingsView(props: Snapshot) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">设置</h1>
        <p className="mt-1 text-sm text-zinc-500">这里展示当前平台运行配置、策略落盘目录和网络代理状态，方便排查环境问题。</p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">运行配置</h2>
            <div className="space-y-3 text-sm text-zinc-400">
              <div>应用端口：{props.runtimeConfig?.appPort || "--"}</div>
              <div>本地直连模式：{props.runtimeConfig?.localMode ? "开启" : "关闭"}</div>
              <div className="break-all">数据库路径：{props.runtimeConfig?.databasePath || "--"}</div>
              <div className="break-all">策略落盘目录：{props.runtimeConfig?.strategyStoreRoot || "--"}</div>
              <div>最后刷新：{props.runtimeConfig?.checkedAt ? formatDateTime(props.runtimeConfig.checkedAt) : "--"}</div>
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">代理与联通</h2>
            <div className="space-y-3 text-sm text-zinc-400">
              <div>代理模式：{props.runtimeConfig?.proxy?.configured ? props.runtimeConfig.proxy.mode || "active" : "未配置"}</div>
              <div>代理来源：{props.runtimeConfig?.proxy?.source || "--"}</div>
              <div className="break-all">当前出口：{props.runtimeConfig?.proxy?.activeProxy || "--"}</div>
              <div className="break-all">HTTP 代理：{props.runtimeConfig?.proxy?.httpProxy || "--"}</div>
              <div className="break-all">HTTPS 代理：{props.runtimeConfig?.proxy?.httpsProxy || "--"}</div>
              <div className="break-all">SOCKS 代理：{props.runtimeConfig?.proxy?.socksProxy || "--"}</div>
            </div>
          </div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">凭证摘要</h2>
            <Badge variant="default">{props.credentials.length} 条</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.credentials.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.label}</TableCell>
                  <TableCell>{item.brokerTarget}</TableCell>
                  <TableCell>{formatDateTime(item.updatedAt)}</TableCell>
                </TableRow>
              ))}
              {props.credentials.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-zinc-500">
                    暂无已保存凭证。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem("quantx.activeTab") || "dashboard");
  const snapshot = usePlatformSnapshot();

  useEffect(() => {
    localStorage.setItem("quantx.activeTab", activeTab);
  }, [activeTab]);

  let content: React.ReactNode = null;
  if (activeTab === "dashboard") content = <DashboardView {...snapshot} />;
  else if (activeTab === "research") content = <ResearchWorkspace />;
  else if (activeTab === "dataCenter") content = <DataCenterView {...snapshot} />;
  else if (activeTab === "backtesting") content = <BacktestingView {...snapshot} onOpenStrategies={() => setActiveTab("strategies")} />;
  else if (activeTab === "strategies") content = <StrategyWorkbench />;
  else if (activeTab === "portfolio") content = <PortfolioWorkspace />;
  else if (activeTab === "governance") content = <GovernanceWorkspace />;
  else if (activeTab === "settings") content = <SettingsView {...snapshot} />;

  return (
    <LanguageProvider>
      <AlertProvider>
        <AppLayout activeTab={activeTab} setActiveTab={setActiveTab}>
          {content}
        </AppLayout>
        <ToastContainer />
      </AlertProvider>
    </LanguageProvider>
  );
}
