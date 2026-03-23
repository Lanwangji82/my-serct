import React from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import { formatDateTime, formatMoney } from "../lib/platform-client";

type Strategy = {
  id?: string;
  symbol: string;
  template: string;
  parameters: Record<string, number>;
  risk: {
    maxNotional: number;
    maxDailyLoss: number;
  };
};

type BacktestTrade = {
  time: number;
  side: string;
  price: number;
  quantity: number;
  fee?: number;
  pnl?: number;
  reason?: string;
};

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
    winRatePct?: number;
    trades: number;
    endingEquity?: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: BacktestTrade[];
  completedAt: number;
};

type BacktestConfig = {
  lookback: number;
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
};

function ConfigField(props: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <label className="space-y-2">
      <div>
        <div className="text-sm font-medium text-zinc-100">{props.label}</div>
        <div className="mt-1 text-xs leading-5 text-zinc-500">{props.hint}</div>
      </div>
      <input
        type="number"
        value={props.value}
        min={props.min}
        step={props.step ?? 1}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
      />
    </label>
  );
}

export function BacktestRunsPanel(props: {
  selectedStrategy: Strategy | null;
  backtests: BacktestRun[];
  busy: boolean;
  config: BacktestConfig;
  onConfigChange: (config: BacktestConfig) => void;
  onRunBacktest: () => void;
}) {
  if (!props.selectedStrategy) {
    return null;
  }

  const runs = props.backtests.filter((item) => item.strategyId === props.selectedStrategy?.id).slice(0, 8);
  const latestRun = runs[0] || null;
  const curve = (latestRun?.equityCurve || []).map((point) => ({
    time: new Date(point.time * 1000).toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
    equity: Number(point.equity.toFixed(2)),
  }));
  const tradeRows = (latestRun?.trades || []).slice(0, 12);

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-5 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">回测模块</h2>
            <p className="mt-1 text-sm text-zinc-500">
              这里负责配置回测参数、查看收益与回撤、检查权益曲线，并追踪每一笔历史成交。
            </p>
          </div>
          <Badge variant="success">{props.selectedStrategy.symbol}</Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ConfigField
            label="回看 K 线数量"
            hint="用于回测的历史样本长度。数值越大，覆盖的时间区间越长。"
            value={props.config.lookback}
            min={100}
            step={10}
            onChange={(value) => props.onConfigChange({ ...props.config, lookback: value })}
          />
          <ConfigField
            label="初始资金"
            hint="回测开始时使用的账户本金，单位是美元。"
            value={props.config.initialCapital}
            min={1000}
            step={100}
            onChange={(value) => props.onConfigChange({ ...props.config, initialCapital: value })}
          />
          <ConfigField
            label="手续费（bps）"
            hint="每次成交的手续费。1 bps = 0.01%。"
            value={props.config.feeBps}
            min={0}
            step={0.5}
            onChange={(value) => props.onConfigChange({ ...props.config, feeBps: value })}
          />
          <ConfigField
            label="滑点（bps）"
            hint="模拟真实成交偏差。数值越大，结果越保守。"
            value={props.config.slippageBps}
            min={0}
            step={0.5}
            onChange={(value) => props.onConfigChange({ ...props.config, slippageBps: value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm text-zinc-400 xl:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">策略类型：{props.selectedStrategy.template === "python" ? "Python" : "模板"}</div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">快线 / 窗口：{props.selectedStrategy.parameters.fastPeriod || props.selectedStrategy.parameters.breakoutLookback || "--"}</div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">慢线：{props.selectedStrategy.parameters.slowPeriod || "--"}</div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">最大名义金额：{formatMoney(props.selectedStrategy.risk.maxNotional)}</div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={props.onRunBacktest} disabled={props.busy}>
            {props.busy ? "回测运行中..." : "运行回测"}
          </Button>
          {latestRun ? <span className="text-sm text-zinc-500">最近一次运行时间：{formatDateTime(latestRun.completedAt)}</span> : null}
        </div>

        {latestRun ? (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">收益率</div><div className={`mt-2 text-xl font-semibold ${latestRun.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{latestRun.metrics.totalReturnPct.toFixed(2)}%</div></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">夏普</div><div className="mt-2 text-xl font-semibold text-zinc-100">{latestRun.metrics.sharpe.toFixed(2)}</div></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">最大回撤</div><div className="mt-2 text-xl font-semibold text-amber-400">{latestRun.metrics.maxDrawdownPct.toFixed(2)}%</div></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">交易次数</div><div className="mt-2 text-xl font-semibold text-zinc-100">{latestRun.metrics.trades}</div></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">期末权益</div><div className="mt-2 text-xl font-semibold text-zinc-100">{formatMoney(latestRun.metrics.endingEquity)}</div></div>
          </div>
        ) : null}

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-100">权益曲线</div>
              <div className="mt-1 text-xs text-zinc-500">展示最近一次回测过程中账户权益随时间的变化。</div>
            </div>
            <Badge variant="default">{latestRun?.source || "暂无结果"}</Badge>
          </div>
          <div className="h-[260px]">
            {curve.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve}>
                  <defs>
                    <linearGradient id="backtestCurveFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} width={72} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#09090b", border: "1px solid #27272a", borderRadius: 12 }}
                    formatter={(value: number) => [formatMoney(value), "权益"]}
                  />
                  <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#backtestCurveFill)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">先运行一次回测，这里就会显示权益曲线。</div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3">
            <div className="text-sm font-medium text-zinc-100">交易明细</div>
            <div className="mt-1 text-xs text-zinc-500">展示最近一次回测中的每笔成交，包括方向、价格、数量和单笔盈亏。</div>
          </div>
          {tradeRows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>价格</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>手续费</TableHead>
                  <TableHead>盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tradeRows.map((trade, index) => (
                  <TableRow key={`${trade.time}-${trade.price}-${index}`}>
                    <TableCell>{formatDateTime(trade.time)}</TableCell>
                    <TableCell>{trade.side}</TableCell>
                    <TableCell>{formatMoney(trade.price)}</TableCell>
                    <TableCell>{trade.quantity.toFixed(6)}</TableCell>
                    <TableCell>{formatMoney(trade.fee || 0)}</TableCell>
                    <TableCell className={(trade.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>{formatMoney(trade.pnl || 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-sm text-zinc-500">当前还没有可展示的成交明细。</div>
          )}
        </div>

        <div className="space-y-2 text-sm text-zinc-400">
          <div className="text-sm font-medium text-zinc-100">历史回测记录</div>
          {runs.map((run) => (
            <div key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <span>{formatDateTime(run.completedAt)}</span>
                <span className={run.metrics.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}>{run.metrics.totalReturnPct.toFixed(2)}%</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                夏普 {run.metrics.sharpe.toFixed(2)} | 最大回撤 {run.metrics.maxDrawdownPct.toFixed(2)}% | 胜率 {(run.metrics.winRatePct || 0).toFixed(2)}% | 交易 {run.metrics.trades} 次
              </div>
            </div>
          ))}
          {runs.length === 0 ? <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-zinc-500">当前策略还没有回测记录。</div> : null}
        </div>
      </div>
    </Card>
  );
}
