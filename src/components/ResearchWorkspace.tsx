import React, { useEffect, useState } from "react";
import { Badge, Button, Card } from "./ui";
import { authorizedFetch, formatDateTime, getRuntimeLabel, PLATFORM_API_BASE, RESEARCH_API_BASE } from "../lib/platform-client";

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
  const [status, setStatus] = useState("正在连接本地研究服务。");

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
        setStatus("研究服务已连接。");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载研究服务失败");
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">研究服务</h1>
          <p className="mt-1 text-sm text-zinc-500">直接连接研究服务，用于策略发现、因子分析与仿真回测。</p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {modules.map((module) => (
              <Card key={module.id} className="border-zinc-800 bg-zinc-950/85">
                <div className="p-6">
                  <div className="text-sm font-medium text-zinc-100">{module.label}</div>
                  <div className="mt-3 space-y-2 text-sm text-zinc-400">
                    {module.capabilities.map((capability) => (
                      <div key={capability}>{capability}</div>
                    ))}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-100">策略库</h2>
                  <Button variant="outline">研究笔记本</Button>
                </div>
                <div className="space-y-3">
                  {strategies.map((strategy) => (
                    <div key={strategy.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-zinc-100">{strategy.name}</div>
                          <div className="mt-1 text-sm text-zinc-500">{strategy.description}</div>
                        </div>
                        <Badge variant="default">{getRuntimeLabel(strategy.runtime)}</Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                        <span>{strategy.symbol}</span>
                        <span>{strategy.interval}</span>
                        <span>{strategy.template}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-100">最近仿真</h2>
                  <Badge variant="warning">{backtests.length} 次</Badge>
                </div>
                <div className="space-y-3">
                  {backtests.slice(0, 6).map((run) => (
                    <div key={run.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-zinc-200">{formatDateTime(run.completedAt)}</span>
                        <span className={run.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                          {run.metrics.totalReturnPct.toFixed(2)}%
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">
                        夏普 {run.metrics.sharpe.toFixed(2)} | 交易 {run.metrics.trades} 次
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
      </>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
