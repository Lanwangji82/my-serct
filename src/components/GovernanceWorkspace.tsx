import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui";
import {
  authorizedFetch,
  formatDateTime,
  getBrokerTargetLabel,
  GOVERNANCE_API_BASE,
  PLATFORM_API_BASE,
  type BrokerRegistrySummary,
} from "../lib/platform-client";

type ModuleSummary = {
  id: string;
  label: string;
  capabilities: string[];
};

type CredentialSummary = {
  id: string;
  label: string;
  brokerTarget: string;
  updatedAt: number;
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export function GovernanceWorkspace() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [brokers, setBrokers] = useState<BrokerRegistrySummary[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [credentialTarget, setCredentialTarget] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [status, setStatus] = useState("正在连接治理服务...");
  const [busy, setBusy] = useState(false);

  const credentialOptions = useMemo(() => brokers.flatMap((item) => item.targets), [brokers]);
  const needsPassphrase = credentialTarget.startsWith("okx:");

  useEffect(() => {
    void (async () => {
      try {
        const [me, nextModules, nextBrokers, nextCredentials, nextAudit] = await Promise.all([
          authorizedFetch<{ user: { email: string } }>(`${PLATFORM_API_BASE}/me`, ""),
          authorizedFetch<ModuleSummary[]>(`${GOVERNANCE_API_BASE}/modules`, ""),
          authorizedFetch<BrokerRegistrySummary[]>(`${GOVERNANCE_API_BASE}/brokers`, ""),
          authorizedFetch<CredentialSummary[]>(`${GOVERNANCE_API_BASE}/credentials`, ""),
          authorizedFetch<AuditEvent[]>(`${GOVERNANCE_API_BASE}/audit`, ""),
        ]);
        setUser(me.user);
        setModules(nextModules);
        setBrokers(nextBrokers);
        setCredentials(nextCredentials);
        setAuditEvents(nextAudit);
        setCredentialTarget(
          nextBrokers.flatMap((item) => item.targets).find((item) => item.mode === "sandbox")?.target
          || nextBrokers.flatMap((item) => item.targets)[0]?.target
          || "",
        );
        setStatus("治理服务已连接");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载治理服务失败");
      }
    })();
  }, []);

  const handleSaveCredential = async () => {
    if (!credentialTarget) {
      return;
    }
    setBusy(true);
    try {
      const nextCredentials = await authorizedFetch<CredentialSummary[]>(`${GOVERNANCE_API_BASE}/credentials`, "", {
        method: "POST",
        body: JSON.stringify({
          brokerTarget: credentialTarget,
          label: getBrokerTargetLabel(credentialTarget, brokers),
          apiKey,
          apiSecret,
          apiPassphrase: apiPassphrase,
        }),
      });
      setCredentials(nextCredentials);
      setApiKey("");
      setApiSecret("");
      setApiPassphrase("");
      setStatus(`已保存 ${getBrokerTargetLabel(credentialTarget, brokers)} 的凭证`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存凭证失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">治理与凭证</h1>
          <p className="mt-1 text-sm text-zinc-500">
            这里负责券商接入、密钥保存和审计日志。对于团队协作，这一页应该是风控和管理员最常检查的地方。
          </p>
        </div>
        {user && <Badge variant="success">{user.email}</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">治理模块</div><div className="text-2xl font-semibold text-zinc-50">{modules.length}</div><div className="text-sm text-zinc-500">平台已接入的治理能力</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">凭证数量</div><div className="text-2xl font-semibold text-zinc-50">{credentials.length}</div><div className="text-sm text-zinc-500">已存入密钥库的券商目标</div></div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85"><div className="space-y-2 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">审计事件</div><div className="text-2xl font-semibold text-zinc-50">{auditEvents.length}</div><div className="text-sm text-zinc-500">登录、回测、执行等行为都会入库</div></div></Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-5 p-6">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">保存券商凭证</h2>
              <p className="mt-1 text-sm text-zinc-500">优先把沙盒或模拟盘凭证接进来，确认联通和权限后再考虑生产环境。</p>
            </div>

            <div className="space-y-3">
              <select value={credentialTarget} onChange={(e) => setCredentialTarget(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white">
                {credentialOptions.map((item) => (
                  <option key={item.target} value={item.target}>{item.label}</option>
                ))}
              </select>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white" placeholder="券商 API Key" />
              <input value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} type="password" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white" placeholder="券商 API Secret" />
              {needsPassphrase ? (
                <input value={apiPassphrase} onChange={(e) => setApiPassphrase(e.target.value)} type="password" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white" placeholder="OKX API Passphrase" />
              ) : null}
              <Button onClick={handleSaveCredential} disabled={busy || !apiKey || !apiSecret || (needsPassphrase && !apiPassphrase)}>
                保存到密钥库
              </Button>
            </div>

            <div className="space-y-3">
              <div className="text-sm font-medium text-zinc-100">已存凭证</div>
              {credentials.map((item) => (
                <div key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-100">{item.label}</span>
                    <Badge variant="default">{item.brokerTarget}</Badge>
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">最近更新：{formatDateTime(item.updatedAt)}</div>
                </div>
              ))}
              {credentials.length === 0 ? <div className="text-sm text-zinc-500">还没有保存任何券商凭证。</div> : null}
            </div>
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-100">治理台账</h2>
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
                    <TableCell className="text-zinc-400">{JSON.stringify(event.payload)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">已接入券商目标</h2>
          <div className="flex flex-wrap gap-2">
            {brokers.flatMap((broker) => broker.targets).map((target) => (
              <Badge key={target.target} variant="default">{target.label}</Badge>
            ))}
          </div>
        </div>
      </Card>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
