import React, { useEffect, useState } from "react";
import { Badge, Button, Card } from "./ui";

export type StrategyArtifactSummary = {
  rootDir: string;
  sourceFile: string;
  latestSourceFile: string;
  metadataFile: string;
  latestMetadataFile: string;
  version: number;
};

export type PythonStrategy = {
  id?: string;
  name: string;
  description: string;
  marketType: "spot" | "futures";
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
  parameters: Record<string, number>;
  risk: {
    maxNotional: number;
    maxLeverage: number;
    maxDailyLoss: number;
    allowedSymbols: string[];
  };
  sourceCode?: string | null;
  compiler?: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    checkedAt?: number;
  } | null;
  artifactSummary?: StrategyArtifactSummary | null;
};

type CompilerResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checkedAt?: number;
};

const DEFAULT_SOURCE_CODE = `import polars as pl


def generate_signals(frame: pl.DataFrame, params: dict) -> dict:
    fast_period = int(params.get("fastPeriod", 10))
    slow_period = int(params.get("slowPeriod", 30))

    if frame.height == 0:
        return {"entries": [], "exits": []}

    close = frame["close"]
    fast = close.rolling_mean(fast_period)
    slow = close.rolling_mean(slow_period)

    entries = []
    exits = []
    previous_fast = None
    previous_slow = None

    for current_fast, current_slow in zip(fast.to_list(), slow.to_list()):
        can_compare = None not in (previous_fast, previous_slow, current_fast, current_slow)
        entries.append(bool(can_compare and current_fast > current_slow and previous_fast <= previous_slow))
        exits.append(bool(can_compare and current_fast < current_slow and previous_fast >= previous_slow))
        previous_fast = current_fast
        previous_slow = current_slow

    return {"entries": entries, "exits": exits}
`;

