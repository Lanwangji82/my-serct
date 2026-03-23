import React, { useEffect, useState } from "react";
import { Badge, Card } from "./ui";
import { authorizedFetch, PLATFORM_API_BASE, PORTFOLIO_API_BASE } from "../lib/platform-client";

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
  const [status, setStatus] = useState("正在连接本地组合服务。");

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
        setStatus("组合服务已连接。");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载组合服务失败");
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">组合服务</h1>
          <p className="mt-1 text-sm text-zinc-500">组合权益、盈亏与持仓视图现在都由独立组合服务提供。</p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="border-zinc-800 bg-zinc-950/85"><div className="p-6"><div className="text-sm text-zinc-500">组合权益</div><div className="mt-2 text-3xl font-semibold text-white">${account?.balanceUsd?.toFixed(2) || "0.00"}</div></div></Card>
            <Card className="border-zinc-800 bg-zinc-950/85"><div className="p-6"><div className="text-sm text-zinc-500">已实现盈亏</div><div className="mt-2 text-3xl font-semibold text-white">${account?.realizedPnl?.toFixed(2) || "0.00"}</div></div></Card>
            <Card className="border-zinc-800 bg-zinc-950/85"><div className="p-6"><div className="text-sm text-zinc-500">持仓数量</div><div className="mt-2 text-3xl font-semibold text-white">{account?.positions?.length || 0}</div></div></Card>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-zinc-100">组合模块</h2>
                <div className="mt-4 space-y-3">
                  {modules.map((module) => (
                    <div key={module.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="font-medium text-zinc-100">{module.label}</div>
                      <div className="mt-2 space-y-2 text-sm text-zinc-500">
                        {module.capabilities.map((capability) => <div key={capability}>{capability}</div>)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-zinc-100">持仓簿</h2>
                <div className="mt-4 space-y-3">
                  {(account?.positions || []).map((position) => (
                    <div key={`${position.symbol}:${position.updatedAt}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-zinc-100">{position.symbol}</span>
                        <Badge variant="default">{position.quantity.toFixed(4)}</Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-500">平均开仓价 ${position.avgEntryPrice.toFixed(2)}</div>
                    </div>
                  ))}
                  {(!account?.positions || account.positions.length === 0) && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">组合服务中暂时没有持仓。</div>
                  )}
                </div>
              </div>
            </Card>
          </div>
      </>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
