import React, { useEffect, useMemo, useState } from "react";
import { AppLayout } from "./components/Layout";
import { AlertProvider } from "./lib/AlertContext";
import { LanguageProvider } from "./lib/i18n";
import { ToastContainer } from "./components/NotificationCenter";
import { MarketWorkspace } from "./components/MarketWorkspace";
import { MarketIntelligenceWorkspace } from "./components/MarketIntelligenceWorkspace";
import { RuntimeErrorBoundary } from "./components/RuntimeErrorBoundary";
import { StrategyWorkbench } from "./components/StrategyWorkbench";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui";
import {
  authorizedFetch,
  formatDateTime,
  formatMoney,
  PLATFORM_API_BASE,
  type BrokerRegistrySummary,
  type NetworkClientCatalogEntry,
  type NetworkClientId,
  type NetworkRouteCatalogEntry,
  type RuntimeConfig,
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

type Snapshot = ReturnType<typeof usePlatformSnapshot>;

function usePlatformSnapshot() {
  const [user, setUser] = useState<{ email: string; roles?: string[] } | null>(null);
  const [brokers, setBrokers] = useState<BrokerRegistrySummary[]>([]);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [connectivity, setConnectivity] = useState<Connectivity | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState("正在同步平台状态...");

  const reload = async () => {
    try {
      const [me, nextBrokers, nextStrategies, nextBacktests, nextAudit, nextConnectivity, nextRuntime] = await Promise.all([
        authorizedFetch<{ user: { email: string; roles?: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
        authorizedFetch<BrokerRegistrySummary[]>(`${PLATFORM_API_BASE}/brokers`, ""),
        authorizedFetch<StrategySummary[]>(`${PLATFORM_API_BASE}/strategies`, ""),
        authorizedFetch<BacktestRun[]>(`${PLATFORM_API_BASE}/backtests`, ""),
        authorizedFetch<AuditEvent[]>(`${PLATFORM_API_BASE}/audit`, ""),
        authorizedFetch<Connectivity>(`${PLATFORM_API_BASE}/runtime/connectivity`, "").catch(() => null),
        authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/config`, "").catch(() => null),
      ]);

      setUser(me.user);
      setBrokers(nextBrokers);
      setStrategies(nextStrategies);
      setBacktests(nextBacktests);
      setAuditEvents(nextAudit);
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

  const saveNetworkClients = async (payload: RuntimeConfig["networkClients"]) => {
    const nextRuntime = await authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/network-clients`, "", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setRuntimeConfig(nextRuntime);
    setConnectivity((current) => ({
      ...(current || {}),
      proxy: nextRuntime.proxy,
      checkedAt: Date.now(),
    }));
    setStatus("网络端口配置已保存");
    return nextRuntime;
  };

  return {
    user,
    brokers,
    strategies,
    backtests,
    auditEvents,
    connectivity,
    runtimeConfig,
    status,
    reload,
    mergeConnectivityBroker,
    saveNetworkClients,
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">平台总览</h1>
          <p className="mt-1 text-sm text-zinc-500">
            汇总团队最常看的运行信息：策略资产、最近回测、交易所联通情况和最近审计记录。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success">{props.user?.email || "本地工作区"}</Badge>
          <Button variant="outline" onClick={() => void props.reload()}>刷新状态</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <StatCard label="策略数量" value={`${props.strategies.length}`} hint="已归档到平台的策略资产" />
        <StatCard label="回测记录" value={`${props.backtests.length}`} hint={latestRun ? `最近一次：${formatDateTime(latestRun.completedAt)}` : "还没有回测记录"} />
        <StatCard
          label="可用交易所"
          value={`${healthyBrokers}/${props.connectivity?.brokers?.length || 0}`}
          hint="基于当前网络和代理检测"
          tone={healthyBrokers > 0 ? "success" : "warning"}
        />
        <StatCard
          label="代理状态"
          value={props.runtimeConfig?.proxy?.configured ? "已配置" : "未配置"}
          hint={props.runtimeConfig?.proxy?.configured ? "网络环境可用于联通检查" : "请先检查代理或直连配置"}
          tone={props.runtimeConfig?.proxy?.configured ? "success" : "warning"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">最近一次回测</h2>
              {latestRun ? <Badge variant="default">{latestRun.source || "本地回测"}</Badge> : null}
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
                还没有可展示的回测结果。先进入策略页选择一个策略并运行一次回测。
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
                  当前还没有审计记录。保存策略、回测和导出 FMZ 后，这里会逐步沉淀团队操作轨迹。
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
    if (!selectedTarget) return;
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
            这里展示当前平台实际用到的数据范围、回测数据来源、代理状态以及交易所延迟与联通情况。
          </p>
        </div>
        <Button variant="outline" onClick={() => void props.reload()}>刷新数据</Button>
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
            <h2 className="text-lg font-semibold text-zinc-100">交易所联通与延迟测试</h2>
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
                <div className="text-sm text-zinc-500">选择一个交易所目标后，点击按钮即可手动测试当前延迟。</div>
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
                    {item.ok ? "可用于 FMZ 部署前的网络联通确认。" : item.error || "未返回错误详情。"}
                  </TableCell>
                </TableRow>
              ))}
              {connectivityRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-zinc-500">暂无联通检测结果。</TableCell>
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
  const positiveRuns = latestRuns.filter((run) => run.metrics.totalReturnPct >= 0).length;
  const averageReturn = latestRuns.length
    ? latestRuns.reduce((sum, run) => sum + run.metrics.totalReturnPct, 0) / latestRuns.length
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">回测中心</h1>
          <p className="mt-1 text-sm text-zinc-500">
            这里用于集中复盘本地验证结果。你在平台里管理策略档案、导入本地 Python 文件、查看历史回测、收益表现和风险指标。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void props.reload()}>刷新回测</Button>
          <Button onClick={props.onOpenStrategies}>打开策略工作流</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="回测次数" value={`${latestRuns.length}`} hint="当前列表展示最近 12 次本地回测" />
        <StatCard
          label="正收益次数"
          value={`${positiveRuns}`}
          hint="用于快速判断最近策略验证的稳定性"
          tone={positiveRuns > 0 ? "success" : "warning"}
        />
        <StatCard
          label="平均收益率"
          value={`${averageReturn.toFixed(2)}%`}
          hint="仅统计当前回测中心列表中的结果"
          tone={averageReturn >= 0 ? "success" : "warning"}
        />
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">回测台账</h2>
              <p className="mt-1 text-sm text-zinc-500">
                按时间查看每一次本地回测的策略、数据来源、收益率、回撤和期末权益。这里不负责执行下单，只服务于验证和复盘。
              </p>
            </div>
            <Badge variant="default">{latestRuns.length} 条记录</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>完成时间</TableHead>
                <TableHead>策略</TableHead>
                <TableHead>数据来源</TableHead>
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
                    <TableCell>{run.source || "本地回测"}</TableCell>
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
                    暂无回测记录。先到策略工作流里选中一个策略并运行一次回测。
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
  const [ports, setPorts] = useState<Record<NetworkClientId, string>>({
    auto: "",
    jp: "",
    sg: "",
    us: "",
    hk: "",
    direct: "",
  });
  const [routes, setRoutes] = useState<Record<string, NetworkClientId>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [tushareEnabled, setTushareEnabled] = useState(false);
  const [tushareToken, setTushareToken] = useState("");
  const [tushareBaseUrl, setTushareBaseUrl] = useState("http://api.tushare.pro");
  const [tushareSaving, setTushareSaving] = useState(false);
  const [tushareValidating, setTushareValidating] = useState(false);
  const [tushareMessage, setTushareMessage] = useState("");
  const [tushareValidationStatus, setTushareValidationStatus] = useState<{ ok: boolean; checkedAt: number } | null>(null);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmProvider, setLlmProvider] = useState("openai");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.openai.com/v1");
  const [llmModel, setLlmModel] = useState("gpt-5.4-mini");
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmValidating, setLlmValidating] = useState(false);
  const [llmMessage, setLlmMessage] = useState("");
  const [llmValidationStatus, setLlmValidationStatus] = useState<{ ok: boolean; checkedAt: number } | null>(null);
  const llmProviderOptions = [
    { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
    { value: "zhipu", label: "智谱 AI", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5" },
  ] as const;

  useEffect(() => {
    const config = props.runtimeConfig?.networkClients;
    if (!config) return;
    setPorts({
      auto: String(config.clients.auto.port),
      jp: String(config.clients.jp.port),
      sg: String(config.clients.sg.port),
      us: String(config.clients.us.port),
      hk: String(config.clients.hk.port),
      direct: String(config.clients.direct.port),
    });
    setRoutes(config.routes);
  }, [props.runtimeConfig]);

  useEffect(() => {
    const tushare = props.runtimeConfig?.dataProviders?.tushare;
    if (!tushare) return;
    setTushareEnabled(tushare.enabled);
    setTushareBaseUrl(tushare.baseUrl || "http://api.tushare.pro");
    setTushareToken("");
    setTushareMessage(tushare.status?.message || (tushare.configured ? "已配置 Tushare Token。" : "尚未配置 Tushare Token。"));
    if (tushare.status) {
      setTushareValidationStatus({
        ok: Boolean(tushare.status.ok),
        checkedAt: Number(tushare.status.checkedAt || 0),
      });
    }
  }, [props.runtimeConfig]);

  useEffect(() => {
    const llm = props.runtimeConfig?.dataProviders?.llm;
    if (!llm) return;
    setLlmEnabled(llm.enabled);
    setLlmProvider(llm.provider || "openai");
    setLlmBaseUrl(llm.baseUrl || "https://api.openai.com/v1");
    setLlmModel(llm.model || "gpt-5.4-mini");
    setLlmApiKey("");
    setLlmMessage(llm.status?.message || (llm.configured ? "已配置 LLM API。" : "未配置 LLM API，将使用系统规则过滤。"));
    if (llm.status) {
      setLlmValidationStatus({
        ok: Boolean(llm.status.ok),
        checkedAt: Number(llm.status.checkedAt || 0),
      });
    }
  }, [props.runtimeConfig]);

  const handleChangeLlmProvider = (value: string) => {
    const next = llmProviderOptions.find((item) => item.value === value);
    setLlmProvider(value);
    if (next) {
      setLlmBaseUrl(next.baseUrl);
      setLlmModel(next.model);
    }
  };

  const clientRows: NetworkClientCatalogEntry[] =
    props.runtimeConfig?.networkClientCatalog ||
    props.runtimeConfig?.networkClients.clientCatalog ||
    [];
  const routeRows: NetworkRouteCatalogEntry[] =
    props.runtimeConfig?.networkRouteCatalog ||
    props.runtimeConfig?.networkClients.routeCatalog ||
    [];

  const handleSave = async () => {
    setSaveMessage("");
    const normalized = Object.fromEntries(
      Object.entries(ports).map(([key, value]) => [key, Number(value)])
    ) as Record<keyof typeof ports, number>;

    if (Object.values(normalized).some((value) => !Number.isInteger(value) || value <= 0 || value > 65535)) {
      setSaveMessage("端口必须是 1 到 65535 之间的整数。");
      return;
    }

    setSaving(true);
    try {
      await props.saveNetworkClients({
        clients: {
          auto: { port: normalized.auto },
          jp: { port: normalized.jp },
          sg: { port: normalized.sg },
          us: { port: normalized.us },
          hk: { port: normalized.hk },
          direct: { port: normalized.direct },
        },
        routes,
        updatedAt: props.runtimeConfig?.networkClients.updatedAt || 0,
      });
      setSaveMessage("网络端口配置已保存到后端。");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTushare = async () => {
    setTushareSaving(true);
    setTushareMessage("");
    try {
      const result = await authorizedFetch<{ tushare: NonNullable<RuntimeConfig["dataProviders"]>["tushare"]; checkedAt: number }>(
        `${PLATFORM_API_BASE}/runtime/data-providers/tushare`,
        "",
        {
          method: "POST",
          body: JSON.stringify({
            enabled: tushareEnabled,
            token: tushareToken,
            baseUrl: tushareBaseUrl,
          }),
        }
      );
      setTushareEnabled(Boolean(result.tushare?.enabled));
      setTushareBaseUrl(result.tushare?.baseUrl || "http://api.tushare.pro");
      setTushareToken("");
      setTushareMessage(result.tushare?.configured ? `已保存 Tushare 配置，当前 Token：${result.tushare.tokenMasked}` : "已清空 Tushare 配置。");
      setTushareValidationStatus(result.tushare?.status ? { ok: Boolean(result.tushare.status.ok), checkedAt: Number(result.tushare.status.checkedAt || 0) } : null);
      await props.reload();
    } catch (error) {
      setTushareMessage(error instanceof Error ? error.message : "保存 Tushare 配置失败");
    } finally {
      setTushareSaving(false);
    }
  };

  const handleValidateTushare = async () => {
    setTushareValidating(true);
    setTushareMessage("");
    try {
      const result = await authorizedFetch<{ result: { ok: boolean; message: string; checkedAt: number }; tushare?: NonNullable<RuntimeConfig["dataProviders"]>["tushare"] }>(
        `${PLATFORM_API_BASE}/runtime/data-providers/tushare/validate`,
        "",
        {
          method: "POST",
          body: JSON.stringify({
            enabled: tushareEnabled,
            token: tushareToken,
            baseUrl: tushareBaseUrl,
          }),
        }
      );
      setTushareMessage(result.result.message);
      setTushareValidationStatus({
        ok: Boolean(result.result.ok),
        checkedAt: Number(result.result.checkedAt || 0),
      });
    } catch (error) {
      setTushareMessage(error instanceof Error ? error.message : "验证 Tushare 失败");
      setTushareValidationStatus({ ok: false, checkedAt: Date.now() });
    } finally {
      setTushareValidating(false);
    }
  };

  const handleSaveLlm = async () => {
    setLlmSaving(true);
    setLlmMessage("");
    try {
      const result = await authorizedFetch<{ llm: NonNullable<RuntimeConfig["dataProviders"]>["llm"]; checkedAt: number }>(
        `${PLATFORM_API_BASE}/runtime/data-providers/llm`,
        "",
        {
          method: "POST",
          body: JSON.stringify({
            enabled: llmEnabled,
            provider: llmProvider,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
            model: llmModel,
          }),
        }
      );
      setLlmEnabled(Boolean(result.llm?.enabled));
      setLlmProvider(result.llm?.provider || "openai");
      setLlmBaseUrl(result.llm?.baseUrl || "https://api.openai.com/v1");
      setLlmModel(result.llm?.model || "gpt-5.4-mini");
      setLlmApiKey("");
      setLlmMessage(result.llm?.configured ? `已保存 LLM 配置，当前 Key：${result.llm.apiKeyMasked}` : "未配置 LLM API，将使用系统规则过滤。");
      setLlmValidationStatus(result.llm?.status ? { ok: Boolean(result.llm.status.ok), checkedAt: Number(result.llm.status.checkedAt || 0) } : null);
      await props.reload();
    } catch (error) {
      setLlmMessage(error instanceof Error ? error.message : "保存 LLM 配置失败");
    } finally {
      setLlmSaving(false);
    }
  };

  const handleValidateLlm = async () => {
    setLlmValidating(true);
    setLlmMessage("");
    try {
      const result = await authorizedFetch<{ result: { ok: boolean; message: string; checkedAt: number }; llm?: NonNullable<RuntimeConfig["dataProviders"]>["llm"] }>(
        `${PLATFORM_API_BASE}/runtime/data-providers/llm/validate`,
        "",
        {
          method: "POST",
          body: JSON.stringify({
            enabled: llmEnabled,
            provider: llmProvider,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
            model: llmModel,
          }),
        }
      );
      setLlmMessage(result.result.message);
      setLlmValidationStatus({ ok: Boolean(result.result.ok), checkedAt: Number(result.result.checkedAt || 0) });
    } catch (error) {
      setLlmMessage(error instanceof Error ? error.message : "验证 LLM 配置失败");
      setLlmValidationStatus({ ok: false, checkedAt: Date.now() });
    } finally {
      setLlmValidating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">设置</h1>
        <p className="mt-1 text-sm text-zinc-500">这里展示当前平台运行配置和代理状态，方便排查环境问题。</p>
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
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">网络端口配置</h2>
              <p className="mt-1 text-sm text-zinc-500">
                为开源后的本地部署保留统一入口。这里配置各地区代理端口，以及默认给各交易目标使用哪条线路。
              </p>
            </div>
            <Button onClick={() => void handleSave()} disabled={saving || !props.runtimeConfig}>
              {saving ? "保存中..." : "保存配置"}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">代理端口</div>
              <div className="space-y-3">
                {clientRows.map((item) => (
                  <div key={item.clientId} className="grid grid-cols-[140px_1fr] items-center gap-3">
                    <label className="text-sm text-zinc-300">{item.label}</label>
                    <input
                      value={ports[item.clientId]}
                      onChange={(event) => setPorts((current) => ({ ...current, [item.clientId]: event.target.value.replace(/[^\d]/g, "") }))}
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                      inputMode="numeric"
                      placeholder={String(item.defaultPort)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">线路选择</div>
              <div className="space-y-3">
                {routeRows.map((item) => (
                  <div key={item.routeId} className="grid grid-cols-[120px_1fr] items-center gap-3">
                    <label className="text-sm text-zinc-300">{item.label}</label>
                    <select
                      value={routes[item.routeId] || "auto"}
                      onChange={(event) => setRoutes((current) => ({ ...current, [item.routeId]: event.target.value as NetworkClientId }))}
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                    >
                      {clientRows.map((client) => (
                        <option key={client.clientId} value={client.clientId}>
                          {client.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-400">
            {saveMessage || "保存后，Python 服务与 Node 侧网络客户端会读取同一份配置。已有请求不会强制中断，新请求会按新端口生效。"}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">已注册网络实现</div>
              <div className="space-y-2 text-sm text-zinc-400">
                {(props.runtimeConfig?.networkAdapters || []).map((item) => (
                  <div key={item.adapterId} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                    <div className="text-zinc-200">{item.label}</div>
                    <div className="mt-1 text-xs text-zinc-500">{item.kind} · {item.description}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">已注册延迟探测</div>
              <div className="space-y-2 text-sm text-zinc-400">
                {(props.runtimeConfig?.brokerLatencyProviders || []).map((item) => (
                  <div key={item.providerId} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                    <div className="text-zinc-200">{item.label}</div>
                    <div className="mt-1 text-xs text-zinc-500">{item.supportedTargets.join(", ")}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">A股 数据源配置</h2>
              <p className="mt-1 text-sm text-zinc-500">
                这里接入 Tushare Pro。官方文档显示，2000 积分会员可用大多数基础接口，每分钟约 200 次调用；新闻和公告类接口需要单独权限。
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void handleValidateTushare()} disabled={tushareValidating}>
                {tushareValidating ? "验证中..." : "验证 Tushare"}
              </Button>
              <Button onClick={() => void handleSaveTushare()} disabled={tushareSaving}>
                {tushareSaving ? "保存中..." : "保存 Tushare"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">连接设置</div>
              <div className="space-y-4">
                <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-300">
                  <span>启用 Tushare</span>
                  <input type="checkbox" checked={tushareEnabled} onChange={(event) => setTushareEnabled(event.target.checked)} />
                </label>
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">Base URL</label>
                  <input
                    value={tushareBaseUrl}
                    onChange={(event) => setTushareBaseUrl(event.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                    placeholder="http://api.tushare.pro"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">Token</label>
                  <input
                    value={tushareToken}
                    onChange={(event) => setTushareToken(event.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                    placeholder={props.runtimeConfig?.dataProviders?.tushare?.tokenMasked || "填写你的 Tushare Token"}
                  />
                  <div className="text-xs text-zinc-500">留空会保留当前已保存 Token，便于后续只改启用状态或 URL。</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">当前状态</div>
              <div className="space-y-3 text-sm text-zinc-400">
                <div>已启用：{props.runtimeConfig?.dataProviders?.tushare?.enabled ? "是" : "否"}</div>
                <div>已配置 Token：{props.runtimeConfig?.dataProviders?.tushare?.configured ? "是" : "否"}</div>
                <div className="break-all">当前 URL：{props.runtimeConfig?.dataProviders?.tushare?.baseUrl || tushareBaseUrl}</div>
                <div>Token 摘要：{props.runtimeConfig?.dataProviders?.tushare?.tokenMasked || "--"}</div>
                <div>最近验证：{tushareValidationStatus?.checkedAt ? formatDateTime(tushareValidationStatus.checkedAt) : props.runtimeConfig?.dataProviders?.tushare?.status?.checkedAt ? formatDateTime(props.runtimeConfig.dataProviders.tushare.status.checkedAt) : "--"}</div>
                <div className={tushareValidationStatus?.ok ?? props.runtimeConfig?.dataProviders?.tushare?.status?.ok ? "text-emerald-400" : "text-amber-400"}>
                  {tushareMessage || props.runtimeConfig?.dataProviders?.tushare?.status?.message || "尚未验证"}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-400">
            {tushareMessage || "保存后会写入本地配置文件，验证按钮会用 trade_cal 接口做一次真实测试。"}
          </div>
        </div>
      </Card>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">大模型分析配置</h2>
              <p className="mt-1 text-sm text-zinc-500">
                这里控制新闻聚合后的大模型分析。没有配置 API 时，系统会自动退回规则过滤，不会启用大模型。
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void handleValidateLlm()} disabled={llmValidating}>
                {llmValidating ? "验证中..." : "验证 LLM"}
              </Button>
              <Button onClick={() => void handleSaveLlm()} disabled={llmSaving}>
                {llmSaving ? "保存中..." : "保存 LLM"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">连接设置</div>
              <div className="space-y-4">
                <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-300">
                  <span>启用大模型分析</span>
                  <input type="checkbox" checked={llmEnabled} onChange={(event) => setLlmEnabled(event.target.checked)} />
                </label>
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">供应商</label>
                  <select
                    value={llmProvider}
                    onChange={(event) => handleChangeLlmProvider(event.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                  >
                    {llmProviderOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">接口地址</label>
                    <input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600" placeholder="按供应商自动带出，也可手动改" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-zinc-300">模型</label>
                    <input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600" placeholder="按供应商自动带出，也可手动改" />
                  </div>
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">API Key</label>
                  <input value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600" placeholder={props.runtimeConfig?.dataProviders?.llm?.apiKeyMasked || "填写你的 LLM API Key"} />
                  <div className="text-xs text-zinc-500">留空会保留当前已保存 Key。未配置 Key 时，系统会只使用规则过滤和聚类。</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">当前状态</div>
              <div className="space-y-3 text-sm text-zinc-400">
                <div>当前模式：{props.runtimeConfig?.dataProviders?.llm?.mode === "llm" ? "大模型分析" : "系统过滤"}</div>
                <div>已启用：{props.runtimeConfig?.dataProviders?.llm?.enabled ? "是" : "否"}</div>
                <div>已配置 API：{props.runtimeConfig?.dataProviders?.llm?.configured ? "是" : "否"}</div>
                <div>供应商：{(props.runtimeConfig?.dataProviders?.llm?.provider || llmProvider) === "zhipu" ? "智谱 AI" : "OpenAI"}</div>
                <div>模型：{props.runtimeConfig?.dataProviders?.llm?.model || llmModel}</div>
                <div className="break-all">当前 URL：{props.runtimeConfig?.dataProviders?.llm?.baseUrl || llmBaseUrl}</div>
                <div>Key 摘要：{props.runtimeConfig?.dataProviders?.llm?.apiKeyMasked || "--"}</div>
                <div>最近验证：{llmValidationStatus?.checkedAt ? formatDateTime(llmValidationStatus.checkedAt) : props.runtimeConfig?.dataProviders?.llm?.status?.checkedAt ? formatDateTime(props.runtimeConfig.dataProviders.llm.status.checkedAt) : "--"}</div>
                <div className={llmValidationStatus?.ok ?? props.runtimeConfig?.dataProviders?.llm?.status?.ok ? "text-emerald-400" : "text-amber-400"}>
                  {llmMessage || props.runtimeConfig?.dataProviders?.llm?.status?.message || "未配置 LLM API，将使用系统规则过滤。"}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-400">
            {llmMessage || "未配置 LLM API 时，新闻聚合仍会继续工作，但只使用系统过滤、规则聚类和事件分组。"}
          </div>
        </div>
      </Card>

    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState(() => {
    const next = localStorage.getItem("quantx.activeTab") || "dashboard";
    return ["dashboard", "intelligence", "market", "dataCenter", "backtesting", "strategies", "settings"].includes(next) ? next : "dashboard";
  });
  const snapshot = usePlatformSnapshot();

  useEffect(() => {
    localStorage.setItem("quantx.activeTab", activeTab);
  }, [activeTab]);

  let content: React.ReactNode = null;
  if (activeTab === "dashboard") content = <RuntimeErrorBoundary area="平台总览"><DashboardView {...snapshot} /></RuntimeErrorBoundary>;
  else if (activeTab === "intelligence") content = <RuntimeErrorBoundary area="市场情报中心"><MarketIntelligenceWorkspace /></RuntimeErrorBoundary>;
  else if (activeTab === "market") content = <RuntimeErrorBoundary area="行情中心"><MarketWorkspace /></RuntimeErrorBoundary>;
  else if (activeTab === "dataCenter") content = <RuntimeErrorBoundary area="数据中心"><DataCenterView {...snapshot} /></RuntimeErrorBoundary>;
  else if (activeTab === "backtesting") content = <RuntimeErrorBoundary area="回测中心"><BacktestingView {...snapshot} onOpenStrategies={() => setActiveTab("strategies")} /></RuntimeErrorBoundary>;
  else if (activeTab === "strategies") content = <RuntimeErrorBoundary area="策略工作流"><StrategyWorkbench /></RuntimeErrorBoundary>;
  else if (activeTab === "settings") content = <RuntimeErrorBoundary area="设置"><SettingsView {...snapshot} /></RuntimeErrorBoundary>;

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
