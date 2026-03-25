import React from "react";
import { Badge, Card } from "./ui";

type Strategy = {
  id?: string;
  name?: string;
  runtime: string;
  symbol?: string;
  interval?: string;
  risk: {
    maxLeverage: number;
    allowedSymbols: string[];
  };
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

function getRuntimeLabel(runtime: string) {
  if (runtime === "paper") return "纸面";
  if (runtime === "sandbox") return "沙盒";
  if (runtime === "production") return "生产";
  if (runtime === "backtest-only") return "仅回测";
  return runtime;
}

export function ExecutionConsolePanel(props: {
  selectedStrategy: Strategy | null;
  auditEvents: AuditEvent[];
  connectivity: ConnectivityStatus;
}) {
  const strategy = props.selectedStrategy;
  const brokerRows = props.connectivity?.brokers || [];
  const healthyTargets = brokerRows.filter((item) => item.ok);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">策略运行概览</h2>
            <p className="mt-1 text-sm text-zinc-500">
              这里只保留策略当前运行画像和网络检查，不再维护单独的导出部署准备流程。
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div>当前策略：{strategy?.name || "未选择策略"}</div>
            <div className="mt-2">交易对：{strategy?.symbol || "--"}</div>
            <div className="mt-2">周期：{strategy?.interval || "--"}</div>
            <div className="mt-2">运行环境：{getRuntimeLabel(strategy?.runtime || "--")}</div>
            <div className="mt-2">允许标的：{strategy?.risk.allowedSymbols.join(", ") || "--"}</div>
            <div className="mt-2">最大杠杆：{strategy?.risk.maxLeverage || "--"}x</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
            <div className="mb-2 text-sm font-medium text-zinc-100">策略状态</div>
            <div>当前策略：{strategy?.name || "未选择策略"}</div>
            <div className="mt-2">源码已落盘到本地策略库，可直接用于回测和归档管理。</div>
            <div className="mt-2">如果需要清理策略，只需删除 `strategy_store` 下对应目录并刷新策略库。</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
            <div className="font-medium text-zinc-100">推荐工作步骤</div>
            <div className="mt-2">1. 在 QuantX 中导入或保存 Python 策略源码。</div>
            <div className="mt-2">2. 完成本地回测，确认参数、日志和成交明细。</div>
            <div className="mt-2">3. 根据网络检查结果决定后续部署动作。</div>
          </div>
        </div>
      </Card>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">部署前检查</h2>
            <Badge variant={healthyTargets.length > 0 ? "success" : "warning"}>
              {healthyTargets.length > 0 ? `可达目标 ${healthyTargets.length}/${brokerRows.length}` : "等待联通检查"}
            </Badge>
          </div>

          <p className="text-sm text-zinc-500">
            这里只保留部署前环境检查，不再承担本地下单职责。重点确认代理是否正常、交易所公开接口是否可达。
          </p>

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

          <div className="space-y-2 text-sm text-zinc-400">
            <div className="font-medium text-zinc-100">最近操作</div>
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
