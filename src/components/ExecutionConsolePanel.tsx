import React from "react";
import { Badge, Button, Card } from "./ui";
import { BrokerTarget, getBrokerTargetLabel, getRuntimeLabel } from "../lib/platform-client";

type Strategy = {
  risk: {
    maxLeverage: number;
    allowedSymbols: string[];
  };
  runtime: string;
};

type CredentialSummary = {
  id: string;
  label: string;
  brokerTarget: string;
};

type BrokerRegistrySummary = {
  brokerId: string;
  label: string;
  supportsMarketData: boolean;
  supportsExecution: boolean;
  targets: Array<{
    target: `${string}:${"sandbox" | "production"}`;
    mode: "sandbox" | "production";
    label: string;
  }>;
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
};

type ConnectivityStatus = {
  proxy?: {
    configured: boolean;
    httpProxy?: string;
    socksProxy?: string;
  };
  brokers?: Array<{
    brokerTarget: string;
    ok: boolean;
    error?: string;
  }>;
} | null;

export function ExecutionConsolePanel(props: {
  brokers: BrokerRegistrySummary[];
  brokerTarget: BrokerTarget;
  credentialTarget: string;
  credentials: CredentialSummary[];
  selectedStrategy: Strategy | null;
  paperAccount: any;
  auditEvents: AuditEvent[];
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  connectivity: ConnectivityStatus;
  busy: boolean;
  onBrokerTargetChange: (value: BrokerTarget) => void;
  onCredentialTargetChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onApiSecretChange: (value: string) => void;
  onApiPassphraseChange: (value: string) => void;
  onSaveCredential: () => void;
  onExecute: (side: "BUY" | "SELL") => void;
}) {
  const brokerOptions = props.brokers.flatMap((item) => item.targets);
  const selectedConnectivity = props.connectivity?.brokers?.find((item) => item.brokerTarget === props.brokerTarget);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">执行凭证</h2>
            <p className="mt-1 text-sm text-zinc-500">
              在这里维护券商或交易所的 API 凭证，供沙盒和生产执行使用。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <select
              value={props.credentialTarget}
              onChange={(e) => props.onCredentialTargetChange(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
            >
              {brokerOptions.map((option) => (
                <option key={option.target} value={option.target}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              value={props.apiKey}
              onChange={(e) => props.onApiKeyChange(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              placeholder="券商 API Key"
            />
            <input
              value={props.apiSecret}
              onChange={(e) => props.onApiSecretChange(e.target.value)}
              type="password"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              placeholder="券商 API Secret"
            />
            <input
              value={props.apiPassphrase}
              onChange={(e) => props.onApiPassphraseChange(e.target.value)}
              type="password"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              placeholder="券商 API Passphrase（OKX 必填）"
            />
            <Button
              onClick={props.onSaveCredential}
              disabled={props.busy || !props.apiKey || !props.apiSecret || !props.credentialTarget}
            >
              保存凭证
            </Button>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 text-sm font-medium text-zinc-100">已保存凭证</div>
            <div className="space-y-2 text-sm text-zinc-400">
              {props.credentials.length === 0 ? (
                <div>还没有保存任何凭证。</div>
              ) : (
                props.credentials.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3">
                    <span>{item.label}</span>
                    <span>{getBrokerTargetLabel(item.brokerTarget, props.brokers)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">运行控制台</h2>
            <select
              value={props.brokerTarget}
              onChange={(e) => props.onBrokerTargetChange(e.target.value as BrokerTarget)}
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
            >
              <option value="paper">纸面账户</option>
              {brokerOptions.map((option) => (
                <option key={option.target} value={option.target}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-sm text-zinc-500">订单发送前会先经过基础风控检查。</p>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div>代理状态：{props.connectivity?.proxy?.configured ? "已配置" : "未配置"}</div>
            <div className="mt-2">HTTP 代理：{props.connectivity?.proxy?.httpProxy || "--"}</div>
            <div className="mt-2">SOCKS 代理：{props.connectivity?.proxy?.socksProxy || "--"}</div>
            <div className="mt-2">
              当前目标联通性：{selectedConnectivity ? (selectedConnectivity.ok ? "正常" : "失败") : "未检测"}
            </div>
            {!selectedConnectivity?.ok && selectedConnectivity?.error && (
              <div className="mt-2 text-rose-400">{selectedConnectivity.error}</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button onClick={() => props.onExecute("BUY")} disabled={props.busy || !props.selectedStrategy}>
              发送买入
            </Button>
            <Button
              variant="outline"
              onClick={() => props.onExecute("SELL")}
              disabled={props.busy || !props.selectedStrategy}
            >
              发送卖出
            </Button>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div>允许标的：{props.selectedStrategy?.risk.allowedSymbols.join(", ") || "--"}</div>
            <div className="mt-2">最大杠杆：{props.selectedStrategy?.risk.maxLeverage || "--"}x</div>
            <div className="mt-2">运行环境：{getRuntimeLabel(props.selectedStrategy?.runtime || "--")}</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div>纸面余额：${props.paperAccount?.balanceUsd?.toFixed?.(2) || "100000.00"}</div>
            <div className="mt-2">已实现盈亏：${props.paperAccount?.realizedPnl?.toFixed?.(2) || "0.00"}</div>
            <div className="mt-2">持仓数：{props.paperAccount?.positions?.length || 0}</div>
          </div>

          <div className="space-y-2 text-sm text-zinc-400">
            {props.auditEvents.slice(0, 5).map((event) => (
              <div key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-200">{event.type}</span>
                  <Badge variant="default">{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
