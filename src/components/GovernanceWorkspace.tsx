import React, { useEffect, useMemo, useState } from "react";
import { Badge, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import {
  authorizedFetch,
  formatDateTime,
  GOVERNANCE_API_BASE,
  PLATFORM_API_BASE,
} from "../lib/platform-client";

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

type RuntimeConfig = {
  proxy?: {
    configured: boolean;
    mode?: string;
    source?: string;
    activeProxy?: string;
  };
};

const moduleLabelMap: Record<string, string> = {
  Governance: "治理",
  Audit: "审计",
  Operations: "运维",
};

const capabilityMap: Record<string, string> = {
  compliance: "合规记录",
  audit: "审计追踪",
  approvals: "审批预留",
  configuration: "配置治理",
  observability: "运行观察",
};

function translateLabel(label: string) {
  return moduleLabelMap[label] || label;
}

function translateCapability(value: string) {
  return capabilityMap[value] || value;
}

function summarizeAudit(event: AuditEvent) {
  if (event.type === "strategy.saved") {
    return `策略已保存：${String(event.payload.strategyId || "--")}`;
  }
  if (event.type === "backtest.run") {
    return `回测完成：${String(event.payload.strategyId || "--")}`;
  }
  return JSON.stringify(event.payload);
}

export function GovernanceWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState("正在连接治理服务...");

  useEffect(() => {
    void (async () => {
      try {
        const [me, nextModules, nextAudit, nextRuntime] = await Promise.all([
          authorizedFetch<{ user: { email: string } }>(`${PLATFORM_API_BASE}/me`, ""),
          authorizedFetch<ModuleSummary[]>(`${GOVERNANCE_API_BASE}/modules`, ""),
          authorizedFetch<AuditEvent[]>(`${GOVERNANCE_API_BASE}/audit`, ""),
          authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/config`, "").catch(() => null),
        ]);
        setUser(me.user);
        setModules(nextModules);
        setAuditEvents(nextAudit);
        setRuntimeConfig(nextRuntime);
        setStatus("治理服务已连接");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载治理服务失败");
      }
    })();
  }, []);

  const eventTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of auditEvents) {
      counts.set(event.type, (counts.get(event.type) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
  }, [auditEvents]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">治理与审计</h1>
          <p className="mt-1 text-sm text-zinc-500">
            治理页现在只保留团队真正会用的两类信息：环境治理，以及策略保存和回测的操作留痕。
          </p>
        </div>
        {user ? <Badge variant="success">{user.email}</Badge> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">治理模块</div><div className="text-2xl font-semibold text-zinc-50">{modules.length}</div><div className="text-sm text-zinc-500">当前接入的平台治理能力</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">代理状态</div><div className="text-2xl font-semibold text-zinc-50">{runtimeConfig?.proxy?.configured ? "已配置" : "未配置"}</div><div className="text-sm text-zinc-500">由设置页统一维护网络环境信息</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">审计事件</div><div className="text-2xl font-semibold text-zinc-50">{auditEvents.length}</div><div className="text-sm text-zinc-500">用于回看保存和回测等关键操作</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">治理能力概览</h2>
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
              <div className="mt-2 break-all">当前出口：{runtimeConfig?.proxy?.activeProxy || "--"}</div>
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">审计台账</h2>
              <Badge variant="warning">最近 {auditEvents.length} 条</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {eventTypeCounts.map((item) => (
                <Badge key={item.type} variant="default">{item.type} × {item.count}</Badge>
              ))}
              {eventTypeCounts.length === 0 ? <span className="text-sm text-zinc-500">暂无事件分布。</span> : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>摘要</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditEvents.slice(0, 20).map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDateTime(event.createdAt)}</TableCell>
                    <TableCell>{event.type}</TableCell>
                    <TableCell className="text-zinc-400">{summarizeAudit(event)}</TableCell>
                  </TableRow>
                ))}
                {auditEvents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-zinc-500">暂无审计记录。</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