const FIELD_TEXT = {
  title: "\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u7b56\u7565\u7f16\u8f91\u5668",
  subtitle: "\u5728\u8fd9\u91cc\u5199\u7b56\u7565\u4ee3\u7801\uff0c\u5148\u505a\u7f16\u8bd1\u68c0\u67e5\uff0c\u518d\u4fdd\u5b58\u5230\u5e73\u53f0\u5e76\u8fdb\u5165\u56de\u6d4b\u3002",
  newStrategy: "\u65b0\u5efa\u0020\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u7b56\u7565",
  defaultName: "\u65b0\u5efa\u0050\u0079\u0074\u0068\u006f\u006e\u7b56\u7565",
  defaultDescription: "\u5728\u5e73\u53f0\u91cc\u7f16\u5199\u3001\u7f16\u8bd1\u3001\u4fdd\u5b58\u5e76\u56de\u6d4b\u0020\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u91cf\u5316\u7b56\u7565\u3002",
  strategySaved: "\u7b56\u7565\u6587\u4ef6\u5df2\u843d\u76d8",
  version: "\u7248\u672c\u53f7",
  rootDir: "\u7b56\u7565\u76ee\u5f55",
  sourceFile: "\u6e90\u7801\u6587\u4ef6",
  metadataFile: "\u5143\u6570\u636e\u6587\u4ef6",
  compilePassed: "\u7f16\u8bd1\u901a\u8fc7",
  compileFailed: "\u9700\u8981\u4fee\u590d",
  notCompiled: "\u672a\u7f16\u8bd1",
  name: "\u7b56\u7565\u540d\u79f0",
  nameHint: "\u7ed9\u7b56\u7565\u4e00\u4e2a\u6e05\u6670\u7684\u540d\u5b57\uff0c\u4f8b\u5982\uff1a\u6bd4\u7279\u5e01\u5747\u7ebf\u7b56\u7565",
  description: "\u7b56\u7565\u8bf4\u660e",
  descriptionHint: "\u7528\u4e00\u53e5\u8bdd\u63cf\u8ff0\u7b56\u7565\u5728\u505a\u4ec0\u4e48\uff0c\u4f8b\u5982\uff1a\u5feb\u6162\u5747\u7ebf\u91d1\u53c9\u5f00\u4ed3\uff0c\u6b7b\u53c9\u5e73\u4ed3",
  symbol: "\u4ea4\u6613\u5bf9",
  symbolHint: "\u4f8b\u5982\uff1a\u0042\u0054\u0043\u0055\u0053\u0044\u0054",
  interval: "\u5468\u671f",
  intervalHint: "\u4f8b\u5982\uff1a\u0031\u0068\u3001\u0034\u0068\u3001\u0031\u0064",
  marketType: "\u5e02\u573a\u7c7b\u578b",
  runtime: "\u8fd0\u884c\u73af\u5883",
  fastPeriod: "\u5feb\u7ebf\u5468\u671f",
  fastPeriodHint: "\u77ed\u5468\u671f\u5747\u7ebf\u7684 K \u7ebf\u6570\u3002\u6570\u503c\u8d8a\u5c0f\uff0c\u4fe1\u53f7\u8d8a\u654f\u611f\u3002",
  slowPeriod: "\u6162\u7ebf\u5468\u671f",
  slowPeriodHint: "\u957f\u5468\u671f\u5747\u7ebf\u7684 K \u7ebf\u6570\u3002\u901a\u5e38\u9700\u8981\u5927\u4e8e\u5feb\u7ebf\u5468\u671f\u3002",
  positionSizeUsd: "\u5355\u6b21\u4e0b\u5355\u91d1\u989d\uff08\u7f8e\u5143\uff09",
  positionSizeUsdHint: "\u6bcf\u6b21\u4ea7\u751f\u5165\u573a\u4fe1\u53f7\u65f6\uff0c\u51c6\u5907\u6295\u5165\u7684\u540d\u4e49\u91d1\u989d\u3002",
  maxNotional: "\u6700\u5927\u540d\u4e49\u91d1\u989d",
  maxNotionalHint: "\u5141\u8bb8\u8fd9\u4e2a\u7b56\u7565\u6301\u6709\u7684\u6700\u5927\u4ed3\u4f4d\u89c4\u6a21\u3002\u8d85\u8fc7\u540e\u5c06\u88ab\u98ce\u63a7\u62d2\u7edd\u3002",
  maxLeverage: "\u6700\u5927\u6760\u6746",
  maxLeverageHint: "\u7b56\u7565\u5141\u8bb8\u4f7f\u7528\u7684\u6700\u9ad8\u6760\u6746\u500d\u6570\u3002",
  maxDailyLoss: "\u5355\u65e5\u4e8f\u635f\u4e0a\u9650",
  maxDailyLossHint: "\u5f53\u65e5\u7d2f\u8ba1\u4e8f\u635f\u8d85\u8fc7\u8fd9\u4e2a\u6570\u5b57\u65f6\uff0c\u7b56\u7565\u5e94\u505c\u6b62\u7ee7\u7eed\u4ea4\u6613\u3002",
  sourceCode: "\u7b56\u7565\u6e90\u7801",
  compile: "\u7f16\u8bd1\u68c0\u67e5",
  save: "\u4fdd\u5b58\u5230\u5e73\u53f0",
  feedback: "\u7f16\u8bd1\u53cd\u9988",
  noErrors: "\u6ca1\u6709\u53d1\u73b0\u8bed\u6cd5\u9519\u8bef\u3002",
  compileFirst: "\u5148\u70b9\u51fb\u201c\u7f16\u8bd1\u68c0\u67e5\u201d\u9a8c\u8bc1\u7b56\u7565\u6e90\u7801\u3002",
  spot: "\u73b0\u8d27",
  futures: "\u5408\u7ea6",
  paper: "\u7eb8\u9762",
  sandbox: "\u6c99\u76d2",
  production: "\u751f\u4ea7",
  backtestOnly: "\u4ec5\u56de\u6d4b",
} as const;

function FieldLabel(props: { title: string; description: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <div>
        <div className="text-sm font-medium text-zinc-100">{props.title}</div>
        <div className="mt-1 text-xs leading-5 text-zinc-500">{props.description}</div>
      </div>
      {props.children}
    </label>
  );
}

