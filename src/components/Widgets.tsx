import React from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Button } from "./ui";
import { Database, Server, Clock, Activity, CheckCircle2, AlertCircle, RefreshCw, BarChart2, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { useTranslation } from "../lib/i18n";
import { cn } from "../lib/utils";

export function DataSourcesWidget() {
  const { t } = useTranslation();
  const sources = [
    { asset: t("stocks"), source: "SIP / CTP", latency: "12ms", status: "实时" },
    { asset: t("crypto"), source: "研究数据源", latency: "45ms", status: "观察中" },
    { asset: t("futures"), source: "CME Group", latency: "8ms", status: "实时" },
    { asset: t("options"), source: "OPRA", latency: "15ms", status: "实时" },
    { asset: t("forex"), source: "EBS / Reuters", latency: "22ms", status: "实时" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Database className="h-4 w-4 text-blue-500" />
          {t("assetClasses")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("symbol")}</TableHead>
              <TableHead>{t("source")}</TableHead>
              <TableHead className="text-right">{t("lastSync")}</TableHead>
              <TableHead className="text-right">{t("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((item) => (
              <TableRow key={item.asset}>
                <TableCell className="font-medium">{item.asset}</TableCell>
                <TableCell className="text-zinc-400">{item.source}</TableCell>
                <TableCell className="text-right font-mono text-xs">{item.latency}</TableCell>
                <TableCell className="text-right">
                  <Badge variant="success" className="border-emerald-500/20 bg-emerald-500/10 text-emerald-500">
                    {item.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function DataFrequencyWidget() {
  const { t } = useTranslation();
  const frequencies = [
    { name: t("tickData"), rows: "45.2B", size: "12.4 TB", icon: Activity, color: "text-rose-500", bg: "bg-rose-500/10" },
    { name: t("minuteData"), rows: "8.5B", size: "2.1 TB", icon: Clock, color: "text-blue-500", bg: "bg-blue-500/10" },
    { name: t("dailyData"), rows: "120M", size: "45 GB", icon: BarChart2, color: "text-emerald-500", bg: "bg-emerald-500/10" },
    { name: t("altData"), rows: "1.2B", size: "850 GB", icon: Database, color: "text-amber-500", bg: "bg-amber-500/10" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">{t("frequencyGranularity")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {frequencies.map((item) => (
            <div key={item.name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="mb-3 flex items-center gap-3">
                <div className={cn("rounded-md p-2", item.bg)}>
                  <item.icon className={cn("h-4 w-4", item.color)} />
                </div>
                <span className="text-sm font-medium">{item.name}</span>
              </div>
              <div className="mt-auto flex items-end justify-between">
                <div>
                  <div className="text-xs text-zinc-500">{t("rows")}</div>
                  <div className="font-mono font-medium">{item.rows}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-zinc-500">{t("diskUsage")}</div>
                  <div className="font-mono text-zinc-400">{item.size}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ETLJobsWidget() {
  const { t } = useTranslation();
  const jobs = [
    { name: "公司行为复权", time: "10 分钟前", status: "Success" },
    { name: "研究特征刷新", time: "运行中...", status: "Running" },
    { name: "基础数据合并", time: "1 小时前", status: "Success" },
    { name: "宏观指标更新", time: "2 小时前", status: "Success" },
    { name: "另类数据评分", time: "5 分钟前", status: "Failed" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <RefreshCw className="h-4 w-4 text-amber-500" />
          {t("etlGovernance")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {jobs.map((job) => (
            <div key={job.name} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-center gap-3">
                {job.status === "Success" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {job.status === "Running" && <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />}
                {job.status === "Failed" && <AlertCircle className="h-4 w-4 text-rose-500" />}
                <div>
                  <div className="text-sm font-medium">{job.name}</div>
                  <div className="text-xs text-zinc-500">{job.time}</div>
                </div>
              </div>
              <Badge variant={job.status === "Success" ? "success" : job.status === "Failed" ? "danger" : "default"}>
                {job.status === "Running" ? t("running") : job.status === "Success" ? t("success") : t("failed")}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function StorageArchitectureWidget() {
  const { t } = useTranslation();
  const stores = [
    { name: "DolphinDB", role: "Tick 与日内数据", latency: "1.2ms", usage: "78%" },
    { name: "ClickHouse", role: "研究数仓", latency: "5.8ms", usage: "45%" },
    { name: "Redis", role: "实时控制状态", latency: "0.9ms", usage: "62%" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Server className="h-4 w-4 text-purple-500" />
          {t("storageArchitecture")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {stores.map((store) => (
            <div key={store.name} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{store.name}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-500">{store.role}</span>
                </div>
                <div className="text-xs font-mono text-zinc-400">{t("queryLatency")}: {store.latency}</div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div className={cn("h-full rounded-full", parseInt(store.usage, 10) > 75 ? "bg-rose-500" : "bg-purple-500")} style={{ width: store.usage }} />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function MarketOverview() {
  const markets = [
    { name: "美股篮子", value: "12,482", change: 1.42 },
    { name: "期货组合", value: "4,198", change: -0.36 },
    { name: "外汇宏观", value: "1.0842", change: 0.21 },
    { name: "加密研究", value: "62,140", change: 2.84 },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {markets.map((market) => {
        const positive = market.change >= 0;
        return (
          <Card key={market.name}>
            <CardContent className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-300">{market.name}</div>
                {positive ? <ArrowUpRight className="h-4 w-4 text-emerald-500" /> : <ArrowDownRight className="h-4 w-4 text-rose-500" />}
              </div>
              <div className="text-2xl font-semibold text-zinc-50">{market.value}</div>
              <div className={cn("mt-2 text-sm font-medium", positive ? "text-emerald-500" : "text-rose-500")}>
                {positive ? "+" : ""}{market.change.toFixed(2)}%
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function ChartWidget({ title, data }: { title: string; data: any[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip contentStyle={{ backgroundColor: "#09090b", border: "1px solid #27272a", borderRadius: 12 }} />
              <Area type="monotone" dataKey="price" stroke="#10b981" strokeWidth={2} fill="url(#chartFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

export function PositionsTable() {
  const rows = [
    { book: "股票统计套利", exposure: "$4.2M", pnl: "+1.8%", status: "限额内" },
    { book: "宏观叠加", exposure: "$2.6M", pnl: "-0.4%", status: "待复核" },
    { book: "事件驱动", exposure: "$1.9M", pnl: "+0.9%", status: "限额内" },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>组合账本</CardTitle>
        <Badge variant="default">3 个启用中</Badge>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账本</TableHead>
              <TableHead>敞口</TableHead>
              <TableHead>盈亏</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.book}>
                <TableCell className="font-medium text-zinc-100">{row.book}</TableCell>
                <TableCell className="font-mono text-zinc-300">{row.exposure}</TableCell>
                <TableCell className={cn("font-mono", row.pnl.startsWith("+") ? "text-emerald-500" : "text-rose-500")}>{row.pnl}</TableCell>
                <TableCell className="text-zinc-400">{row.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function StrategyRunner() {
  const pipelines = [
    { name: "均值回归篮子", stage: "研究中", updatedAt: "4 分钟前" },
    { name: "跨资产动量", stage: "回测中", updatedAt: "11 分钟前" },
    { name: "波动率曲面叠加", stage: "风控复核", updatedAt: "32 分钟前" },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>策略流水线</CardTitle>
        <Button variant="outline" size="sm">新建策略</Button>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {pipelines.map((pipeline) => (
            <div key={pipeline.name} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-zinc-100">{pipeline.name}</div>
                  <div className="mt-1 text-xs text-zinc-500">更新时间 {pipeline.updatedAt}</div>
                </div>
                <Badge variant="warning">{pipeline.stage}</Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
