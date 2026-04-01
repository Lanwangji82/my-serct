import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { AlertProvider } from "./lib/AlertContext";
import { LanguageProvider } from "./lib/i18n";
import { AppLayout } from "./components/common/Layout";
import { RuntimeErrorBoundary } from "./components/common/RuntimeErrorBoundary";
import { ToastContainer } from "./components/common/NotificationCenter";
import { AccountConnectionsSettings } from "./components/portfolio/AccountConnectionsSettings";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/common/ui";
import { authorizedFetch, formatDateTime, formatMoney, PLATFORM_API_BASE } from "./lib/platform-client";
import type { AppTab, PlatformSnapshot } from "./app/platform-types";
import { usePlatformSnapshot as useSharedPlatformSnapshot } from "./app/usePlatformSnapshot";
import type { RuntimeConfig } from "./lib/platform-client";

const MarketIntelligenceWorkspace = lazy(() =>
  import("./workspaces/MarketIntelligenceWorkspace").then((module) => ({ default: module.MarketIntelligenceWorkspace })),
);
const StrategyWorkbench = lazy(() => import("./workspaces/StrategyWorkbench").then((module) => ({ default: module.StrategyWorkbench })));
const PortfolioWorkspace = lazy(() => import("./workspaces/PortfolioWorkspace").then((module) => ({ default: module.PortfolioWorkspace })));

function StatCard(props: { label: string; value: string; hint: string }) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-2 p-5">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{props.label}</div>
        <div className="text-2xl font-semibold text-zinc-50">{props.value}</div>
        <div className="text-sm text-zinc-500">{props.hint}</div>
      </div>
    </Card>
  );
}

