import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import { authorizedFetch, formatDateTime, RESEARCH_API_BASE, PLATFORM_API_BASE } from "../lib/platform-client";

type Strategy = {
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
  completedAt: number;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    trades: number;
  };
};

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

export function ResearchWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [status, setStatus] = useState("正在连接研究服务...");

  const strategyStats = useMemo(() => {
    const runtimeCount = new Map<string, number>();
    for (const strategy of strategies) {
      runtimeCount.set(strategy.runtime, (runtimeCount.get(strategy.runtime) || 0) + 1);
    }
    return runtimeCount;
  }, [strategies]);

  useEffect(() => {
    void (async () => {
      try {
        const [me, nextModules, nextStrategies, nextBacktests] = await Promise.all([
          authorizedFetch<{ user: { email: string } }>(`${PLATFORM_API_BASE}/me`, ""),
          authorizedFetch<ModuleSummary[]>(`${RESEARCH_API_BASE}/modules`, ""),
          authorizedFetch<Strategy[]>(`${RESEARCH_API_BASE}/strategies`, ""),
          authorizedFetch<BacktestRun[]>(`${RESEARCH_API_BASE}/backtests`, ""),
        ]);
        setUser(me.user);
        setModules(nextModules);
        setStrategies(nextStrategies);
        setBacktests(nextBacktests);
        setStatus("研究服务已连接");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载研究服务失败");
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">研究工作台</h1>
          <p className="mt-1 text-sm text-zinc-500">
            用来梳理策略资产、管理研究模块、快速查看最近的回测表现。这里应该是研究员每天打开后就能工作的地方。
          </p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">研究模块</div><div className="text-2xl font-semibold text-zinc-50">{modules.length}</div><div className="text-sm text-zinc-500">当前注册到研究边界的服务能力</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">策略数量</div><div className="text-2xl font-semibold text-zinc-50">{strategies.length}</div><div className="text-sm text-zinc-500">所有研究策略的总量</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">最近回测</div><div className="text-2xl font-semibold text-zinc-50">{backtests.length}</div><div className="text-sm text-zinc-500">可用于研究复盘的结果记录</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">运行环境</div><div className="text-2xl font-semibold text-zinc-50">{strategyStats.size}</div><div className="text-sm text-zinc-500">纸面、沙盒、生产分布</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">研究模块</h2>
              <Button variant="outline" disabled>后续接研究笔记</Button>
            </div>
            <div className="space-y-3">
              {modules.map((module) => (
                <div key={module.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="font-medium text-zinc-100">{module.label}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {module.capabilities.map((capability) => (
                      <Badge key={capability} variant="default">{capability}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">策略清单</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>策略</TableHead>
                  <TableHead>标的</TableHead>
                  <TableHead>周期</TableHead>
                  <TableHead>模板</TableHead>
                  <TableHead>环境</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {strategies.map((strategy) => (
                  <TableRow key={strategy.id}>
                    <TableCell>
                      <div className="font-medium text-zinc-100">{strategy.name}</div>
                      <div className="mt-1 text-xs text-zinc-500">{strategy.description}</div>
                    </TableCell>
                    <TableCell>{strategy.symbol}</TableCell>
                    <TableCell>{strategy.interval}</TableCell>
                    <TableCell>{strategy.template}</TableCell>
                    <TableCell>{strategy.runtime}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">最近回测</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>策略</TableHead>
                <TableHead>收益率</TableHead>
                <TableHead>夏普</TableHead>
                <TableHead>交易次数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backtests.slice(0, 12).map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{formatDateTime(run.completedAt)}</TableCell>
                  <TableCell>{strategies.find((item) => item.id === run.strategyId)?.name || run.strategyId}</TableCell>
                  <TableCell className={run.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}>{run.metrics.totalReturnPct.toFixed(2)}%</TableCell>
                  <TableCell>{run.metrics.sharpe.toFixed(2)}</TableCell>
                  <TableCell>{run.metrics.trades}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
