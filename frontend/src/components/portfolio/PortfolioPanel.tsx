import React, { useMemo } from "react";
import { Badge, Button, Card } from "../common/ui";
import type { PortfolioPosition, PortfolioPayload } from "../../hooks/usePortfolioPositions";

function pnlTone(value: number) {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-zinc-300";
}

function connectionModeLabel(value: "live" | "paper") {
  return value === "paper" ? "模拟盘" : "实盘";
}

function assetTypeLabel(value: string) {
  if (value === "spot") return "现货";
  if (value === "futures") return "合约";
  if (value === "funding") return "资金钱包";
  if (value === "stock") return "股票";
  return value;
}

function buildSummary(positions: PortfolioPosition[]) {
  const marketValue = positions.reduce((sum, item) => sum + item.marketValue, 0);
  const unrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  return { marketValue, unrealizedPnl, positionCount: positions.length };
}

function PositionSection(props: { title: string; positions: PortfolioPosition[] }) {
  const summary = useMemo(() => buildSummary(props.positions), [props.positions]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-zinc-100">{props.title}</div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">市值 {summary.marketValue.toFixed(2)}</Badge>
          <Badge variant="outline" className={pnlTone(summary.unrealizedPnl)}>
            浮盈亏 {summary.unrealizedPnl.toFixed(2)}
          </Badge>
          <Badge variant="outline">仓位 {summary.positionCount}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {props.positions.slice(0, 6).map((position) => (
          <div key={position.positionId} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-zinc-100">{position.label}</div>
                <div className="mt-1 text-xs text-zinc-500">{position.symbol}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{position.accountLabel}</Badge>
                <Badge variant="outline">{connectionModeLabel(position.connectionMode)}</Badge>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">成本</div>
                <div className="mt-1 text-sm text-zinc-200">{position.avgCost.toFixed(4)}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">现价</div>
                <div className="mt-1 text-sm text-zinc-200">{position.lastPrice.toFixed(4)}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">市值</div>
                <div className="mt-1 text-sm text-zinc-200">{position.marketValue.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">盈亏</div>
                <div className={`mt-1 text-sm ${pnlTone(position.unrealizedPnlPct)}`}>{position.unrealizedPnlPct.toFixed(2)}%</div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="outline">{position.exchangeId || position.providerId}</Badge>
              <Badge variant="outline">{assetTypeLabel(position.assetType)}</Badge>
            </div>
          </div>
        ))}
        {props.positions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-6 text-sm text-zinc-500">当前分区没有持仓。</div>
        ) : null}
      </div>
    </div>
  );
}

export function PortfolioPanel(props: {
  summary?: PortfolioPayload["totals"] | null;
  positions: PortfolioPosition[];
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const livePositions = useMemo(() => props.positions.filter((item) => item.connectionMode === "live"), [props.positions]);
  const paperPositions = useMemo(() => props.positions.filter((item) => item.connectionMode === "paper"), [props.positions]);

  return (
    <Card className="border-zinc-800 bg-zinc-950/85 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">当前持仓</h2>
          <p className="mt-1 text-sm text-zinc-500">首页概览也把实盘和模拟盘拆开显示，避免误读总仓位。</p>
        </div>
        {props.onRefresh ? (
          <Button variant="outline" onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? "刷新中..." : "刷新持仓"}
          </Button>
        ) : null}
      </div>

      {props.summary ? (
        <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
            <div className="text-xs text-zinc-500">总仓位数</div>
            <div className="mt-1 text-sm text-zinc-100">{props.summary.positionCount}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
            <div className="text-xs text-zinc-500">总账户数</div>
            <div className="mt-1 text-sm text-zinc-100">{props.summary.accountCount}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
            <div className="text-xs text-zinc-500">实盘仓位数</div>
            <div className="mt-1 text-sm text-zinc-100">{livePositions.length}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
            <div className="text-xs text-zinc-500">模拟盘仓位数</div>
            <div className="mt-1 text-sm text-zinc-100">{paperPositions.length}</div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-6">
        <PositionSection title="实盘持仓" positions={livePositions} />
        <PositionSection title="模拟盘持仓" positions={paperPositions} />
      </div>

      {props.error ? <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-amber-400">{props.error}</div> : null}
    </Card>
  );
}