function DataCenterView(props: PlatformSnapshot) {
  const providerChecks = props.runtimeOperations?.providerChecks || [];
  const eventSourceChecks = props.runtimeOperations?.eventSourceChecks || [];
  const storageStatus = props.runtimeOperations?.storage || props.runtimeConfig?.storage;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">数据中心</h1>
          <p className="mt-1 text-sm text-zinc-500">查看运行状态、事件源健康和存储缓存状态。</p>
        </div>
        <Button variant="outline" onClick={() => void props.reload("dataCenter")}>刷新数据</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="策略数" value={`${props.strategies.length}`} hint="当前加载到平台的策略" />
        <StatCard label="回测数" value={`${props.backtests.length}`} hint="最近回测记录总量" />
        <StatCard label="事件源" value={`${eventSourceChecks.filter((item) => item.ok).length}/${eventSourceChecks.length || 0}`} hint="事件抓取健康度" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">运行时提供商</h2>
            <div className="space-y-3">
              {providerChecks.map((item) => (
                <div key={item.providerId} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-200">{item.label}</span>
                    <Badge variant={item.ok ? "success" : item.configured ? "warning" : "default"}>{item.ok ? "正常" : "异常"}</Badge>
                  </div>
                  <div className="mt-2 text-zinc-400">{item.message}</div>
                </div>
              ))}
              {providerChecks.length === 0 ? <div className="text-sm text-zinc-500">暂无运行时检查结果。</div> : null}
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">存储与缓存</h2>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
              <div>模式：{storageStatus?.modeLabel || "--"}</div>
              <div className="mt-2">请求后端：{storageStatus?.requestedBackend || "--"}</div>
              <div className="mt-2">实际后端：{storageStatus?.activeBackend || "--"}</div>
              <div className="mt-2">Redis：{storageStatus?.redis?.enabled ? "已连接" : storageStatus?.redis?.configured ? "已配置但不可用" : "未配置"}</div>
              <div className="mt-2 break-all">数据库路径：{storageStatus?.databasePath || props.runtimeConfig?.databasePath || "--"}</div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function BacktestingView(props: PlatformSnapshot & { onOpenStrategies: () => void }) {
  const strategyMap = useMemo(() => new Map(props.strategies.map((item) => [item.id, item])), [props.strategies]);
  const latestRuns = props.backtests.slice(0, 12);
  const averageReturn = latestRuns.length ? latestRuns.reduce((sum, run) => sum + run.metrics.totalReturnPct, 0) / latestRuns.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">回测中心</h1>
          <p className="mt-1 text-sm text-zinc-500">聚合最近回测记录，快速查看收益、回撤和策略复盘结果。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void props.reload("backtesting")}>刷新回测</Button>
          <Button onClick={props.onOpenStrategies}>打开策略工作台</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="回测次数" value={`${latestRuns.length}`} hint="当前列表展示最近 12 次本地回测" />
        <StatCard label="平均收益率" value={`${averageReturn.toFixed(2)}%`} hint="仅统计当前回测列表中的结果" />
        <StatCard label="策略数量" value={`${props.strategies.length}`} hint="已注册的策略档案数量" />
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">回测台账</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>完成时间</TableHead>
                <TableHead>策略</TableHead>
                <TableHead>数据来源</TableHead>
                <TableHead>收益率</TableHead>
                <TableHead>最大回撤</TableHead>
                <TableHead>期末权益</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latestRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{formatDateTime(run.completedAt)}</TableCell>
                  <TableCell>{strategyMap.get(run.strategyId)?.name || run.strategyId}</TableCell>
                  <TableCell>{run.source || "本地回测"}</TableCell>
                  <TableCell className={run.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}>{run.metrics.totalReturnPct.toFixed(2)}%</TableCell>
                  <TableCell>{run.metrics.maxDrawdownPct.toFixed(2)}%</TableCell>
                  <TableCell>{formatMoney(run.metrics.endingEquity)}</TableCell>
                </TableRow>
              ))}
              {latestRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-zinc-500">暂无回测记录。先运行一次回测。</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

function NetworkPortsSettings(props: PlatformSnapshot) {
  const settings = props.runtimeConfig?.networkClients;
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!settings) return;
    const nextPorts: Record<string, string> = {};
    for (const [clientId, config] of Object.entries(settings.clients || {})) {
      nextPorts[clientId] = String(config.port ?? "");
    }
    setPorts(nextPorts);
    setRoutes({ ...(settings.routes || {}) });
  }, [settings]);

  const clientCatalog = settings?.clientCatalog || props.runtimeConfig?.networkClientCatalog || [];
  const routeCatalog = settings?.routeCatalog || props.runtimeConfig?.networkRouteCatalog || [];

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setMessage("");
    try {
      const payload: RuntimeConfig["networkClients"] = {
        clients: Object.fromEntries(
          Object.entries(settings.clients || {}).map(([clientId]) => [
            clientId,
            { port: Number.parseInt(ports[clientId] || "0", 10) || 0 },
          ]),
        ) as RuntimeConfig["networkClients"]["clients"],
        routes: Object.fromEntries(
          Object.entries(settings.routes || {}).map(([routeId, clientId]) => [routeId, routes[routeId] || clientId]),
        ) as RuntimeConfig["networkClients"]["routes"],
        clientCatalog: settings.clientCatalog,
        routeCatalog: settings.routeCatalog,
        updatedAt: settings.updatedAt,
      };
      await props.saveNetworkClients(payload);
      setMessage("端口设置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存端口设置失败");
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="p-6 text-sm text-zinc-500">当前没有可编辑的端口设置。</div>
      </Card>
    );
  }

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">端口与路由设置</h2>
            <p className="mt-1 text-sm text-zinc-500">恢复本地代理端口和交易所路由设置。应用端口当前仍为只读显示。</p>
          </div>
          <Button variant="outline" onClick={() => void props.reload("settings")} disabled={saving}>
            刷新配置
          </Button>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-300">
          <div>应用端口: {props.runtimeConfig?.appPort || "--"}</div>
          <div className="mt-2">最后更新: {settings.updatedAt ? formatDateTime(settings.updatedAt) : "--"}</div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
            <div className="text-sm font-medium text-zinc-100">代理端口</div>
            {clientCatalog.map((client) => (
              <label key={client.clientId} className="grid grid-cols-[1fr_120px] items-center gap-3 text-sm text-zinc-300">
                <span>
                  {client.label}
                  <span className="ml-2 text-xs text-zinc-500">{client.clientId}</span>
                </span>
                <input
                  value={ports[client.clientId] || ""}
                  onChange={(event) => setPorts((current) => ({ ...current, [client.clientId]: event.target.value.replace(/[^\d]/g, "") }))}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                  inputMode="numeric"
                />
              </label>
            ))}
          </div>

          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
            <div className="text-sm font-medium text-zinc-100">路由分配</div>
            {routeCatalog.map((route) => (
              <label key={route.routeId} className="grid grid-cols-[1fr_160px] items-center gap-3 text-sm text-zinc-300">
                <span>{route.label}</span>
                <select
                  value={routes[route.routeId] || settings.routes[route.routeId] || "auto"}
                  onChange={(event) => setRoutes((current) => ({ ...current, [route.routeId]: event.target.value }))}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                >
                  {clientCatalog.map((client) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "保存中..." : "保存端口设置"}
          </Button>
          {message ? <div className="text-sm text-zinc-400">{message}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function ExchangeConnectivitySettings(props: PlatformSnapshot) {
  const [busyTarget, setBusyTarget] = useState("");
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; checkedAt: number }>>({});

  const targets = props.runtimeConfig?.brokerTargets?.filter((item) => item.brokerId === "binance" || item.brokerId === "okx") || [];

  const runCheck = async (brokerTarget: string) => {
    setBusyTarget(brokerTarget);
    try {
      const query = new URLSearchParams({ brokerTarget });
      const result = await authorizedFetch<{ brokerTarget: string; ok: boolean; latencyMs?: number; error?: string; checkedAt?: number; label?: string }>(
        `${PLATFORM_API_BASE}/runtime/latency?${query.toString()}`,
        "",
      );
      setResults((current) => ({
        ...current,
        [brokerTarget]: {
          ok: Boolean(result.ok),
          message: result.ok ? `连通成功，延迟 ${result.latencyMs ?? "--"} ms` : result.error || "连通失败",
          checkedAt: result.checkedAt || Date.now(),
        },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [brokerTarget]: {
          ok: false,
          message: error instanceof Error ? error.message : "连通失败",
          checkedAt: Date.now(),
        },
      }));
    } finally {
      setBusyTarget("");
    }
  };

  if (targets.length === 0) return null;

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-5 p-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">交易所连通性</h2>
          <p className="mt-1 text-sm text-zinc-500">直接检查 Binance / OKX 当前路由下的可达性，方便判断代理或端口是否生效。</p>
        </div>
        <div className="space-y-3">
          {targets.map((target) => {
            const status = results[target.target];
            return (
              <div key={target.target} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-100">{target.label}</div>
                    <div className="mt-1 text-xs text-zinc-500">{target.target}</div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void runCheck(target.target)} disabled={busyTarget === target.target}>
                    {busyTarget === target.target ? "检测中..." : "检测连通性"}
                  </Button>
                </div>
                {status ? (
                  <div className={`mt-3 text-sm ${status.ok ? "text-emerald-400" : "text-amber-400"}`}>
                    {status.message} {status.checkedAt ? ` / ${formatDateTime(status.checkedAt)}` : ""}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function SettingsView(props: PlatformSnapshot) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">设置</h1>
        <p className="mt-1 text-sm text-zinc-500">查看平台运行配置，并管理只读账户连接。</p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">运行配置</h2>
            <div className="space-y-3 text-sm text-zinc-400">
              <div>应用端口：{props.runtimeConfig?.appPort || "--"}</div>
              <div>本地直连模式：{props.runtimeConfig?.localMode ? "开启" : "关闭"}</div>
              <div className="break-all">数据库路径：{props.runtimeConfig?.databasePath || "--"}</div>
              <div className="break-all">策略目录：{props.runtimeConfig?.strategyStoreRoot || "--"}</div>
              <div>最后刷新：{props.runtimeConfig?.checkedAt ? formatDateTime(props.runtimeConfig.checkedAt) : "--"}</div>
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">代理状态</h2>
            <div className="space-y-3 text-sm text-zinc-400">
              <div>代理模式：{props.runtimeConfig?.proxy?.configured ? props.runtimeConfig.proxy.mode || "active" : "未配置"}</div>
              <div>代理来源：{props.runtimeConfig?.proxy?.source || "--"}</div>
              <div className="break-all">当前出口：{props.runtimeConfig?.proxy?.activeProxy || "--"}</div>
              <div className="break-all">HTTP：{props.runtimeConfig?.proxy?.httpProxy || "--"}</div>
              <div className="break-all">HTTPS：{props.runtimeConfig?.proxy?.httpsProxy || "--"}</div>
            </div>
          </div>
        </Card>
      </div>

      <NetworkPortsSettings {...props} />
      <ExchangeConnectivitySettings {...props} />
      <AccountConnectionsSettings />
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const next = localStorage.getItem("quantx.activeTab") || "intelligence";
    return ["intelligence", "portfolio", "dataCenter", "backtesting", "strategies", "settings"].includes(next) ? (next as AppTab) : "intelligence";
  });
  const snapshot = useSharedPlatformSnapshot(activeTab);

  useEffect(() => {
    localStorage.setItem("quantx.activeTab", activeTab);
  }, [activeTab]);

  let content: React.ReactNode = null;
  if (activeTab === "intelligence") content = <RuntimeErrorBoundary area="新闻流"><MarketIntelligenceWorkspace /></RuntimeErrorBoundary>;
  else if (activeTab === "portfolio") content = <RuntimeErrorBoundary area="持仓中心"><PortfolioWorkspace /></RuntimeErrorBoundary>;
  else if (activeTab === "dataCenter") content = <DataCenterView {...snapshot} />;
  else if (activeTab === "backtesting") content = <BacktestingView {...snapshot} onOpenStrategies={() => setActiveTab("strategies")} />;
  else if (activeTab === "strategies") content = <RuntimeErrorBoundary area="策略工作台"><StrategyWorkbench /></RuntimeErrorBoundary>;
  else if (activeTab === "settings") content = <SettingsView {...snapshot} />;

  return (
    <LanguageProvider>
      <AlertProvider>
        <AppLayout activeTab={activeTab} setActiveTab={(tab) => setActiveTab(tab as AppTab)}>
          <Suspense fallback={<div className="text-sm text-zinc-500">加载中...</div>}>{content}</Suspense>
        </AppLayout>
        <ToastContainer />
      </AlertProvider>
    </LanguageProvider>
  );
}
