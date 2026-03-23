import React, { useEffect, useMemo, useState } from "react";
import { Badge, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import { authorizedFetch, formatDateTime, formatMoney, PLATFORM_API_BASE, PORTFOLIO_API_BASE } from "../lib/platform-client";

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

type PaperAccount = {
  balanceUsd: number;
  realizedPnl: number;
  positions: Array<{
    symbol: string;
    quantity: number;
    avgEntryPrice: number;
    updatedAt: number;
  }>;
};

export function PortfolioWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [status, setStatus] = useState("正在连接组合服务...");

  const notionalEstimate = useMemo(
    () => (account?.positions || []).reduce((sum, position) => sum + Math.abs(position.quantity * position.avgEntryPrice), 0),
    [account],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [me, nextModules, nextAccount] = await Promise.all([
          authorizedFetch<{ user: { email: string } }>(`${PLATFORM_API_BASE}/me`, ""),
          authorizedFetch<ModuleSummary[]>(`${PORTFOLIO_API_BASE}/modules`, ""),
          authorizedFetch<PaperAccount>(`${PORTFOLIO_API_BASE}/account`, ""),
        ]);
        setUser(me.user);
        setModules(nextModules);
        setAccount(nextAccount);
        setStatus("组合服务已连接");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载组合服务失败");
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">组合与账户</h1>
          <p className="mt-1 text-sm text-zinc-500">
            这里展示当前纸面账户、持仓和组合暴露，方便团队确认策略执行后的资金与仓位状态。
          </p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">账户权益</div><div className="text-2xl font-semibold text-zinc-50">{formatMoney(account?.balanceUsd)}</div><div className="text-sm text-zinc-500">当前纸面账户余额</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">已实现盈亏</div><div className={`text-2xl font-semibold ${(account?.realizedPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{formatMoney(account?.realizedPnl)}</div><div className="text-sm text-zinc-500">已完成交易累计结果</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">持仓数量</div><div className="text-2xl font-semibold text-zinc-50">{account?.positions?.length || 0}</div><div className="text-sm text-zinc-500">当前仍在持有的仓位数</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">名义敞口</div><div className="text-2xl font-semibold text-zinc-50">{formatMoney(notionalEstimate)}</div><div className="text-sm text-zinc-500">按持仓数量和均价估算</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">组合模块</h2>
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
            <h2 className="text-lg font-semibold text-zinc-100">持仓明细</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标的</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>均价</TableHead>
                  <TableHead>名义金额</TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(account?.positions || []).map((position) => (
                  <TableRow key={`${position.symbol}:${position.updatedAt}`}>
                    <TableCell>{position.symbol}</TableCell>
                    <TableCell>{position.quantity.toFixed(6)}</TableCell>
                    <TableCell>{formatMoney(position.avgEntryPrice)}</TableCell>
                    <TableCell>{formatMoney(position.avgEntryPrice * position.quantity)}</TableCell>
                    <TableCell>{formatDateTime(position.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(!account?.positions || account.positions.length === 0) && (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
                当前没有持仓。策略执行成功后，这里会自动更新仓位。
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
