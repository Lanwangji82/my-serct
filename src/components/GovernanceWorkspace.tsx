import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "./ui";
import { authorizedFetch, BrokerRegistrySummary, formatDateTime, getBrokerTargetLabel, GOVERNANCE_API_BASE, PLATFORM_API_BASE } from "../lib/platform-client";

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
  const [credentialTarget, setCredentialTarget] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [status, setStatus] = useState("正在连接本地治理服务。");
  const [busy, setBusy] = useState(false);

  const credentialOptions = useMemo(() => brokers.flatMap((item) => item.targets), [brokers]);

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
        setCredentialTarget((current) => current || nextBrokers.flatMap((item) => item.targets).find((item) => item.mode === "sandbox")?.target || nextBrokers.flatMap((item) => item.targets)[0]?.target || "");
        setStatus("治理服务已连接。");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载治理服务失败");
      }
    })();
  }, []);

  const handleSaveCredential = async () => {
    if (!credentialTarget) return;
    setBusy(true);
    try {
      const nextCredentials = await authorizedFetch<CredentialSummary[]>(`${GOVERNANCE_API_BASE}/credentials`, "", {
        method: "POST",
        body: JSON.stringify({
          brokerTarget: credentialTarget,
          label: getBrokerTargetLabel(credentialTarget as string, brokers),
          apiKey,
          apiSecret,
        }),
      });
      setCredentials(nextCredentials);
      setApiKey("");
      setApiSecret("");
      setStatus(`已保存 ${getBrokerTargetLabel(credentialTarget, brokers)} 的凭证。`);
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
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">治理服务</h1>
          <p className="mt-1 text-sm text-zinc-500">凭证、审计轨迹与券商控制能力现在都由治理边界提供。</p>
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
                    {module.capabilities.map((capability) => <div key={capability}>{capability}</div>)}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="space-y-5 p-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">券商凭证</h2>
                  <p className="mt-1 text-sm text-zinc-500">将凭证保存到注册表发现的券商目标中。</p>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <select value={credentialTarget} onChange={(e) => setCredentialTarget(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white">
                    {credentialOptions.map((item) => (
                      <option key={item.target} value={item.target}>{item.label}</option>
                    ))}
                  </select>
                  <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white" placeholder="券商 API Key" />
                  <input value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} type="password" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white" placeholder="券商 API Secret" />
                  <Button onClick={handleSaveCredential} disabled={busy || !apiKey || !apiSecret || !credentialTarget}>保存到密钥库</Button>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="mb-2 text-sm font-medium text-zinc-100">已存凭证</div>
                  <div className="space-y-2 text-sm text-zinc-400">
                    {credentials.length === 0 ? <div>还没有保存任何凭证。</div> : credentials.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3">
                        <span>{item.label}</span>
                        <span>{item.brokerTarget}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/85">
              <div className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-100">审计轨迹</h2>
                  <Badge variant="warning">{auditEvents.length} 条事件</Badge>
                </div>
                <div className="space-y-3">
                  {auditEvents.slice(0, 10).map((event) => (
                    <div key={event.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-200">{event.type}</span>
                        <span className="text-xs text-zinc-500">{formatDateTime(event.createdAt)}</span>
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
