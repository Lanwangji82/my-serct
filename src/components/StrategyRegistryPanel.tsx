import React from "react";
import { Badge, Card } from "./ui";
import { BrokerRegistrySummary, getRuntimeExecutionTarget, getRuntimeLabel } from "../lib/platform-client";

type Strategy = {
  id: string;
  name: string;
  description: string;
  marketType: "spot" | "futures";
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
  artifactSummary?: {
    version?: number;
    latestSourceFile?: string;
  } | null;
};

export function StrategyRegistryPanel(props: {
  strategies: Strategy[];
  brokers: BrokerRegistrySummary[];
  selectedStrategy: Strategy | null;
  onSelectStrategy: (strategyId: string, target: string) => void;
}) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">策略库</h2>
          <span className="text-xs text-zinc-500">已加载 {props.strategies.length} 个策略</span>
        </div>
        <div className="space-y-3">
          {props.strategies.map((strategy) => (
            <button
              key={strategy.id}
              onClick={() => props.onSelectStrategy(strategy.id, getRuntimeExecutionTarget(strategy.runtime, props.brokers))}
              className={`w-full rounded-xl border px-4 py-4 text-left transition-colors ${
                props.selectedStrategy?.id === strategy.id
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-zinc-100">{strategy.name}</div>
                  <div className="mt-1 line-clamp-2 text-sm text-zinc-500">{strategy.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={strategy.template === "python" ? "success" : "default"}>
                    {strategy.template === "python" ? "Python" : "模板"}
                  </Badge>
                  <Badge variant={strategy.runtime === "paper" ? "warning" : "default"}>
                    {getRuntimeLabel(strategy.runtime)}
                  </Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                <span>{strategy.symbol}</span>
                <span>{strategy.interval}</span>
                <span>{strategy.marketType === "futures" ? "合约" : "现货"}</span>
                {strategy.artifactSummary?.version ? <span>v{strategy.artifactSummary.version}</span> : null}
              </div>
              {strategy.artifactSummary?.latestSourceFile ? (
                <div className="mt-2 truncate text-xs text-zinc-500">策略文件：{strategy.artifactSummary.latestSourceFile}</div>
              ) : null}
            </button>
          ))}
          {props.strategies.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
              还没有策略。先在右侧新建一个 Python 策略并保存到平台。
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
