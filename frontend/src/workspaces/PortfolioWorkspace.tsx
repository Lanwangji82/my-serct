import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/common/ui";
import { usePortfolioPositions, type PortfolioPayload, type PortfolioPosition } from "../hooks/usePortfolioPositions";

function pnlTone(value: number) {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-zinc-300";
}

function connectionModeLabel(value: "live" | "paper") {
  return value === "paper" ? "模拟盘" : "实盘";
}

function marketLabel(value: "crypto" | "a_share") {
  return value === "a_share" ? "A股" : "加密";
}

function assetTypeLabel(value: string) {
  if (value === "spot") return "现货";
  if (value === "futures") return "合约";
  if (value === "funding") return "资金钱包";
  if (value === "stock") return "股票";
  return value;
}

function buildModeSummary(positions: PortfolioPosition[]) {
  const marketValue = positions.reduce((sum, item) => sum + item.marketValue, 0);
  const unrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  const totalCost = positions.reduce((sum, item) => sum + item.avgCost * item.quantity, 0);
  return {
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct: totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0,
    positionCount: positions.length,
    accountCount: new Set(positions.map((item) => item.accountId)).size,
  };
}

function PositionTable(props: {
  title: string;
  description: string;
  positions: PortfolioPosition[];
  selectedPositionId: string;
  onSelect: (positionId: string) => void;
}) {
  const summary = useMemo(() => buildModeSummary(props.positions), [props.positions]);

  return (
    <Card className="border-zinc-800 bg-zinc-950/85 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{props.title}</h2>
          <p className="mt-1 text-sm text-zinc-500">{props.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">市值 {summary.marketValue.toFixed(2)}</Badge>
          <Badge variant="outline">仓位 {summary.positionCount}</Badge>
          <Badge variant="outline">账户 {summary.accountCount}</Badge>
        </div>
      </div>

      <div className="mt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标的</TableHead>
              <TableHead>账户</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>数量</TableHead>
              <TableHead>成本</TableHead>
              <TableHead>市值</TableHead>
              <TableHead>盈亏</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.positions.map((position) => (
              <TableRow
                key={position.positionId}
                className={props.selectedPositionId === position.positionId ? "bg-zinc-800/50" : undefined}
                onClick={() => props.onSelect(position.positionId)}
              >
                <TableCell>
                  <div className="font-medium text-zinc-100">{position.label}</div>
                  <div className="mt-1 text-xs text-zinc-500">{position.symbol}</div>
                </TableCell>
                <TableCell>{position.accountLabel}</TableCell>
                <TableCell>{position.exchangeId || position.providerId}</TableCell>
                <TableCell>{assetTypeLabel(position.assetType)}</TableCell>
                <TableCell>{position.quantity.toFixed(6)}</TableCell>
                <TableCell>{position.avgCost.toFixed(4)}</TableCell>
                <TableCell>{position.marketValue.toFixed(2)}</TableCell>
                <TableCell className={pnlTone(position.unrealizedPnlPct)}>{position.unrealizedPnlPct.toFixed(2)}%</TableCell>
              </TableRow>
            ))}
            {props.positions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-zinc-500">
                  当前分区没有持仓。
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function PositionDetail(props: { position: PortfolioPosition | null }) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/85 p-6">
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">持仓详情</h2>
          <p className="mt-1 text-sm text-zinc-500">详情只跟随当前选中的分区，不把实盘和模拟盘混在一起。</p>
        </div>

        {props.position ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="default">{marketLabel(props.position.market)}</Badge>
              <Badge variant="outline">{props.position.accountLabel}</Badge>
              <Badge variant="outline">{props.position.exchangeId || props.position.providerId}</Badge>
              <Badge variant="outline">{connectionModeLabel(props.position.connectionMode)}</Badge>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
              <div className="font-medium text-zinc-100">{props.position.label}</div>
              <div className="mt-1 text-xs text-zinc-500">{props.position.symbol}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">数量</div>
                <div className="mt-1 text-sm text-zinc-100">{props.position.quantity.toFixed(6)}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">可用 / 冻结</div>
                <div className="mt-1 text-sm text-zinc-100">
                  {(props.position.availableQuantity || 0).toFixed(6)} / {(props.position.frozenQuantity || 0).toFixed(6)}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">成本 / 现价</div>
                <div className="mt-1 text-sm text-zinc-100">
                  {props.position.avgCost.toFixed(4)} / {props.position.lastPrice.toFixed(4)}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                <div className="text-xs text-zinc-500">市值 / 盈亏</div>
                <div className={`mt-1 text-sm ${pnlTone(props.position.unrealizedPnlPct)}`}>
                  {props.position.marketValue.toFixed(2)} / {props.position.unrealizedPnlPct.toFixed(2)}%
                </div>
              </div>
            </div>

            {props.position.reminders.length > 0 ? (
              <div className="space-y-2">
                {props.position.reminders.map((reminder) => (
                  <div key={reminder} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2 text-sm text-zinc-300">
                    {reminder}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-8 text-sm text-zinc-500">
            从左侧分区里选一笔持仓查看详情。
          </div>
        )}
      </div>
    </Card>
  );
}

export function PortfolioWorkspace() {
  const [marketFilter, setMarketFilter] = useState<"all" | "crypto" | "a_share">("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [connectionModeFilter, setConnectionModeFilter] = useState<"all" | "live" | "paper">("all");
  const [selectedPositionId, setSelectedPositionId] = useState("");

  const portfolio = usePortfolioPositions({
    market: marketFilter === "all" ? undefined : marketFilter,
    accountId: accountFilter === "all" ? undefined : accountFilter,
    connectionMode: connectionModeFilter === "all" ? undefined : connectionModeFilter,
  });

  const positions = portfolio.data?.positions || [];
  const livePositions = useMemo(() => positions.filter((item) => item.connectionMode === "live"), [positions]);
  const paperPositions = useMemo(() => positions.filter((item) => item.connectionMode === "paper"), [positions]);

  useEffect(() => {
    const stillExists = positions.some((item) => item.positionId === selectedPositionId);
    if (stillExists) return;
    setSelectedPositionId(livePositions[0]?.positionId || paperPositions[0]?.positionId || "");
  }, [positions, selectedPositionId, livePositions, paperPositions]);

  const selectedPosition = useMemo(
    () => positions.find((item) => item.positionId === selectedPositionId) || null,
    [positions, selectedPositionId],
  );

  const accountOptions = portfolio.data?.byAccount || [];
  const modeSummary = useMemo(
    () => ({
      live: buildModeSummary(livePositions),
      paper: buildModeSummary(paperPositions),
    }),
    [livePositions, paperPositions],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">持仓中心</h1>
          <p className="mt-1 text-sm text-zinc-500">实盘和模拟盘分开展示，默认优先以实盘仓位作为主视图。</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void portfolio.reload({ market: marketFilter, accountId: accountFilter, connectionMode: connectionModeFilter })}
          disabled={portfolio.loading}
        >
          {portfolio.loading ? "刷新中..." : "刷新持仓"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85 p-5">
          <div className="text-xs text-zinc-500">实盘市值</div>
          <div className="mt-2 text-2xl font-semibold text-zinc-50">{modeSummary.live.marketValue.toFixed(2)}</div>
        </Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5">
          <div className="text-xs text-zinc-500">模拟盘市值</div>
          <div className="mt-2 text-2xl font-semibold text-zinc-50">{modeSummary.paper.marketValue.toFixed(2)}</div>
        </Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5">
          <div className="text-xs text-zinc-500">实盘仓位数</div>
          <div className="mt-2 text-2xl font-semibold text-zinc-50">{modeSummary.live.positionCount}</div>
        </Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5">
          <div className="text-xs text-zinc-500">模拟盘仓位数</div>
          <div className="mt-2 text-2xl font-semibold text-zinc-50">{modeSummary.paper.positionCount}</div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={marketFilter}
            onChange={(event) => {
              setMarketFilter(event.target.value as "all" | "crypto" | "a_share");
              setAccountFilter("all");
            }}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
          >
            <option value="all">全部市场</option>
            <option value="crypto">加密</option>
            <option value="a_share">A股</option>
          </select>
          <select
            value={connectionModeFilter}
            onChange={(event) => setConnectionModeFilter(event.target.value as "all" | "live" | "paper")}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
          >
            <option value="all">全部环境</option>
            <option value="live">只看实盘</option>
            <option value="paper">只看模拟盘</option>
          </select>
          <select
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
          >
            <option value="all">全部账户</option>
            {accountOptions.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.accountLabel}
              </option>
            ))}
          </select>
          {(portfolio.data?.byMarket || []).map((item) => (
            <Badge key={item.market} variant="outline">
              {marketLabel(item.market)} {item.positionCount} 笔
            </Badge>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          {(connectionModeFilter === "all" || connectionModeFilter === "live") ? (
            <PositionTable
              title="实盘持仓"
              description="这里只展示真实账户仓位。"
              positions={livePositions}
              selectedPositionId={selectedPositionId}
              onSelect={setSelectedPositionId}
            />
          ) : null}
          {(connectionModeFilter === "all" || connectionModeFilter === "paper") ? (
            <PositionTable
              title="模拟盘持仓"
              description="这里单独展示纸面仓位，不和实盘汇总卡片混放。"
              positions={paperPositions}
              selectedPositionId={selectedPositionId}
              onSelect={setSelectedPositionId}
            />
          ) : null}
        </div>

        <PositionDetail position={selectedPosition} />
      </div>

      {portfolio.error ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-amber-400">{portfolio.error}</div> : null}
    </div>
  );
}
