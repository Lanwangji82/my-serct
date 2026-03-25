import React from "react";
import { Badge, Card } from "./ui";

type Strategy = {
  id?: string;
};

type ConnectivityStatus = {
  proxy?: {
    configured: boolean;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string;
    mode?: string;
    source?: string;
  };
  brokers?: Array<{
    brokerTarget: string;
    ok: boolean;
    latencyMs?: number;
    error?: string;
  }>;
} | null;

export function ExecutionConsolePanel(props: {
  selectedStrategy: Strategy | null;
  connectivity: ConnectivityStatus;
}) {
  const brokerRows = props.connectivity?.brokers || [];
  const healthyTargets = brokerRows.filter((item) => item.ok);

  return (
    <div className="grid grid-cols-1 gap-6">
      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">部署前检查</h2>
            <Badge variant={healthyTargets.length > 0 ? "success" : "warning"}>
              {healthyTargets.length > 0 ? `可达目标 ${healthyTargets.length}/${brokerRows.length}` : "等待联通检查"}
            </Badge>
          </div>

          <p className="text-sm text-zinc-500">这里只保留部署前环境检查。重点确认代理是否正常、交易所公开接口是否可达。</p>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div>代理状态：{props.connectivity?.proxy?.configured ? "已配置" : "未配置"}</div>
            <div className="mt-2">代理模式：{props.connectivity?.proxy?.mode || "--"}</div>
            <div className="mt-2">代理来源：{props.connectivity?.proxy?.source || "--"}</div>
            <div className="mt-2 break-all">HTTP：{props.connectivity?.proxy?.httpProxy || "--"}</div>
            <div className="mt-2 break-all">HTTPS：{props.connectivity?.proxy?.httpsProxy || "--"}</div>
            <div className="mt-2 break-all">SOCKS：{props.connectivity?.proxy?.socksProxy || "--"}</div>
          </div>

          <div className="space-y-3">
            {brokerRows.map((item) => (
              <div key={item.brokerTarget} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-200">{item.brokerTarget}</span>
                  <Badge variant={item.ok ? "success" : "warning"}>
                    {item.ok ? `${item.latencyMs?.toFixed(2) || "--"} ms` : "不可达"}
                  </Badge>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  {item.ok ? "网络连通正常，可用于后续接入检查。" : item.error || "未返回错误详情。"}
                </div>
              </div>
            ))}
            {brokerRows.length === 0 ? <div className="text-sm text-zinc-500">还没有联通检测结果。</div> : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
