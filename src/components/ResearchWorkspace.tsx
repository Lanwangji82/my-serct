import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import { authorizedFetch, formatDateTime, formatMoney, RESEARCH_API_BASE, PLATFORM_API_BASE } from "../lib/platform-client";

type Strategy = {
  id: string;
  name: string;
  description: string;
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
};

type BacktestTrade = {
  time: number;
  side: string;
  price: number;
  quantity: number;
  fee?: number;
  pnl?: number;
};

type BacktestRun = {
  id: string;
  strategyId: string;
  completedAt: number;
  source?: string;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    trades: number;
    endingEquity?: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: BacktestTrade[];
};

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

const moduleLabelMap: Record<string, string> = {
  Research: "研究",
  "Local Validation": "本地验证",
  Operations: "运行观察",
};

const capabilityMap: Record<string, string> = {
  "strategy registry": "策略档案库",
  "factor research": "因子研究",
  "alpha experiments": "策略实验",
  "local backtests": "本地回测",
  "parameter sweeps": "参数扫描",
  "historical replay": "历史重放",
  "network checks": "网络联通检查",
  "deployment checklist": "部署清单",
  "runtime visibility": "运行观察",
};

function translateLabel(label: string) {
  return moduleLabelMap[label] || label;
}

function translateCapability(value: string) {
  return capabilityMap[value] || value;
}

export function ResearchWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [status, setStatus] = useState("正在连接研究服务...");

  const runtimeDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const strategy of strategies) {
      counts.set(strategy.runtime, (counts.get(strategy.runtime) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([runtime, count]) => ({ runtime, count }));
  }, [strategies]);

  const backtestTrend = useMemo(() => {
    return backtests.slice(0, 12).reverse().map((run, index) => ({
      name: `${index + 1}`,
      returnPct: Number(run.metrics.totalReturnPct.toFixed(2)),
      drawdownPct: Number(run.metrics.maxDrawdownPct.toFixed(2)),
    }));
  }, [backtests]);

  const latestRun = backtests[0] || null;

  const latestCurve = useMemo(() => {
    const points = latestRun?.equityCurve || [];
    let peak = Number.NEGATIVE_INFINITY;
    return points.map((point) => {
      peak = Math.max(peak, point.equity);
      const drawdownPct = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
      return {
        time: new Date(point.time * 1000).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        equity: Number(point.equity.toFixed(2)),
        drawdownPct: Number(drawdownPct.toFixed(2)),
      };
    });
  }, [latestRun]);

  const latestTrades = (latestRun?.trades || []).slice(0, 10);

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
            研究页现在聚焦于策略资产、最近回测表现和触发复盘。这里不承担实盘执行，主要帮助团队判断策略值不值得继续推进。
          </p>
        </div>
        {user ? <Badge variant="success">{user.email}</Badge> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">研究模块</div><div className="text-2xl font-semibold text-zinc-50">{modules.length}</div><div className="text-sm text-zinc-500">研究边界内的已接入能力</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">策略数量</div><div className="text-2xl font-semibold text-zinc-50">{strategies.length}</div><div className="text-sm text-zinc-500">当前已归档可研究策略</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">回测记录</div><div className="text-2xl font-semibold text-zinc-50">{backtests.length}</div><div className="text-sm text-zinc-500">可用于复盘和横向比较</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">最近回测</div><div className="text-2xl font-semibold text-zinc-50">{latestRun ? `${latestRun.metrics.totalReturnPct.toFixed(2)}%` : "--"}</div><div className="text-sm text-zinc-500">最新收益率，配合回撤一起判断</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">研究模块</h2>
              <Button variant="outline" disabled>研究笔记功能待接入</Button>
            </div>
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
              <div>最近回测时间：{latestRun ? formatDateTime(latestRun.completedAt) : "--"}</div>
              <div className="mt-2">最近回测来源：{latestRun?.source || "--"}</div>
              <div className="mt-2">最近夏普：{latestRun ? latestRun.metrics.sharpe.toFixed(2) : "--"}</div>
              <div className="mt-2">最近最大回撤：{latestRun ? `${latestRun.metrics.maxDrawdownPct.toFixed(2)}%` : "--"}</div>
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">回测表现概览</h2>
              <p className="mt-1 text-sm text-zinc-500">上图看最近 12 次回测收益与回撤，下图看最近一次回测的权益变化和回撤轨迹。</p>
            </div>
            <div className="h-[220px]">
              {backtestTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={backtestTrend}>
                    <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="returnPct" name="收益率" fill="#10b981" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="drawdownPct" name="最大回撤" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">暂无回测数据。</div>
              )}
            </div>
            <div className="h-[240px]">
              {latestCurve.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={latestCurve}>
                    <defs>
                      <linearGradient id="researchEquityFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#38bdf8" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} width={72} />
                    <Tooltip />
                    <Area type="monotone" dataKey="equity" name="权益" stroke="#38bdf8" fill="url(#researchEquityFill)" strokeWidth={2} />
                    <Area type="monotone" dataKey="drawdownPct" name="回撤" stroke="#f59e0b" fillOpacity={0} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">最近一次回测没有权益曲线数据。</div>
              )}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
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
                      <div className="mt-1 text-xs text-zinc-500">{strategy.description || "暂无策略说明"}</div>
                    </TableCell>
                    <TableCell>{strategy.symbol}</TableCell>
                    <TableCell>{strategy.interval}</TableCell>
                    <TableCell>{strategy.template === "python" ? "Python" : strategy.template}</TableCell>
                    <TableCell>{strategy.runtime}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">最近信号触发明细</h2>
              <p className="mt-1 text-sm text-zinc-500">这里先按最近一次回测的成交记录展示触发点，后续如果接入更细粒度图表，可以再把买卖点标到 K 线图上。</p>
            </div>
            {latestTrades.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>方向</TableHead>
                    <TableHead>价格</TableHead>
                    <TableHead>数量</TableHead>
                    <TableHead>盈亏</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latestTrades.map((trade, index) => (
                    <TableRow key={`${trade.time}-${trade.price}-${index}`}>
                      <TableCell>{formatDateTime(trade.time)}</TableCell>
                      <TableCell>{trade.side}</TableCell>
                      <TableCell>{formatMoney(trade.price)}</TableCell>
                      <TableCell>{trade.quantity.toFixed(6)}</TableCell>
                      <TableCell className={(trade.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>{formatMoney(trade.pnl || 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
                最近一次回测没有成交明细，暂时无法做信号触发复盘。
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
