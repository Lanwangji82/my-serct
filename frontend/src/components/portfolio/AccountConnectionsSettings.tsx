import React, { useMemo, useState } from "react";
import { Badge, Button, Card } from "../common/ui";
import { formatDateTime } from "../../lib/platform-client";
import { useAccountConnections, type AccountScope } from "../../hooks/useAccountConnections";

const initialForm = {
  label: "",
  market: "crypto" as "crypto" | "a_share",
  providerId: "binance",
  exchangeId: "binance",
  enabled: true,
  apiKey: "",
  apiSecret: "",
  passphrase: "",
  scopes: {
    spotLive: true,
    spotPaper: false,
    futuresLive: false,
    futuresPaper: false,
  },
};

function scopeLabel(scope: Pick<AccountScope, "accountType" | "connectionMode">) {
  const left = scope.accountType === "futures" ? "合约" : scope.accountType === "stock" ? "股票" : "现货";
  const right = scope.connectionMode === "paper" ? "模拟盘" : "实盘";
  return `${left} / ${right}`;
}

function getStatusMeta(status?: { ok: boolean; code?: string; message: string; checkedAt: number }) {
  if (!status?.code) return null;
  const mapping: Record<string, { label: string; variant: "success" | "warning" | "danger" | "outline" | "default" }> = {
    connected: { label: "已连通", variant: "success" },
    paper_ready: { label: "模拟盘可用", variant: "success" },
    invalid_key: { label: "Key 无效", variant: "danger" },
    permission_denied: { label: "权限不足", variant: "warning" },
    network_timeout: { label: "网络超时", variant: "warning" },
    network_error: { label: "网络异常", variant: "warning" },
    proxy_error: { label: "代理异常", variant: "warning" },
    provider_unavailable: { label: "暂未支持", variant: "outline" },
    unknown_error: { label: "待排查", variant: "outline" },
  };
  return mapping[status.code] || { label: status.code, variant: "outline" };
}

