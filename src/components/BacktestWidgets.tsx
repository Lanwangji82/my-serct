import React, { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Line, LineChart, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "./ui";
import { Settings2, Cpu, Zap, SlidersHorizontal, Play, CheckSquare, Square } from "lucide-react";
import { formatCurrency, formatPercentage, cn } from "../lib/utils";
import { useTranslation } from "../lib/i18n";

const generateEquityData = () => {
  let strategy = 100000;
  let benchmark = 100000;
  return Array.from({ length: 100 }).map((_, i) => {
    strategy *= (1 + (Math.random() - 0.48) * 0.04);
    benchmark *= (1 + (Math.random() - 0.49) * 0.03);
    return {
      day: `第 ${i} 天`,
      strategy: Math.round(strategy),
      benchmark: Math.round(benchmark),
    };
  });
};

export function BacktestEngineConfig() {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<"vectorized" | "event">("vectorized");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          {t("engineType")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div 
            className={cn("p-4 rounded-lg border cursor-pointer transition-colors", engine === "vectorized" ? "border-amber-500 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700")}
            onClick={() => setEngine("vectorized")}
          >
            <div className="font-medium text-sm text-zinc-50 mb-1">{t("vectorized")}</div>
            <div className="text-xs text-zinc-400">基于 Pandas/NumPy，适合快速因子研究与 Alpha 验证。</div>
          </div>
          <div 
            className={cn("p-4 rounded-lg border cursor-pointer transition-colors", engine === "event" ? "border-amber-500 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700")}
            onClick={() => setEngine("event")}
          >
            <div className="font-medium text-sm text-zinc-50 mb-1">{t("eventDriven")}</div>
            <div className="text-xs text-zinc-400">逐笔事件仿真，更适合高频策略和执行算法。</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SimulationSettings() {
  const { t } = useTranslation();
  const [l2, setL2] = useState(true);
  const [limits, setLimits] = useState(true);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-blue-500" />
          {t("simulation")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">{t("slippage")}</label>
              <input type="number" defaultValue={2.5} className="w-full h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">{t("commission")}</label>
              <input type="number" defaultValue={0.03} className="w-full h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">{t("marginInterest")}</label>
              <input type="number" defaultValue={4.5} className="w-full h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
          <div className="flex gap-6 pt-2">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setL2(!l2)}>
              {l2 ? <CheckSquare className="h-4 w-4 text-blue-500" /> : <Square className="h-4 w-4 text-zinc-600" />}
              <span className="text-sm text-zinc-300">{t("l2Matching")}</span>
            </div>
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setLimits(!limits)}>
              {limits ? <CheckSquare className="h-4 w-4 text-blue-500" /> : <Square className="h-4 w-4 text-zinc-600" />}
              <span className="text-sm text-zinc-300">{t("priceLimits")}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function OptimizationConfig() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-emerald-500" />
          {t("optimization")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t("optMethod")}</label>
            <select className="w-full h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm focus:border-emerald-500 focus:outline-none text-zinc-50">
              <option>{t("geneticAlgo")}</option>
              <option>{t("gridSearch")}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t("targetMetric")}</label>
            <select className="w-full h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm focus:border-emerald-500 focus:outline-none text-zinc-50">
              <option>{t("sharpeRatio")}</option>
              <option>{t("cagr")}</option>
              <option>{t("profitFactor")}</option>
            </select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ComputingResources() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <Cpu className="h-4 w-4 text-purple-500" />
          {t("computing")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex justify-between items-center text-sm">
            <span className="text-zinc-400">{t("threads")}</span>
            <span className="font-mono text-purple-400">32 / 64 Cores</span>
          </div>
          <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-purple-500 rounded-full" style={{ width: "50%" }} />
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-zinc-400">{t("parallelTasks")}</span>
            <span className="font-mono text-zinc-300">1,024</span>
          </div>
          <Button className="w-full mt-2 bg-purple-600 hover:bg-purple-700 text-white border-0">
            <Play className="h-4 w-4 mr-2" />
            {t("runOptimization")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BacktestResults() {
  const { t } = useTranslation();
  const data = generateEquityData();
  
  const stats = [
    { label: t("cagr"), value: "42.5%", color: "text-emerald-500" },
    { label: t("sharpeRatio"), value: "2.85", color: "text-emerald-500" },
    { label: t("maxDrawdown"), value: "-12.4%", color: "text-rose-500" },
    { label: t("profitFactor"), value: "1.95", color: "text-emerald-500" },
    { label: t("tradesWinRate"), value: "4,521 / 58%", color: "text-zinc-300" },
  ];

  return (
    <Card className="col-span-1 lg:col-span-2">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-medium">{t("results")}</CardTitle>
        <Badge variant="success">12.4 秒完成</Badge>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
          {stats.map((s, i) => (
            <div key={i} className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30">
              <div className="text-xs text-zinc-500 mb-1">{s.label}</div>
              <div className={cn("text-lg font-bold font-mono", s.color)}>{s.value}</div>
            </div>
          ))}
        </div>
        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="day" stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} minTickGap={30} />
              <YAxis stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `$${(val/1000).toFixed(0)}k`} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '8px', color: '#f4f4f5' }}
                itemStyle={{ fontFamily: 'monospace' }}
              />
              <Legend wrapperStyle={{ fontSize: '12px', color: '#a1a1aa' }} />
              <Line type="monotone" dataKey="strategy" name="策略" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="benchmark" name={t("benchmark")} stroke="#71717a" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