function buildDraftFromStrategy(strategy: PythonStrategy | null): PythonStrategy {
  if (strategy && strategy.template === "python") {
    return {
      ...strategy,
      sourceCode: strategy.sourceCode || DEFAULT_SOURCE_CODE,
      compiler: strategy.compiler || null,
      artifactSummary: strategy.artifactSummary || null,
    };
  }

  return {
    name: FIELD_TEXT.defaultName,
    description: FIELD_TEXT.defaultDescription,
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "1h",
    runtime: "paper",
    template: "python",
    parameters: {
      fastPeriod: 10,
      slowPeriod: 30,
      positionSizeUsd: 1000,
    },
    risk: {
      maxNotional: 3000,
      maxLeverage: 2,
      maxDailyLoss: 200,
      allowedSymbols: ["BTCUSDT"],
    },
    sourceCode: DEFAULT_SOURCE_CODE,
    compiler: null,
    artifactSummary: null,
  };
}

export function PythonStrategyEditorPanel(props: {
  selectedStrategy: PythonStrategy | null;
  busy: boolean;
  onCompile: (sourceCode: string) => Promise<CompilerResult>;
  onSave: (strategy: PythonStrategy) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PythonStrategy>(() => buildDraftFromStrategy(props.selectedStrategy));
  const [compiler, setCompiler] = useState<CompilerResult | null>(props.selectedStrategy?.compiler || null);

  useEffect(() => {
    const nextDraft = buildDraftFromStrategy(props.selectedStrategy);
    setDraft(nextDraft);
    setCompiler(nextDraft.compiler || null);
  }, [props.selectedStrategy]);

  const setRiskField = (key: "maxNotional" | "maxLeverage" | "maxDailyLoss", value: number) => {
    setDraft((current) => ({
      ...current,
      risk: {
        ...current.risk,
        [key]: value,
      },
    }));
  };

  const setParameterField = (key: string, value: number) => {
    setDraft((current) => ({
      ...current,
      parameters: {
        ...current.parameters,
        [key]: value,
      },
    }));
  };

  const handleCompile = async () => {
    const result = await props.onCompile(draft.sourceCode || "");
    setCompiler(result);
  };

  const handleSave = async () => {
    await props.onSave({
      ...draft,
      template: "python",
      compiler,
    });
  };

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-5 p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">{FIELD_TEXT.title}</h2>
            <p className="mt-1 text-sm text-zinc-500">{FIELD_TEXT.subtitle}</p>
          </div>
          <Badge variant={compiler?.valid ? "success" : "warning"}>
            {compiler ? (compiler.valid ? FIELD_TEXT.compilePassed : FIELD_TEXT.compileFailed) : FIELD_TEXT.notCompiled}
          </Badge>
        </div>

        {draft.artifactSummary && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-zinc-300">
            <div className="font-medium text-emerald-300">{FIELD_TEXT.strategySaved}</div>
            <div className="mt-2">{FIELD_TEXT.version}：{draft.artifactSummary.version}</div>
            <div className="mt-2 break-all">{FIELD_TEXT.rootDir}：{draft.artifactSummary.rootDir}</div>
            <div className="mt-2 break-all">{FIELD_TEXT.sourceFile}：{draft.artifactSummary.latestSourceFile}</div>
            <div className="mt-2 break-all">{FIELD_TEXT.metadataFile}：{draft.artifactSummary.latestMetadataFile}</div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-4">
            <FieldLabel title={FIELD_TEXT.name} description={FIELD_TEXT.nameHint}>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              />
            </FieldLabel>

            <FieldLabel title={FIELD_TEXT.description} description={FIELD_TEXT.descriptionHint}>
              <input
                value={draft.description}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
              />
            </FieldLabel>

            <div className="grid grid-cols-2 gap-3">
              <FieldLabel title={FIELD_TEXT.symbol} description={FIELD_TEXT.symbolHint}>
                <input
                  value={draft.symbol}
                  onChange={(event) => setDraft((current) => ({ ...current, symbol: event.target.value.toUpperCase() }))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.interval} description={FIELD_TEXT.intervalHint}>
                <input
                  value={draft.interval}
                  onChange={(event) => setDraft((current) => ({ ...current, interval: event.target.value }))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FieldLabel title={FIELD_TEXT.marketType} description="">
                <select
                  value={draft.marketType}
                  onChange={(event) => setDraft((current) => ({ ...current, marketType: event.target.value as "spot" | "futures" }))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                >
                  <option value="spot">{FIELD_TEXT.spot}</option>
                  <option value="futures">{FIELD_TEXT.futures}</option>
                </select>
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.runtime} description="">
                <select
                  value={draft.runtime}
                  onChange={(event) => setDraft((current) => ({ ...current, runtime: event.target.value }))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                >
                  <option value="paper">{FIELD_TEXT.paper}</option>
                  <option value="sandbox">{FIELD_TEXT.sandbox}</option>
                  <option value="production">{FIELD_TEXT.production}</option>
                  <option value="backtest-only">{FIELD_TEXT.backtestOnly}</option>
                </select>
              </FieldLabel>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <FieldLabel title={FIELD_TEXT.fastPeriod} description={FIELD_TEXT.fastPeriodHint}>
                <input
                  type="number"
                  value={draft.parameters.fastPeriod || 10}
                  onChange={(event) => setParameterField("fastPeriod", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.slowPeriod} description={FIELD_TEXT.slowPeriodHint}>
                <input
                  type="number"
                  value={draft.parameters.slowPeriod || 30}
                  onChange={(event) => setParameterField("slowPeriod", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.positionSizeUsd} description={FIELD_TEXT.positionSizeUsdHint}>
                <input
                  type="number"
                  value={draft.parameters.positionSizeUsd || 1000}
                  onChange={(event) => setParameterField("positionSizeUsd", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <FieldLabel title={FIELD_TEXT.maxNotional} description={FIELD_TEXT.maxNotionalHint}>
                <input
                  type="number"
                  value={draft.risk.maxNotional}
                  onChange={(event) => setRiskField("maxNotional", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.maxLeverage} description={FIELD_TEXT.maxLeverageHint}>
                <input
                  type="number"
                  value={draft.risk.maxLeverage}
                  onChange={(event) => setRiskField("maxLeverage", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>

              <FieldLabel title={FIELD_TEXT.maxDailyLoss} description={FIELD_TEXT.maxDailyLossHint}>
                <input
                  type="number"
                  value={draft.risk.maxDailyLoss}
                  onChange={(event) => setRiskField("maxDailyLoss", Number(event.target.value))}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
              </FieldLabel>
            </div>
          </div>

          <div className="space-y-3">
            <FieldLabel title={FIELD_TEXT.sourceCode} description="">
              <textarea
                value={draft.sourceCode || ""}
                onChange={(event) => setDraft((current) => ({ ...current, sourceCode: event.target.value }))}
                className="h-[640px] w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 font-mono text-sm leading-6 text-zinc-100"
                spellCheck={false}
              />
            </FieldLabel>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  const nextDraft = buildDraftFromStrategy(null);
                  setDraft(nextDraft);
                  setCompiler(null);
                }}
              >
                {FIELD_TEXT.newStrategy}
              </Button>
              <Button variant="outline" onClick={handleCompile} disabled={props.busy}>
                {FIELD_TEXT.compile}
              </Button>
              <Button onClick={handleSave} disabled={props.busy || !draft.name.trim() || !draft.sourceCode?.trim()}>
                {FIELD_TEXT.save}
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
          <div className="font-medium text-zinc-100">{FIELD_TEXT.feedback}</div>
          {compiler?.errors?.length ? (
            <div className="mt-2 space-y-1 text-rose-400">
              {compiler.errors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-zinc-400">
              {compiler?.valid ? FIELD_TEXT.noErrors : FIELD_TEXT.compileFirst}
            </div>
          )}
          {!!compiler?.warnings?.length && (
            <div className="mt-3 space-y-1 text-amber-400">
              {compiler.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