export function AccountConnectionsSettings() {
  const accounts = useAccountConnections();
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false);
  const [testingAccountId, setTestingAccountId] = useState("");
  const [deletingAccountId, setDeletingAccountId] = useState("");
  const [message, setMessage] = useState("");

  const providerOptions = useMemo(() => {
    if (form.market === "a_share") {
      return [{ value: "manual", label: "A股占位账户" }];
    }
    return [
      { value: "binance", label: "Binance" },
      { value: "okx", label: "OKX" },
    ];
  }, [form.market]);

  const buildScopes = () => {
    if (form.market === "a_share") {
      return [{ accountType: "stock", connectionMode: "live" as const, enabled: true }];
    }
    const scopes = [];
    if (form.scopes.spotLive) scopes.push({ accountType: "spot", connectionMode: "live" as const, enabled: true });
    if (form.scopes.spotPaper) scopes.push({ accountType: "spot", connectionMode: "paper" as const, enabled: true });
    if (form.scopes.futuresLive) scopes.push({ accountType: "futures", connectionMode: "live" as const, enabled: true });
    if (form.scopes.futuresPaper) scopes.push({ accountType: "futures", connectionMode: "paper" as const, enabled: true });
    return scopes;
  };

  const handleSave = async () => {
    setBusy(true);
    setMessage("");
    try {
      const providerLabel = providerOptions.find((item) => item.value === form.providerId)?.label || form.providerId;
      const scopes = buildScopes();
      await accounts.save({
        label: form.label || `${providerLabel} 账户`,
        market: form.market,
        providerId: form.providerId,
        exchangeId: form.exchangeId || form.providerId,
        enabled: form.enabled,
        credentials: {
          apiKey: form.apiKey,
          apiSecret: form.apiSecret,
          passphrase: form.passphrase,
        },
        scopes,
      });
      setForm(initialForm);
      setMessage("账户已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存账户失败");
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (accountId: string) => {
    setTestingAccountId(accountId);
    setMessage("正在测试账户下所有已启用 scopes，请稍候...");
    try {
      const result = await accounts.testConnection(accountId);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试连接失败");
    } finally {
      setTestingAccountId("");
    }
  };

  const handleDelete = async (accountId: string, label: string) => {
    setDeletingAccountId(accountId);
    setMessage("");
    try {
      await accounts.remove(accountId);
      setMessage(`已删除账户：${label}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除账户失败");
    } finally {
      setDeletingAccountId("");
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">账户连接管理</h2>
            <p className="mt-1 text-sm text-zinc-500">账户是统一主体，现货 / 合约 / 实盘 / 模拟盘都作为账户内的 scope 管理。</p>
          </div>
          <Button variant="outline" onClick={() => void accounts.reload()} disabled={accounts.loading || busy}>
            {accounts.loading ? "刷新中..." : "刷新账户"}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-3 text-sm font-medium text-zinc-100">添加只读账户</div>
            <div className="space-y-3">
              <input
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                placeholder="账户名称，例如 Binance 主账户"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={form.market}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      market: event.target.value as "crypto" | "a_share",
                      providerId: event.target.value === "a_share" ? "manual" : "binance",
                      exchangeId: event.target.value === "a_share" ? "manual" : "binance",
                    }))
                  }
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                >
                  <option value="crypto">加密</option>
                  <option value="a_share">A股</option>
                </select>
                <select
                  value={form.providerId}
                  onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value, exchangeId: event.target.value }))}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                >
                  {providerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {form.market === "crypto" ? (
                <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-300">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={form.scopes.spotLive} onChange={(event) => setForm((current) => ({ ...current, scopes: { ...current.scopes, spotLive: event.target.checked } }))} />现货 / 实盘</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={form.scopes.spotPaper} onChange={(event) => setForm((current) => ({ ...current, scopes: { ...current.scopes, spotPaper: event.target.checked } }))} />现货 / 模拟盘</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={form.scopes.futuresLive} onChange={(event) => setForm((current) => ({ ...current, scopes: { ...current.scopes, futuresLive: event.target.checked } }))} />合约 / 实盘</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={form.scopes.futuresPaper} onChange={(event) => setForm((current) => ({ ...current, scopes: { ...current.scopes, futuresPaper: event.target.checked } }))} />合约 / 模拟盘</label>
                </div>
              ) : (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-400">A股暂按统一股票 scope 处理。</div>
              )}

              <input
                value={form.apiKey}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                placeholder="API Key"
              />
              <input
                value={form.apiSecret}
                onChange={(event) => setForm((current) => ({ ...current, apiSecret: event.target.value }))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                placeholder="API Secret"
              />
              {form.providerId === "okx" ? (
                <input
                  value={form.passphrase}
                  onChange={(event) => setForm((current) => ({ ...current, passphrase: event.target.value }))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                  placeholder="Passphrase"
                />
              ) : null}
              <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-300">
                <span>启用该账户</span>
                <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
              </label>
              <Button onClick={() => void handleSave()} disabled={busy}>
                {busy ? "保存中..." : "保存账户"}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-3 text-sm font-medium text-zinc-100">已连接账户</div>
            <div className="space-y-3">
              {(accounts.data?.connections || []).map((account) => {
                const statusMeta = getStatusMeta(account.status);
                return (
                  <div key={account.accountId} className="rounded-xl border border-zinc-800 bg-zinc-950/55 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium text-zinc-100">{account.label}</div>
                        <div className="mt-1 text-xs text-zinc-500">{account.market} / {account.exchangeId || account.providerId}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={account.enabled ? "success" : "outline"}>{account.enabled ? "已启用" : "已停用"}</Badge>
                        {statusMeta ? <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge> : null}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {account.scopes.map((scope) => (
                        <Badge key={scope.scopeId} variant={scope.enabled ? "outline" : "default"}>
                          {scopeLabel(scope)}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div className="text-sm text-zinc-400">Key: {account.apiKeyMasked || "--"}</div>
                      <div className="text-sm text-zinc-400">Secret: {account.apiSecretMasked || "--"}</div>
                    </div>
                    <div className="mt-3 text-sm text-zinc-500">
                      {account.status?.message || "尚未测试连接"} {account.status?.checkedAt ? ` / ${formatDateTime(account.status.checkedAt)}` : ""}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => void handleTest(account.accountId)} disabled={testingAccountId === account.accountId}>
                        {testingAccountId === account.accountId ? "测试中..." : "测试账户"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void accounts.toggleEnabled(account.accountId, !account.enabled)}>
                        {account.enabled ? "停用账户" : "启用账户"}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => void handleDelete(account.accountId, account.label)} disabled={deletingAccountId === account.accountId}>
                        {deletingAccountId === account.accountId ? "删除中..." : "删除账户"}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!accounts.loading && (accounts.data?.connections || []).length === 0 ? <div className="text-sm text-zinc-500">当前还没有账户。</div> : null}
            </div>
          </div>
        </div>

        {message ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-400">{message}</div> : null}
        {accounts.error ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-amber-400">{accounts.error}</div> : null}
      </div>
    </Card>
  );
}
