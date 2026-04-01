import React, { useMemo } from "react";
import { Badge, Card } from "../common/ui";
import { formatDateTime } from "../../lib/platform-client";
import type { PortfolioPosition } from "../../hooks/usePortfolioPositions";

function pnlTone(value: number) {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-zinc-300";
}

function connectionModeLabel(value: "live" | "paper") {
  return value === "paper" ? "模拟盘" : "实盘";
}

function PositionGroup(props: { title: string; positions: PortfolioPosition[] }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-zinc-100">{props.title}</div>
        <Badge variant="outline">{props.positions.length} 笔</Badge>
      </div>

      {props.positions.map((position) => (
        <div key={position.positionId} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-zinc-100">{position.label}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {position.accountLabel} · {position.exchangeId || position.providerId} · {connectionModeLabel(position.connectionMode)}
              </div>
            </div>
            <div className="text-right">
              <div className={`text-sm font-medium ${pnlTone(position.unrealizedPnlPct)}`}>{position.unrealizedPnlPct.toFixed(2)}%</div>
              <div className="mt-1 text-xs text-zinc-500">市值 {position.marketValue.toFixed(2)}</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
              <div className="text-xs text-zinc-500">数量</div>
              <div className="mt-1 text-sm text-zinc-300">{position.quantity.toFixed(6)}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
              <div className="text-xs text-zinc-500">成本 / 现价</div>
              <div className="mt-1 text-sm text-zinc-300">{position.avgCost.toFixed(4)} / {position.lastPrice.toFixed(4)}</div>
            </div>
          </div>

          {position.reminders.length > 0 ? (
            <div className="mt-4 space-y-2">
              {position.reminders.map((reminder) => (
                <div key={`${position.positionId}-${reminder}`} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2 text-sm text-zinc-300">
                  {reminder}
                </div>
              ))}
            </div>
          ) : null}

          {position.latestEvents.length > 0 ? (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">最近事件</div>
              <div className="mt-2 space-y-2">
                {position.latestEvents.map((event) => (
                  <div key={`${position.positionId}-${event.eventId}`} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                    <div className="text-sm text-zinc-200">{event.title}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {event.sentimentLabel || "中性"} · {event.executionLabel || "观察"} · {formatDateTime(event.publishedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ))}

      {props.positions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-6 text-sm text-zinc-500">当前分区没有匹配到持仓记录。</div>
      ) : null}
    </div>
  );
}

export function PositionContextCard(props: { positions: PortfolioPosition[] }) {
  const livePositions = useMemo(() => props.positions.filter((item) => item.connectionMode === "live"), [props.positions]);
  const paperPositions = useMemo(() => props.positions.filter((item) => item.connectionMode === "paper"), [props.positions]);

  return (
    <Card className="border-zinc-800 bg-zinc-950/85 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">当前持仓联动</h2>
          <p className="mt-1 text-sm text-zinc-500">标的联动也按实盘和模拟盘分开展示，避免把测试仓位误当成真实仓位。</p>
        </div>
        <Badge variant="default">{props.positions.length} 笔</Badge>
      </div>

      <div className="mt-4 space-y-6">
        <PositionGroup title="实盘联动" positions={livePositions} />
        <PositionGroup title="模拟盘联动" positions={paperPositions} />
      </div>
    </Card>
  );
}
