import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../common/ui";
import type { AssetRow, BacktestLog, BacktestRun, BacktestTrade, MarketEvent, MarketRow, PlatformStrategy } from "../strategy/strategy-types";
import { formatDateTime, formatMoney } from "../../lib/platform-client";

type Strategy = Pick<PlatformStrategy, "id" | "symbol" | "interval" | "template" | "marketType">;

export type BacktestConfig = {
  brokerTarget: string;
  startTime: string;
  endTime: string;
  periodValue: number;
  periodUnit: "m" | "h" | "d";
  basePeriodValue: number;
  basePeriodUnit: "m" | "h" | "d";
  mode: string;
  initialCapital: number;
  quoteAsset: string;
  logLimit: number;
  profitLimit: number;
  chartBars: number;
  slippagePoints: number;
  tolerancePct: number;
  delayMs: number;
  candleLimit: number;
  openFeePct: number;
  closeFeePct: number;
  recordEvents: boolean;
  chartDisplay: string;
  depthMin: number;
  depthMax: number;
  dataSource: string;
  orderMode: string;
  distributor: string;
};

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  events: MarketEvent[];
};

type OverviewPoint = {
  time: number;
  floatingPnlPct: number;
  benchmarkPct: number;
  periodPnlPct: number;
  periodPnlUp: number;
  periodPnlDown: number;
  volumeUp: number;
  volumeDown: number;
  trades: number;
  longQty: number;
  shortQty: number;
  utilizationPct: number;
};

