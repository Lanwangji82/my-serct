import React, { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Card } from "./ui";
import { authorizedFetch, PLATFORM_API_BASE, PORTFOLIO_API_BASE } from "../lib/platform-client";

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

type StrategySummary = {
  id: string;
  name: string;
  symbol: string;
  interval: string;
  runtime: string;
};

type RuntimeConfig = {
  proxy?: {
    configured: boolean;
    mode?: string;
    source?: string;
  };
};

const moduleLabelMap: Record<string, string> = {
  Portfolio: "组合",
  Deployment: "部署",
  Risk: "风险",
};

const capabilityMap: Record<string, string> = {
  allocations: "分组分配",
  exposure: "敞口总览",
  deployment: "部署编排",
  watchlist: "观察池",
  rollup: "汇总看板",
};

function heatColor(level: number) {
  if (level >= 4) return "bg-rose-500/30 text-rose-300 border-rose-500/30";
  if (level >= 3) return "bg-amber-500/25 text-amber-300 border-amber-500/30";
  if (level >= 2) return "bg-sky-500/20 text-sky-300 border-sky-500/30";
  return "bg-zinc-900/40 text-zinc-300 border-zinc-800";
}

function translateLabel(label: string) {
  return moduleLabelMap[label] || label;
}

function translateCapability(value: string) {
  return capabilityMap[value] || value;
}

function runtimeLabel(value: string) {
  if (value === "production") return "生产部署";
  if (value === "sandbox") return "沙盒部署";
  if (value === "paper") return "纸面验证";
  if (value === "backtest-only") return "仅回测";
  return value;
}

export function PortfolioWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState("正在连接组合服务...");

  useEffect(() => {
    void (async () => {
      try {
        const [me, nextModules, nextStrategies, nextRuntime] = await Promise.all([
          authorizedFetch<{ user: { email: string } }>(`${PLATFORM_API_BASE}/me`, ""),
          authorizedFetch<ModuleSummary[]>(`${PORTFOLIO_API_BASE}/modules`, ""),
          authorizedFetch<StrategySummary[]>(`${PLATFORM_API_BASE}/strategies`, ""),
          authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/config`, "").catch(() => null),
        ]);
        setUser(me.user);
        setModules(nextModules);
        setStrategies(nextStrategies);
        setRuntimeConfig(nextRuntime);
        setStatus("组合服务已连接");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载组合服务失败");
      }
    })();
  }, []);

  const deploymentReady = strategies.filter((item) => item.runtime !== "backtest-only").length;

  const exposureGrid = useMemo(() => {
    const counts = new Map<string, number>();
    for (const strategy of strategies) {
      counts.set(strategy.symbol, (counts.get(strategy.symbol) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count);
  }, [strategies]);

  const runtimeMix = useMemo(() => {
    const counts = new Map<string, number>();
    for (const strategy of strategies) {
      counts.set(runtimeLabel(strategy.runtime), (counts.get(runtimeLabel(strategy.runtime)) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([runtime, count]) => ({ runtime, count }));
  }, [strategies]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">组合与部署规划</h1>
          <p className="mt-1 text-sm text-zinc-500">
            组合页现在不再展示旧的纸面账户摘要，而是聚焦于策略覆盖密度、候选队列和运行分布判断。
          </p>
        </div>
        {user ? <Badge variant="success">{user.email}</Badge> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">模块数量</div><div className="text-2xl font-semibold text-zinc-50">{modules.length}</div><div className="text-sm text-zinc-500">当前组合治理能力</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">策略总数</div><div className="text-2xl font-semibold text-zinc-50">{strategies.length}</div><div className="text-sm text-zinc-500">平台内已归档策略资产</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">可部署策略</div><div className="text-2xl font-semibold text-zinc-50">{deploymentReady}</div><div className="text-sm text-zinc-500">运行环境不是仅回测的策略</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">代理状态</div><div className="text-2xl font-semibold text-zinc-50">{runtimeConfig?.proxy?.configured ? "已配置" : "未配置"}</div><div className="text-sm text-zinc-500">执行前请先确认网络环境</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">组合模块</h2>
            <div className="space-y-3">
              {modules.map((module) => (
                <div key={module.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="font-medium text-zinc-100">{translateLabel(module.label)}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {module.capabilities.map((capability) => (
                      <Badge key={capability} variant="default">{translateCapability(capability)}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
              <div className="mt-2">代理状态：{runtimeConfig?.proxy?.configured ? `${runtimeConfig.proxy.mode || "active"} · ${runtimeConfig.proxy.source || "unknown"}` : "未配置"}</div>
              <div className="mt-2">使用建议：先看热力图和运行分布，再决定哪些策略进入下一阶段。</div>
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">候选敞口热力图</h2>
              <p className="mt-1 text-sm text-zinc-500">这里按策略覆盖的交易对统计候选风险敞口，不是假实盘持仓，但足够帮助团队发现过度拥挤的币种。</p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {exposureGrid.map((item) => (
                <div key={item.symbol} className={`rounded-xl border p-4 ${heatColor(item.count)}`}>
                  <div className="text-sm font-medium">{item.symbol}</div>
                  <div className="mt-2 text-2xl font-semibold">{item.count}</div>
                  <div className="mt-1 text-xs opacity-80">候选策略数</div>
                </div>
              ))}
              {exposureGrid.length === 0 ? (
                <div className="col-span-full rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
                  暂无策略覆盖数据，无法生成热力图。
                </div>
              ) : null}
            </div>
            <div className="h-[220px]">
              {runtimeMix.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={runtimeMix}>
                    <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                    <XAxis dataKey="runtime" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="count" name="策略数" fill="#38bdf8" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">部署候选策略</h2>
          <div className="space-y-3">
            {strategies.map((strategy) => (
              <div key={strategy.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-zinc-100">{strategy.name}</div>
                    <div className="mt-1 text-sm text-zinc-500">{strategy.symbol} · {strategy.interval}</div>
                  </div>
                  <Badge variant={strategy.runtime === "production" ? "warning" : "success"}>
                    {runtimeLabel(strategy.runtime)}
                  </Badge>
                </div>
              </div>
            ))}
            {strategies.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
                暂无策略，请先在策略工作流中归档策略。
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
