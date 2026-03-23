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

const TEXT = {
  title: "\u7b56\u7565\u5e93",
  loaded: "\u5df2\u52a0\u8f7d",
  strategyCount: "\u4e2a\u7b56\u7565",
  python: "\u0050\u0079\u0074\u0068\u006f\u006e",
  template: "\u6a21\u677f",
  futures: "\u5408\u7ea6",
  spot: "\u73b0\u8d27",
  file: "\u6587\u4ef6",
} as const;

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
          <h2 className="text-lg font-semibold text-zinc-100">{TEXT.title}</h2>
          <span className="text-xs text-zinc-500">
            {TEXT.loaded} {props.strategies.length} {TEXT.strategyCount}
          </span>
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
                <div>
                  <div className="font-medium text-zinc-100">{strategy.name}</div>
                  <div className="mt-1 text-sm text-zinc-500">{strategy.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={strategy.template === "python" ? "success" : "default"}>
                    {strategy.template === "python" ? TEXT.python : TEXT.template}
                  </Badge>
                  <Badge variant={strategy.runtime === "paper" ? "warning" : "default"}>
                    {getRuntimeLabel(strategy.runtime)}
                  </Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                <span>{strategy.symbol}</span>
                <span>{strategy.interval}</span>
                <span>{strategy.marketType === "futures" ? TEXT.futures : TEXT.spot}</span>
                {strategy.artifactSummary?.version && <span>v{strategy.artifactSummary.version}</span>}
              </div>
              {strategy.artifactSummary?.latestSourceFile && (
                <div className="mt-2 truncate text-xs text-zinc-500">
                  {TEXT.file}：{strategy.artifactSummary.latestSourceFile}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