const num = (value: number | null | undefined, digits = 2) =>
  new Intl.NumberFormat("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value ?? 0);
const pct = (value: number | null | undefined) => `${num(value, 2)}%`;

function isDateInterval(interval: string) {
  return interval.endsWith("d") || interval.endsWith("w");
}

function toChartTime(time: number, interval: string): Time {
  if (isDateInterval(interval)) {
    const date = new Date(time);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  return Math.floor(time / 1000) as UTCTimestamp;
}

function timeKey(time: Time) {
  if (typeof time === "number") return `ts:${time}`;
  if (typeof time === "string") return `ts:${time}`;
  return `bd:${time.year}-${time.month}-${time.day}`;
}

function formatAxisTime(time: Time, interval: string) {
  if (typeof time === "number") {
    const date = new Date(time * 1000);
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return isDateInterval(interval)
      ? `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()}`
      : `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()} ${hour}:${minute}`;
  }
  if (typeof time === "string") {
    const date = new Date(time);
    return `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()}`;
  }
  return `${time.year}\\${time.month}\\${time.day}`;
}

function formatCandleTime(time: number, interval: string) {
  const date = new Date(time);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return isDateInterval(interval)
    ? `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()}`
    : `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()} ${hour}:${minute}`;
}

function periodsPerYear(unit: "m" | "h" | "d", value: number) {
  const size = Math.max(1, value || 1);
  if (unit === "m") return (365 * 24 * 60) / size;
  if (unit === "d") return 365 / size;
  return (365 * 24) / size;
}

function stddev(values: number[]) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function periodMs(value: number, unit: "m" | "h" | "d") {
  const n = Math.max(1, value || 1);
  if (unit === "m") return n * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return n * 60 * 60 * 1000;
}

function parsePeriod(value: unknown): { value: number; unit: "m" | "h" | "d" } {
  const match = String(value || "").trim().match(/^(\d+)([mhd])$/i);
  if (!match) {
    return { value: 1, unit: "h" };
  }
  return {
    value: Math.max(Number(match[1]) || 1, 1),
    unit: match[2].toLowerCase() as "m" | "h" | "d",
  };
}

function getEventVolume(events: MarketEvent[] | undefined) {
  return (events || []).reduce((sum, event) => sum + Math.abs(Number(event.quantity || 0)), 0);
}

function buildCandles(rows: MarketRow[], value: number, unit: "m" | "h" | "d"): Candle[] {
  if (rows.some((row) => typeof row.open === "number" && typeof row.high === "number" && typeof row.low === "number" && typeof row.close === "number")) {
    return [...rows]
      .sort((a, b) => a.time - b.time)
      .map((row) => ({
        time: row.time,
        open: Number(row.open ?? row.lastPrice ?? 0),
        high: Number(row.high ?? row.lastPrice ?? 0),
        low: Number(row.low ?? row.lastPrice ?? 0),
        close: Number(row.close ?? row.lastPrice ?? 0),
        volume: Math.max(Number(row.volume ?? 0), 0),
        events: [...(row.events || [])],
      }));
  }

  const bucket = periodMs(value, unit);
  const map = new Map<number, Candle>();
  let previousClose = 0;
  let previousLongAmount = 0;
  let previousShortAmount = 0;
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    const bucketTime = Math.floor(row.time / bucket) * bucket;
    const price = Number(row.lastPrice || row.close || row.open || 0);
    const longAmount = Math.abs(Number(row.longAmount || 0));
    const shortAmount = Math.abs(Number(row.shortAmount || 0));
    const events = [...(row.events || [])];
    const eventPrices = events.map((event) => Number(event.price || event.averagePrice || 0)).filter((item) => item > 0);
    const positionDelta = Math.abs(longAmount - previousLongAmount) + Math.abs(shortAmount - previousShortAmount);
    const derivedVolume = Math.max(getEventVolume(events), positionDelta);
    const current = map.get(bucketTime);
    if (!current) {
      const derivedOpen = previousClose > 0 ? previousClose : price;
      const derivedHigh = Math.max(derivedOpen, price, ...eventPrices);
      const derivedLow = Math.min(derivedOpen, price, ...(eventPrices.length ? eventPrices : [price]));
      map.set(bucketTime, {
        time: bucketTime,
        open: derivedOpen,
        high: derivedHigh,
        low: derivedLow,
        close: price,
        volume: derivedVolume,
        events,
      });
      previousClose = price;
      previousLongAmount = longAmount;
      previousShortAmount = shortAmount;
      continue;
    }
    current.high = Math.max(current.high, price, ...eventPrices);
    current.low = Math.min(current.low, price, ...(eventPrices.length ? eventPrices : [price]));
    current.close = price;
    current.volume += derivedVolume;
    if (events.length) current.events.push(...events);
    previousClose = price;
    previousLongAmount = longAmount;
    previousShortAmount = shortAmount;
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function buildOverviewSeries(rows: MarketRow[], candles: Candle[], initialCapital: number): OverviewPoint[] {
  if (!candles.length) return [];
  const rowsByTime = new Map(rows.map((row) => [row.time, row] as const));
  const firstPrice = Number(candles[0]?.close ?? 0);
  let previousEquity = initialCapital > 0 ? initialCapital : Number(rowsByTime.get(candles[0].time)?.equity ?? 0);
  return candles
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((candle) => {
      const row = rowsByTime.get(candle.time);
      const price = Number(candle.close ?? 0);
      const equity = Number(row?.equity ?? previousEquity ?? 0);
      const floatingPnlPct = initialCapital > 0 ? ((equity - initialCapital) / initialCapital) * 100 : 0;
      const benchmarkPct = firstPrice > 0 ? ((price - firstPrice) / firstPrice) * 100 : 0;
      const periodPnlPct = previousEquity > 0 ? ((equity - previousEquity) / previousEquity) * 100 : 0;
      previousEquity = equity;
      return {
        time: candle.time,
        floatingPnlPct,
        benchmarkPct,
        periodPnlPct,
        periodPnlUp: periodPnlPct >= 0 ? periodPnlPct : 0,
        periodPnlDown: periodPnlPct < 0 ? periodPnlPct : 0,
        volumeUp: candle.close >= candle.open ? Number(candle.volume ?? 0) : 0,
        volumeDown: candle.close < candle.open ? -Math.abs(Number(candle.volume ?? 0)) : 0,
        trades: candle.events.length,
        longQty: Math.max(Number(row?.longAmount ?? 0), 0),
        shortQty: Math.max(Number(row?.shortAmount ?? 0), 0),
        utilizationPct: Number(row?.utilization ?? 0) * 100,
      };
    });
}

function OverviewTooltip(props: { active?: boolean; payload?: Array<{ payload?: OverviewPoint }> }) {
  if (!props.active || !props.payload?.length) return null;
  const point = props.payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded border border-zinc-400 bg-white/95 px-3 py-2 text-xs text-zinc-800 shadow-xl">
      <div>{formatDateTime(point.time)}</div>
      <div className="mt-1 text-[#2b6cb0]">浮动盈亏: {num(point.floatingPnlPct, 3)} ({pct(point.floatingPnlPct)})</div>
      <div className="text-[#d64545]">基准收益: {pct(point.benchmarkPct)}</div>
      <div className="text-[#7ba23f]">周期盈亏: {pct(point.periodPnlPct)}</div>
      <div className="text-[#84cc16]">多仓: {num(point.longQty, 3)}</div>
      <div className="text-[#fb923c]">空仓: {num(point.shortQty, 3)}</div>
      <div className="text-[#52525b]">交易: {point.trades}</div>
      <div className="text-[#8b6f1e]">资金利用率: {pct(point.utilizationPct)}</div>
    </div>
  );
}

function formatOverviewTick(value: number) {
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function OverviewPanel(props: {
  symbol: string;
  summary: {
    initialCapital: number;
    cumulativeReturnPct: number;
    annualReturnPct: number;
    sharpe: number;
    volatilityPct: number;
    maxDrawdownPct: number;
  };
  data: OverviewPoint[];
}) {
  const axisTextClass = "fill-zinc-500 text-[11px]";
  const gridStroke = "rgba(161,161,170,0.18)";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded border border-emerald-500/50 bg-zinc-950 px-3 py-2 text-sm text-emerald-400">
          {props.symbol}
        </div>
        <div className="text-xs text-zinc-400">
          初始净值：{num(props.summary.initialCapital, 2)} 累计收益：{pct(props.summary.cumulativeReturnPct)} 年化收益(365天)：{pct(props.summary.annualReturnPct)} 夏普比率：{num(props.summary.sharpe, 3)} 年化波动率：{pct(props.summary.volatilityPct)} 最大回撤：{pct(props.summary.maxDrawdownPct)}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/35 p-3">
        <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
          <span>Zoom</span>
          {["1h", "3h", "8h", "12h", "24h", "All"].map((item) => (
            <span key={item} className={`rounded px-2 py-1 ${item === "All" ? "bg-zinc-700 text-white" : "bg-zinc-800/70 text-zinc-400"}`}>{item}</span>
          ))}
        </div>
        <div className="space-y-0.5">
          <div className="h-[170px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={props.data} syncId="overview-sync" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} hide />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={46} orientation="right" label={{ value: "总盈亏", angle: 90, position: "insideRight", offset: -2, className: axisTextClass }} />
                <Tooltip content={<OverviewTooltip />} />
                <ReferenceLine y={0} stroke="rgba(107,114,128,0.8)" />
                <Line type="monotone" dataKey="floatingPnlPct" name="浮动盈亏" stroke="#336fb5" dot={false} strokeWidth={2.1} />
                <Line type="monotone" dataKey="benchmarkPct" name="基准收益" stroke="#c94b4b" dot={false} strokeWidth={1.5} />
                <Area type="monotone" dataKey="floatingPnlPct" fill="rgba(59,130,246,0.08)" stroke="none" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="h-[82px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={props.data} syncId="overview-sync" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} hide />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={46} orientation="right" label={{ value: "总盈亏", angle: 90, position: "insideRight", offset: -2, className: axisTextClass }} />
                <ReferenceLine y={0} stroke="rgba(107,114,128,0.7)" />
                <Bar dataKey="periodPnlUp" name="周期盈亏" fill="#9fbe5d" radius={[1, 1, 0, 0]} />
                <Bar dataKey="periodPnlDown" name="周期盈亏" fill="#e15858" radius={[1, 1, 0, 0]} />
                <Bar dataKey="volumeUp" name="交易量" fill="#9fbe5d" radius={[1, 1, 0, 0]} />
                <Bar dataKey="volumeDown" name="交易量" fill="#e15858" radius={[1, 1, 0, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="h-[64px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={props.data} syncId="overview-sync" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} hide />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={46} orientation="right" label={{ value: "仓位/量变化", angle: 90, position: "insideRight", offset: -2, className: axisTextClass }} />
                <ReferenceLine y={0} stroke="rgba(107,114,128,0.6)" />
                <Bar dataKey="trades" name="交易" fill="#3f3f46" radius={[1, 1, 0, 0]} />
                <Area type="stepAfter" dataKey="longQty" name="多仓" fill="rgba(132,204,22,0.35)" stroke="#7dde6e" strokeWidth={1.2} />
                <Area type="stepAfter" dataKey="shortQty" name="空仓" fill="rgba(251,146,60,0.28)" stroke="#f5a85c" strokeWidth={1.2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="h-[74px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={props.data} syncId="overview-sync" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#71717a", fontSize: 11 }} tickFormatter={formatOverviewTick} minTickGap={24} />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={46} orientation="right" label={{ value: "资金利用率", angle: 90, position: "insideRight", offset: -2, className: axisTextClass }} />
                <Line type="stepAfter" dataKey="utilizationPct" name="资金利用率" stroke="#8a7228" dot={false} strokeWidth={1.3} />
                <Legend verticalAlign="bottom" height={26} iconSize={9} wrapperStyle={{ fontSize: "12px", color: "#a1a1aa", paddingTop: "4px" }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function downloadTrades(symbol: string, run: BacktestRun) {
  const lines = [
    "time,label,action,symbol,price,marketPrice,quantity,fee,pnl,message",
    ...(run.trades || []).map((trade) =>
      [
        new Date(trade.time).toISOString(),
        trade.label || trade.side,
        trade.action || trade.side,
        trade.symbol || symbol,
        trade.price,
        trade.marketPrice ?? "",
        trade.quantity,
        trade.fee ?? 0,
        trade.pnl ?? 0,
        JSON.stringify(trade.message || ""),
      ].join(",")
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${symbol}-${run.id}-orders.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Help(props: { text?: string }) {
  if (!props.text) return null;
  return (
    <span className="group relative inline-flex">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400">?</span>
      <span className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-56 -translate-x-1/2 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-[11px] leading-5 text-zinc-300 shadow-2xl group-hover:block">{props.text}</span>
    </span>
  );
}

function Field(props: {
  label: string;
  help?: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number";
  options?: Array<{ value: string; label: string }>;
  readOnly?: boolean;
}) {
  const cls = "h-11 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition focus:border-emerald-500/50";
  return (
    <label>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400">
        <span>{props.label}</span>
        <Help text={props.help} />
      </div>
      {props.options ? (
        <select value={String(props.value)} onChange={(event) => props.onChange(event.target.value)} className={cls} disabled={props.readOnly}>
          {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <input type={props.type || "text"} value={props.value} onChange={(event) => props.onChange(event.target.value)} className={`${cls} ${props.readOnly ? "cursor-default text-zinc-400" : ""}`} readOnly={props.readOnly} />
      )}
    </label>
  );
}

function Metric(props: { label: string; value: React.ReactNode; tone?: "good" | "bad" | "warn" }) {
  const tone = props.tone === "good" ? "text-emerald-400" : props.tone === "bad" ? "text-rose-400" : props.tone === "warn" ? "text-amber-400" : "text-zinc-100";
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><div className="text-xs uppercase tracking-wide text-zinc-500">{props.label}</div><div className={`mt-2 text-2xl font-semibold ${tone}`}>{props.value}</div></div>;
}

function ChartPanel(props: { candles: Candle[]; hovered: Candle | null; onHover: (time: number | null) => void; interval: string }) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const volumeRef = useRef<HTMLDivElement | null>(null);
  const hoveredEvent = props.hovered?.events?.[props.hovered.events.length - 1] || null;

  useEffect(() => {
    const mainEl = mainRef.current;
    const volumeEl = volumeRef.current;
    if (!mainEl || !volumeEl || !props.candles.length) return;

    const mainChart = createChart(mainEl, {
      autoSize: true,
      height: 480,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0b0c" },
        textColor: "#71717a",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(63,63,70,0.18)" },
        horzLines: { color: "rgba(63,63,70,0.18)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(161,161,170,0.72)", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#18181b" },
        horzLine: { color: "rgba(161,161,170,0.55)", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#18181b" },
      },
      rightPriceScale: { borderColor: "rgba(63,63,70,0.55)", scaleMargins: { top: 0.04, bottom: 0.12 } },
      timeScale: {
        borderColor: "rgba(63,63,70,0.55)",
        rightOffset: 10,
        barSpacing: props.candles.length > 180 ? 7 : 10,
        minBarSpacing: 0.35,
        timeVisible: true,
        secondsVisible: false,
        visible: false,
        ticksVisible: false,
        tickMarkFormatter: (time) => formatAxisTime(time, props.interval),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true, axisDoubleClickReset: { time: true, price: true } },
    });

    const volumeChart = createChart(volumeEl, {
      autoSize: true,
      height: 160,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0b0c" },
        textColor: "#71717a",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(63,63,70,0.18)" },
        horzLines: { color: "rgba(63,63,70,0.18)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(161,161,170,0.72)", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#18181b" },
        horzLine: { color: "rgba(161,161,170,0.55)", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#18181b" },
      },
      rightPriceScale: { borderColor: "rgba(63,63,70,0.55)", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderColor: "rgba(63,63,70,0.55)",
        rightOffset: 10,
        barSpacing: props.candles.length > 180 ? 7 : 10,
        minBarSpacing: 0.35,
        timeVisible: true,
        secondsVisible: false,
        visible: true,
        ticksVisible: true,
        tickMarkFormatter: (time) => formatAxisTime(time, props.interval),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true, axisDoubleClickReset: { time: true, price: true } },
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#f43f5e",
      borderUpColor: "#10b981",
      borderDownColor: "#f43f5e",
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
      priceLineVisible: true,
      lastValueVisible: true,
    });
    const volumeSeries = volumeChart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, lastValueVisible: true, priceLineVisible: false });

    const candlesWithTime = props.candles.map((candle) => ({ candle, time: toChartTime(candle.time, props.interval) }));
    candleSeries.setData(candlesWithTime.map(({ candle, time }): CandlestickData<Time> => ({ time, open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
    volumeSeries.setData(candlesWithTime.map(({ candle, time }): HistogramData<Time> => ({ time, value: Math.max(candle.volume, 0), color: candle.close >= candle.open ? "rgba(16,185,129,0.45)" : "rgba(244,63,94,0.45)" })));

    const markers = candlesWithTime.flatMap(({ candle, time }, i) =>
      candle.events.map((event, j) => {
        const marker = (event.marker || event.label || "").toLowerCase();
        const isShort = marker.includes("short");
        const isClose = marker.includes("close");
        return { id: `${i}-${j}-${event.id || marker}`, time, position: isShort ? ("aboveBar" as const) : ("belowBar" as const), shape: isClose ? ("circle" as const) : isShort ? ("arrowDown" as const) : ("arrowUp" as const), color: isShort ? "#f43f5e" : "#22c55e", text: event.marker || event.label || (isShort ? "short" : "long") };
      })
    );
    const markerApi = createSeriesMarkers(candleSeries, markers);

    const lookup = new Map(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle.time] as const));
    const closeLookup = new Map(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle.close] as const));
    const volumeLookup = new Map(candlesWithTime.map(({ candle, time }) => [timeKey(time), Math.max(candle.volume, 0)] as const));
    let syncingCrosshair = false;
    let syncingRange = false;

    const syncHover = (source: "main" | "volume", param: MouseEventParams<Time>) => {
      if (syncingCrosshair) return;
      syncingCrosshair = true;
      const currentTime = param.time ?? null;
      props.onHover(currentTime ? lookup.get(timeKey(currentTime)) ?? null : null);
      if (!currentTime) {
        if (source !== "main") mainChart.clearCrosshairPosition();
        if (source !== "volume") volumeChart.clearCrosshairPosition();
        syncingCrosshair = false;
        return;
      }
      const key = timeKey(currentTime);
      const close = closeLookup.get(key);
      const volume = volumeLookup.get(key);
      if (source !== "main") {
        if (typeof close === "number") mainChart.setCrosshairPosition(close, currentTime, candleSeries);
        else mainChart.clearCrosshairPosition();
      }
      if (source !== "volume") {
        if (typeof volume === "number") volumeChart.setCrosshairPosition(volume, currentTime, volumeSeries);
        else volumeChart.clearCrosshairPosition();
      }
      syncingCrosshair = false;
    };

    const syncRange = (source: "main" | "volume", range: { from: number; to: number } | null) => {
      if (!range || syncingRange) return;
      syncingRange = true;
      if (source !== "main") mainChart.timeScale().setVisibleLogicalRange(range);
      if (source !== "volume") volumeChart.timeScale().setVisibleLogicalRange(range);
      syncingRange = false;
    };

    const handleMainMove = (param: MouseEventParams<Time>) => syncHover("main", param);
    const handleVolumeMove = (param: MouseEventParams<Time>) => syncHover("volume", param);
    const handleMainRange = (range: { from: number; to: number } | null) => syncRange("main", range);
    const handleVolumeRange = (range: { from: number; to: number } | null) => syncRange("volume", range);

    mainChart.subscribeCrosshairMove(handleMainMove);
    volumeChart.subscribeCrosshairMove(handleVolumeMove);
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(handleMainRange);
    volumeChart.timeScale().subscribeVisibleLogicalRangeChange(handleVolumeRange);
    const visibleRange = { from: Math.max(props.candles.length - 320, 0), to: props.candles.length + 8 };
    mainChart.timeScale().setVisibleLogicalRange(visibleRange);
    volumeChart.timeScale().setVisibleLogicalRange(visibleRange);
    props.onHover(props.candles.at(-1)?.time ?? null);

    return () => {
      markerApi.setMarkers([]);
      mainChart.unsubscribeCrosshairMove(handleMainMove);
      volumeChart.unsubscribeCrosshairMove(handleVolumeMove);
      mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleMainRange);
      volumeChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVolumeRange);
      mainChart.remove();
      volumeChart.remove();
    };
  }, [props.candles, props.interval, props.onHover]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs">
        <span className="text-zinc-500">{props.hovered ? formatCandleTime(props.hovered.time, props.interval) : "--"}</span>
        <span className="text-zinc-400">O <span className="text-zinc-100">{num(props.hovered?.open, 4)}</span></span>
        <span className="text-zinc-400">H <span className="text-emerald-300">{num(props.hovered?.high, 4)}</span></span>
        <span className="text-zinc-400">L <span className="text-rose-300">{num(props.hovered?.low, 4)}</span></span>
        <span className="text-zinc-400">C <span className="text-zinc-100">{num(props.hovered?.close, 4)}</span></span>
        <span className="text-zinc-400">V <span className="text-zinc-100">{num(props.hovered?.volume, 2)}</span></span>
      </div>
      <div className="relative space-y-3">
        {hoveredEvent ? (
          <div className="pointer-events-none absolute left-4 top-4 z-10 min-w-[240px] rounded-2xl border border-zinc-800 bg-zinc-950/95 p-4 text-xs shadow-2xl">
            <div className="grid grid-cols-[56px,1fr] gap-x-3 gap-y-2 text-zinc-300">
              <span className="text-zinc-500">ID</span><span>{hoveredEvent.id || "--"}</span>
              <span className="text-zinc-500">品种</span><span>{hoveredEvent.symbol || "--"}</span>
              <span className="text-zinc-500">类型</span><span className={(hoveredEvent.marker || "").includes("short") ? "text-rose-400" : "text-emerald-400"}>{hoveredEvent.marker || hoveredEvent.label}</span>
              <span className="text-zinc-500">状态</span><span>{hoveredEvent.status || "完成"}</span>
              <span className="text-zinc-500">价格</span><span>{num(hoveredEvent.price, 4)}</span>
              <span className="text-zinc-500">均价</span><span>{num(hoveredEvent.averagePrice ?? hoveredEvent.price, 4)}</span>
              <span className="text-zinc-500">数量</span><span>{num(hoveredEvent.quantity, 6)}</span>
              <span className="text-zinc-500">手续费</span><span>{num(hoveredEvent.fee, 9)}</span>
              <span className="text-zinc-500">时间</span><span>{hoveredEvent.time ? formatDateTime(hoveredEvent.time) : "--"}</span>
              <span className="text-zinc-500">成交时间</span><span>{hoveredEvent.completedAt ? formatDateTime(hoveredEvent.completedAt) : "--"}</span>
            </div>
          </div>
        ) : null}
        <div ref={mainRef} className="h-[480px] w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/40" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <div className="font-medium text-zinc-100">成交量</div>
            <div className="text-xs text-zinc-500">{num(props.hovered?.volume, 2)}</div>
          </div>
          <div ref={volumeRef} className="h-[160px] w-full overflow-hidden" />
        </div>
      </div>
    </div>
  );
}

export function BacktestRunsPanel(props: {
  selectedStrategy: Strategy | null;
  backtests: BacktestRun[];
  latestRun: BacktestRun | null;
  busy: boolean;
  loadingRunDetail?: boolean;
  config: BacktestConfig;
  onConfigChange: (config: BacktestConfig) => void;
  onRunBacktest: () => void;
}) {
  const [tab, setTab] = useState<"runtime" | "orders" | "market">("runtime");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const latestRun = props.latestRun;
  const active = latestRun?.status === "queued" || latestRun?.status === "running";
  const effectivePeriod = useMemo(
    () => parsePeriod(latestRun?.summary?.period ?? latestRun?.params?.period ?? `${props.config.periodValue}${props.config.periodUnit}`),
    [latestRun?.params, latestRun?.summary?.period, props.config.periodUnit, props.config.periodValue]
  );
  const effectiveBasePeriod = useMemo(
    () => parsePeriod(latestRun?.summary?.basePeriod ?? latestRun?.params?.basePeriod ?? `${props.config.basePeriodValue}${props.config.basePeriodUnit}`),
    [latestRun?.params, latestRun?.summary?.basePeriod, props.config.basePeriodUnit, props.config.basePeriodValue]
  );
  const marketRows = useMemo(
    () => latestRun?.marketRows?.length ? latestRun.marketRows : (latestRun?.equityCurve || []).map((p) => ({ time: p.time, lastPrice: 0, equity: p.equity, events: [] })),
    [latestRun]
  );
  const candles = useMemo(() => buildCandles(marketRows, effectivePeriod.value, effectivePeriod.unit), [effectivePeriod.unit, effectivePeriod.value, marketRows]);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const hovered = useMemo(() => candles.find((item) => item.time === hoverTime) || candles[candles.length - 1] || null, [candles, hoverTime]);
  const trades = useMemo(() => [...(latestRun?.trades || [])].reverse(), [latestRun?.trades]);
  const logs = useMemo(() => [...(latestRun?.logs || [])].reverse(), [latestRun?.logs]);
  const overview = useMemo(() => {
    if (!latestRun) return null;
    const initialCapital = Number((latestRun.params?.initialCapital as number | undefined) ?? props.config.initialCapital ?? 0);
    const endingEquity = Number(latestRun.metrics.endingEquity ?? initialCapital ?? 0);
    const cumulativeReturnPct = Number(latestRun.metrics.totalReturnPct ?? 0);
    const curve = latestRun.equityCurve || [];
    const elapsedMs = Number(latestRun.summary?.durationMs ?? ((curve.at(-1)?.time || 0) - (curve[0]?.time || 0)));
    const elapsedDays = elapsedMs > 0 ? elapsedMs / (1000 * 60 * 60 * 24) : 0;
    const annualReturnPct =
      initialCapital > 0 && endingEquity > 0 && elapsedDays > 0
        ? (Math.pow(endingEquity / initialCapital, 365 / elapsedDays) - 1) * 100
        : cumulativeReturnPct;
    const returns = curve
      .slice(1)
      .map((point, index) => {
        const prev = curve[index]?.equity ?? 0;
        return prev > 0 ? (point.equity - prev) / prev : 0;
      })
      .filter((value) => Number.isFinite(value));
    const volatilityPct = stddev(returns) * Math.sqrt(periodsPerYear(effectivePeriod.unit, effectivePeriod.value)) * 100;
    return {
      initialCapital,
      endingEquity,
      cumulativeReturnPct,
      annualReturnPct,
      sharpe: Number(latestRun.metrics.sharpe ?? 0),
      maxDrawdownPct: Number(latestRun.metrics.maxDrawdownPct ?? 0),
      volatilityPct,
      tradeCount: Number(latestRun.metrics.trades ?? 0),
      orderCount: Number(latestRun.summary?.orderCount ?? latestRun.metrics.trades ?? 0),
      barCount: Number(latestRun.summary?.barCount ?? candles.length),
    };
  }, [candles.length, effectivePeriod.unit, effectivePeriod.value, latestRun, props.config.initialCapital]);
  const overviewData = useMemo(() => {
    if (!latestRun) return [];
    const initialCapital = Number((latestRun.params?.initialCapital as number | undefined) ?? props.config.initialCapital ?? 0);
    return buildOverviewSeries(marketRows, candles, initialCapital);
  }, [candles, latestRun, marketRows, props.config.initialCapital]);

  if (!props.selectedStrategy) return null;

  const setConfig = <K extends keyof BacktestConfig>(key: K, value: BacktestConfig[K]) => props.onConfigChange({ ...props.config, [key]: value });

  const basicFields = (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Field label="开始时间" help="回测起始时间，格式为 YYYY-MM-DD HH:mm:ss。" value={props.config.startTime} onChange={(v) => setConfig("startTime", v)} />
      <Field label="结束时间" help="回测结束时间，格式为 YYYY-MM-DD HH:mm:ss。" value={props.config.endTime} onChange={(v) => setConfig("endTime", v)} />
      <Field label="K线周期值" help="主图周期值，例如 4 配合小时就是 4h。" value={props.config.periodValue} type="number" onChange={(v) => setConfig("periodValue", Number(v) || 1)} />
      <Field label="K线周期单位" help="主回测周期单位。" value={props.config.periodUnit} onChange={(v) => setConfig("periodUnit", v as "m" | "h" | "d")} options={[{ value: "m", label: "分钟" }, { value: "h", label: "小时" }, { value: "d", label: "天" }]} />
      <Field label="交易所" help="选择 FMZ 回测连接的交易所环境。" value={props.config.brokerTarget} onChange={(v) => setConfig("brokerTarget", v)} options={[{ value: "binance:production", label: "币安期货 / 正式" }, { value: "binance:sandbox", label: "币安期货 / 沙箱" }, { value: "okx:production", label: "OKX 合约 / 正式" }, { value: "okx:sandbox", label: "OKX 合约 / 沙箱" }]} />
      <Field label="模式" help="回测运行模式，默认使用模拟级。" value={props.config.mode} onChange={(v) => setConfig("mode", v)} options={[{ value: "模拟级", label: "模拟级" }, { value: "实盘级", label: "实盘级" }]} />
      <Field label="交易对" help="当前策略绑定的交易对。" value={props.selectedStrategy.symbol} onChange={() => undefined} readOnly />
      <Field label="计价货币" help="收益和权益统计使用的计价货币。" value={props.config.quoteAsset} onChange={(v) => setConfig("quoteAsset", v)} />
      <Field label="初始资金" help="回测初始账户资金。" value={props.config.initialCapital} type="number" onChange={(v) => setConfig("initialCapital", Number(v) || 0)} />
      <Field label="分发" help="回测执行分发器配置。" value={props.config.distributor} onChange={(v) => setConfig("distributor", v)} />
    </div>
  );

  const advancedFields = (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Field label="日志" help="最大运行日志条数。" value={props.config.logLimit} type="number" onChange={(v) => setConfig("logLimit", Number(v) || 0)} />
      <Field label="收益" help="最大收益日志或收益点数量。" value={props.config.profitLimit} type="number" onChange={(v) => setConfig("profitLimit", Number(v) || 0)} />
      <Field label="图表" help="图表可保留的最大 K 线数量。" value={props.config.chartBars} type="number" onChange={(v) => setConfig("chartBars", Number(v) || 0)} />
      <Field label="低层K线周期值" help="底层撮合或辅助周期值。" value={props.config.basePeriodValue} type="number" onChange={(v) => setConfig("basePeriodValue", Number(v) || 1)} />
      <Field label="低层K线周期单位" help="底层撮合或辅助周期单位。" value={props.config.basePeriodUnit} onChange={(v) => setConfig("basePeriodUnit", v as "m" | "h" | "d")} options={[{ value: "m", label: "分钟" }, { value: "h", label: "小时" }, { value: "d", label: "天" }]} />
      <Field label="滑点" help="每次成交模拟的滑点点数。" value={props.config.slippagePoints} type="number" onChange={(v) => setConfig("slippagePoints", Number(v) || 0)} />
      <Field label="容错" help="订单撮合容错百分比。" value={props.config.tolerancePct} type="number" onChange={(v) => setConfig("tolerancePct", Number(v) || 0)} />
      <Field label="延迟" help="撮合网络延迟，单位毫秒。" value={props.config.delayMs} type="number" onChange={(v) => setConfig("delayMs", Number(v) || 0)} />
      <Field label="K线数量" help="单次请求保留的 K 线数量上限。" value={props.config.candleLimit} type="number" onChange={(v) => setConfig("candleLimit", Number(v) || 0)} />
      <Field label="开仓手续费" help="开仓手续费百分比。" value={props.config.openFeePct} type="number" onChange={(v) => setConfig("openFeePct", Number(v) || 0)} />
      <Field label="平仓手续费" help="平仓手续费百分比。" value={props.config.closeFeePct} type="number" onChange={(v) => setConfig("closeFeePct", Number(v) || 0)} />
      <Field label="图表显示" help="回测图表显示模式。" value={props.config.chartDisplay} onChange={(v) => setConfig("chartDisplay", v)} options={[{ value: "显示", label: "显示" }, { value: "隐藏", label: "隐藏" }]} />
      <Field label="深度最小" help="回测深度的最小值。" value={props.config.depthMin} type="number" onChange={(v) => setConfig("depthMin", Number(v) || 0)} />
      <Field label="深度最大" help="回测深度的最大值。" value={props.config.depthMax} type="number" onChange={(v) => setConfig("depthMax", Number(v) || 0)} />
      <Field label="数据源" help="FMZ 回测所使用的数据源。" value={props.config.dataSource} onChange={(v) => setConfig("dataSource", v)} options={[{ value: "默认", label: "默认" }, { value: "交易所", label: "交易所" }]} />
      <Field label="订单模式" help="订单撮合模式。" value={props.config.orderMode} onChange={(v) => setConfig("orderMode", v)} options={[{ value: "已成交", label: "已成交" }, { value: "挂单成交", label: "挂单成交" }]} />
      <label className="flex h-11 items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <span>记录事件</span>
          <Help text="开启后会记录更多买卖事件，并显示到图表标记中。" />
        </div>
        <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={props.config.recordEvents} onChange={(event) => setConfig("recordEvents", event.target.checked)} />
      </label>
    </div>
  );

  return (
    <Card className="border-zinc-800 bg-zinc-950/90">
      <div className="space-y-6 p-6 xl:p-7">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-zinc-50">回测参数</h2>
              <Badge variant="success">{props.selectedStrategy.symbol}</Badge>
              <Badge variant="default">{props.selectedStrategy.marketType === "futures" ? "合约" : "现货"}</Badge>
              <Badge variant="default">{props.selectedStrategy.template === "python" ? "FMZ Python" : props.selectedStrategy.template}</Badge>
            </div>
            <p className="max-w-3xl text-sm text-zinc-500">基础参数常驻显示，更多参数可展开细调，问号悬停会显示中文解释。</p>
          </div>
          <Button onClick={props.onRunBacktest} disabled={props.busy || active}>{active ? "回测运行中..." : props.busy ? "提交中..." : "开始回测"}</Button>
        </div>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
          {basicFields}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setShowAdvanced((value) => !value)}>
              {showAdvanced ? "收起更多参数" : "更多参数"}
            </Button>
          </div>
          {showAdvanced ? advancedFields : null}
        </div>

        {latestRun ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Metric label="收益率" value={pct(latestRun.metrics.totalReturnPct)} tone={latestRun.metrics.totalReturnPct >= 0 ? "good" : "bad"} />
              <Metric label="夏普比率" value={num(latestRun.metrics.sharpe, 2)} />
              <Metric label="最大回撤" value={pct(latestRun.metrics.maxDrawdownPct)} tone="warn" />
              <Metric label="交易次数" value={latestRun.metrics.trades} />
              <Metric label="期末权益" value={formatMoney(latestRun.metrics.endingEquity)} />
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-100">资产结果</div>
                <Badge variant="default">{props.config.quoteAsset}</Badge>
              </div>
              <Table>
                <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>品种</TableHead><TableHead>余额</TableHead><TableHead>冻结</TableHead><TableHead>手续费</TableHead><TableHead>交费</TableHead><TableHead>平仓盈亏</TableHead><TableHead>持仓盈亏</TableHead><TableHead>保证金</TableHead><TableHead>预估收益</TableHead></TableRow></TableHeader>
                <TableBody>
                  {latestRun.assetRows?.length ? latestRun.assetRows.map((row) => <TableRow key={`${row.name}-${row.asset}`}><TableCell>{row.name}</TableCell><TableCell>{row.asset}</TableCell><TableCell>{num(row.balance, 6)}</TableCell><TableCell>{num(row.frozen, 6)}</TableCell><TableCell>{num(row.fees, 6)}</TableCell><TableCell>{num(row.equity, 6)}</TableCell><TableCell>{num(row.realizedPnl, 6)}</TableCell><TableCell>{num(row.positionPnl, 6)}</TableCell><TableCell>{num(row.margin, 6)}</TableCell><TableCell>{`${row.asset} ${num(row.estimatedProfit, 6)}`}</TableCell></TableRow>) : <TableRow><TableCell colSpan={10} className="text-center text-zinc-500">当前还没有资产结果。</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-zinc-100">行情数据</div>
                  <div className="mt-1 text-xs text-zinc-500">图表区域已放大，右侧状态卡挪到下方。</div>
                </div>
                <div className="text-xs text-zinc-500">
                  本次回测周期 {`${effectivePeriod.value}${effectivePeriod.unit}`}，底层周期 {`${effectiveBasePeriod.value}${effectiveBasePeriod.unit}`}。
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="default">{latestRun.source || "fmz-official-local"}</Badge>
                  <Badge variant="success">{`${effectivePeriod.value}${effectivePeriod.unit}`}</Badge>
                  <Badge variant="outline">{`底层 ${effectiveBasePeriod.value}${effectiveBasePeriod.unit}`}</Badge>
                </div>
              </div>
              {candles.length ? <ChartPanel candles={candles} hovered={hovered} onHover={setHoverTime} interval={`${effectivePeriod.value}${effectivePeriod.unit}`} /> : <div className="flex h-[640px] items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-500">当前还没有行情数据。</div>}
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-4 text-sm font-medium text-zinc-100">状态信息</div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                <Metric label="状态码" value={latestRun.statusInfo?.backtestStatus ?? "--"} />
                <Metric label="日志条数" value={latestRun.statusInfo?.logsCount ?? 0} />
                <Metric label="最新价" value={num(latestRun.statusInfo?.lastPrice, 4)} />
                <Metric label="利用率" value={pct((latestRun.statusInfo?.utilization || 0) * 100)} />
                <Metric label="多头" value={num(latestRun.statusInfo?.longAmount, 4)} />
                <Metric label="空头" value={num(latestRun.statusInfo?.shortAmount, 4)} />
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-100">收益概览</div>
                <Badge variant="default">{latestRun.source || "fmz-official-local"}</Badge>
              </div>
              {overview && overviewData.length ? (
                <OverviewPanel
                  symbol={`${props.config.brokerTarget.replace(":", ".")}.${props.selectedStrategy.symbol}`}
                  summary={overview}
                  data={overviewData}
                />
              ) : (
                <div className="text-sm text-zinc-500">当前还没有收益概览数据。</div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-100">日志信息</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={tab === "runtime" ? "default" : "outline"} onClick={() => setTab("runtime")}>回测日志</Button>
                  <Button size="sm" variant={tab === "orders" ? "default" : "outline"} onClick={() => setTab("orders")}>订单表格</Button>
                  <Button size="sm" variant={tab === "market" ? "default" : "outline"} onClick={() => setTab("market")}>行情表格</Button>
                </div>
              </div>

              {tab === "runtime" ? (
                <div className="max-h-[340px] space-y-2 overflow-auto pr-1">
                  {logs.length ? logs.map((log, index) => <div key={`${log.time}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs"><div className="flex items-center justify-between gap-3"><span className={log.level === "event" || log.message.includes("[Event]") ? "text-rose-400" : "text-zinc-300"}>{log.message}</span><span className="shrink-0 text-zinc-500">{formatDateTime(log.time)}</span></div></div>) : <div className="text-sm text-zinc-500">当前还没有日志输出。</div>}
                </div>
              ) : null}

              {tab === "orders" ? (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => downloadTrades(props.selectedStrategy.symbol, latestRun)} disabled={!latestRun.trades?.length}>下载订单表格</Button>
                  </div>
                  <Table>
                    <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>类型</TableHead><TableHead>价格</TableHead><TableHead>数量</TableHead><TableHead>PNL</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {trades.length ? trades.map((trade) => <TableRow key={trade.id || `${trade.time}-${trade.side}`}><TableCell>{formatDateTime(trade.time)}</TableCell><TableCell>{trade.label || trade.side}</TableCell><TableCell>{num(trade.price, 4)}</TableCell><TableCell>{num(trade.quantity, 6)}</TableCell><TableCell>{num(trade.pnl, 6)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="text-center text-zinc-500">当前还没有订单数据。</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              ) : null}

              {tab === "market" ? (
                <Table>
                  <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>最新价</TableHead><TableHead>权益</TableHead><TableHead>事件</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {marketRows.length ? marketRows.slice(-16).reverse().map((row) => <TableRow key={row.time}><TableCell>{formatDateTime(row.time)}</TableCell><TableCell>{num(row.lastPrice, 4)}</TableCell><TableCell>{formatMoney(row.equity)}</TableCell><TableCell>{row.events?.map((event) => event.marker || event.label).join(", ") || "--"}</TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="text-center text-zinc-500">当前还没有行情数据。</TableCell></TableRow>}
                  </TableBody>
                </Table>
              ) : null}

            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20 px-6 py-12 text-center text-sm text-zinc-500">先配置参数并运行一次回测，结果区会显示收益概览、K线图、日志和订单表格。</div>
        )}
      </div>
    </Card>
  );
}
