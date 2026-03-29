import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Badge, Button, Card } from "./ui";
import { authorizedFetch, formatDateTime, PLATFORM_API_BASE } from "../lib/platform-client";

type MarketId = "a_share" | "crypto";
type MainOverlay = "ma7" | "ma20";
type SubIndicator = "volume" | "macd" | "rsi14";

type SourceStatus = {
  sourceId: string;
  label: string;
  ok: boolean;
  detail: string;
  updatedAt: number;
};

type MarketCatalog = {
  generatedAt: number;
  sources: SourceStatus[];
  markets: Array<{
    market: MarketId;
    label: string;
    defaultSymbol: string;
    defaultInterval: string;
    intervals: string[];
    symbols?: Array<{ symbol: string; label: string; kind: string }>;
    defaultExchangeId?: string;
    exchanges?: Array<{ exchangeId: string; label: string; symbols: Array<{ symbol: string; label: string }> }>;
  }>;
};

type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma7?: number | null;
  ma20?: number | null;
  macd?: number | null;
  signal?: number | null;
  histogram?: number | null;
  rsi14?: number | null;
};

type MarketSeries = {
  generatedAt: number;
  market: MarketId;
  label: string;
  exchangeId: string;
  exchangeLabel: string;
  symbol: string;
  symbolLabel: string;
  interval: string;
  source: SourceStatus;
  snapshot: {
    label: string;
    symbol: string;
    last: number;
    changePct: number;
    high: number;
    low: number;
    volume: number;
    quoteVolume: number;
    turnoverLabel: string;
  };
  candles: Candle[];
  indicators: {
    trend: string;
    macdState: string;
    rsiState: string;
    latest: Record<string, number | null>;
    delta: {
      closeChangePct: number;
      volumeChangePct: number;
    };
  };
  availableIndicators: string[];
};

type ChartPaneProps = {
  series: MarketSeries | null;
  mainOverlays: MainOverlay[];
  subIndicators: SubIndicator[];
  canLoadMore: boolean;
  onNeedMore: () => void;
  resetToken: number;
  onHoverCandleChange: (candle: Candle | null) => void;
};

function formatNumber(value: number | null | undefined, digits = 2) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value ?? 0);
}

function formatCompact(value: number | null | undefined) {
  const next = Number(value || 0);
  if (Math.abs(next) >= 1_000_000_000) return `${(next / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(next) >= 1_000_000) return `${(next / 1_000_000).toFixed(2)}M`;
  if (Math.abs(next) >= 1_000) return `${(next / 1_000).toFixed(2)}K`;
  return formatNumber(next);
}

function toneClass(value: number) {
  if (value > 0) return "text-rose-400";
  if (value < 0) return "text-emerald-400";
  return "text-zinc-300";
}

function intervalLabel(value: string) {
  if (value.endsWith("m")) return `${value.slice(0, -1)} 分钟`;
  if (value.endsWith("h")) return `${value.slice(0, -1)} 小时`;
  if (value.endsWith("d")) return `${value.slice(0, -1)} 天`;
  if (value.endsWith("w")) return `${value.slice(0, -1)} 周`;
  return value;
}

function isDateInterval(interval: string) {
  return interval.endsWith("d") || interval.endsWith("w");
}

function toChartTime(ts: number, interval: string): Time {
  if (isDateInterval(interval)) {
    const date = new Date(ts);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  return Math.floor(ts / 1000) as UTCTimestamp;
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

function formatCandleTime(ts: number, interval: string) {
  const date = new Date(ts);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return isDateInterval(interval)
    ? `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()}`
    : `${date.getFullYear()}\\${date.getMonth() + 1}\\${date.getDate()} ${hour}:${minute}`;
}

function getSubIndicatorLabel(indicator: SubIndicator) {
  if (indicator === "volume") return "成交量";
  if (indicator === "macd") return "MACD";
  return "RSI";
}

function getIndicatorValueLabel(series: MarketSeries | null, indicator: SubIndicator) {
  if (!series) return "--";
  if (indicator === "volume") return series.snapshot.turnoverLabel || formatCompact(series.snapshot.volume);
  if (indicator === "macd") {
    return `DIF ${formatNumber(series.indicators.latest.macd, 3)} / DEA ${formatNumber(series.indicators.latest.signal, 3)}`;
  }
  return formatNumber(series.indicators.latest.rsi14, 2);
}
function ChartPane({ series, mainOverlays, subIndicators, canLoadMore, onNeedMore, resetToken, onHoverCandleChange }: ChartPaneProps) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const volumeRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);

  const activeIndicators = useMemo(
    () => (["volume", "macd", "rsi14"] as SubIndicator[]).filter((item) => subIndicators.includes(item)),
    [subIndicators]
  );

  useEffect(() => {
    if (!series?.candles.length || !mainRef.current) return;

    const panes: Array<{ key: string; chart: ReturnType<typeof createChart>; syncSeries: any; valueByTime: Map<string, number> }> = [];
    const observers: ResizeObserver[] = [];
    let syncingRange = false;
    let syncingCrosshair = false;

    const createBaseChart = (container: HTMLDivElement, height: number, showTimeAxis: boolean) => {
      const chart = createChart(container, {
        width: Math.max(container.clientWidth, 320),
        height,
        layout: {
          background: { type: ColorType.Solid, color: "#09090b" },
          textColor: "#a1a1aa",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(63,63,70,0.35)" },
          horzLines: { color: "rgba(63,63,70,0.35)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { width: 1, color: "rgba(161,161,170,0.75)", style: 2, labelBackgroundColor: "#18181b" },
          horzLine: { width: 1, color: "rgba(161,161,170,0.6)", style: 2, labelBackgroundColor: "#18181b" },
        },
        rightPriceScale: {
          borderColor: "rgba(63,63,70,0.5)",
          scaleMargins: showTimeAxis ? { top: 0.08, bottom: 0.14 } : { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderColor: "rgba(63,63,70,0.5)",
          tickMarkFormatter: (time) => formatAxisTime(time, series.interval),
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 8,
          barSpacing: 8,
          minBarSpacing: 0.35,
          visible: showTimeAxis,
          ticksVisible: showTimeAxis,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: { time: true, price: true },
          axisDoubleClickReset: { time: true, price: true },
        },
      });

      const observer = new ResizeObserver(() => chart.applyOptions({ width: Math.max(container.clientWidth, 320) }));
      observer.observe(container);
      observers.push(observer);
      return chart;
    };

    const candlesWithTime = series.candles.map((candle) => ({ candle, time: toChartTime(candle.ts, series.interval) }));
    const candleData = candlesWithTime.map(({ candle, time }) => ({ time, open: candle.open, high: candle.high, low: candle.low, close: candle.close }));
    const closeByTime = new Map<string, number>(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle.close]));
    const volumeData = candlesWithTime.map(({ candle, time }) => ({ time, value: candle.volume, color: candle.close >= candle.open ? "#f87171" : "#34d399" }));
    const volumeByTime = new Map<string, number>(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle.volume]));
    const macdData = candlesWithTime.filter(({ candle }) => typeof candle.macd === "number").map(({ candle, time }) => ({ time, value: Number(candle.macd) }));
    const signalData = candlesWithTime.filter(({ candle }) => typeof candle.signal === "number").map(({ candle, time }) => ({ time, value: Number(candle.signal) }));
    const histogramData = candlesWithTime.filter(({ candle }) => typeof candle.histogram === "number").map(({ candle, time }) => ({ time, value: Number(candle.histogram), color: Number(candle.histogram) >= 0 ? "#60a5fa" : "#f97316" }));
    const macdByTime = new Map<string, number>();
    for (const { candle, time } of candlesWithTime) {
      const candidate = candle.macd ?? candle.signal ?? candle.histogram;
      if (typeof candidate === "number") macdByTime.set(timeKey(time), Number(candidate));
    }
    const rsiData = candlesWithTime.filter(({ candle }) => typeof candle.rsi14 === "number").map(({ candle, time }) => ({ time, value: Number(candle.rsi14) }));
    const rsiByTime = new Map<string, number>();
    for (const { candle, time } of candlesWithTime) {
      if (typeof candle.rsi14 === "number") rsiByTime.set(timeKey(time), Number(candle.rsi14));
    }

    const mainChart = createBaseChart(mainRef.current, 430, true);
    const lastIndicator = activeIndicators[activeIndicators.length - 1];
    const mainSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: "#ef4444",
      downColor: "#10b981",
      borderUpColor: "#ef4444",
      borderDownColor: "#10b981",
      wickUpColor: "#ef4444",
      wickDownColor: "#10b981",
      lastValueVisible: true,
      priceLineVisible: true,
    });
    mainSeries.setData(candleData);

    if (mainOverlays.includes("ma7")) {
      const line = mainChart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      line.setData(candlesWithTime.filter(({ candle }) => typeof candle.ma7 === "number").map(({ candle, time }) => ({ time, value: Number(candle.ma7) })));
    }
    if (mainOverlays.includes("ma20")) {
      const line = mainChart.addSeries(LineSeries, { color: "#fbbf24", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      line.setData(candlesWithTime.filter(({ candle }) => typeof candle.ma20 === "number").map(({ candle, time }) => ({ time, value: Number(candle.ma20) })));
    }
    panes.push({ key: "main", chart: mainChart, syncSeries: mainSeries, valueByTime: closeByTime });

    if (activeIndicators.includes("volume") && volumeRef.current) {
      const chart = createBaseChart(volumeRef.current, 168, lastIndicator === "volume");
      const seriesApi = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, lastValueVisible: true, priceLineVisible: false });
      seriesApi.setData(volumeData);
      panes.push({ key: "volume", chart, syncSeries: seriesApi, valueByTime: volumeByTime });
    }

    if (activeIndicators.includes("macd") && macdRef.current) {
      const chart = createBaseChart(macdRef.current, 168, lastIndicator === "macd");
      const bar = chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false });
      bar.setData(histogramData);
      const dif = chart.addSeries(LineSeries, { color: "#f97316", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      dif.setData(macdData);
      const dea = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dea.setData(signalData);
      dif.createPriceLine({ price: 0, color: "#71717a", lineStyle: 2, axisLabelVisible: false, title: "" });
      panes.push({ key: "macd", chart, syncSeries: dif, valueByTime: macdByTime });
    }

    if (activeIndicators.includes("rsi14") && rsiRef.current) {
      const chart = createBaseChart(rsiRef.current, 168, lastIndicator === "rsi14");
      const seriesApi = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      seriesApi.setData(rsiData);
      seriesApi.createPriceLine({ price: 70, color: "#f59e0b", lineStyle: 2, axisLabelVisible: false, title: "" });
      seriesApi.createPriceLine({ price: 30, color: "#10b981", lineStyle: 2, axisLabelVisible: false, title: "" });
      panes.push({ key: "rsi14", chart, syncSeries: seriesApi, valueByTime: rsiByTime });
    }

    const candleByTime = new Map<string, Candle>(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle]));

    const syncVisibleRange = (sourceKey: string) => (range: { from: number; to: number } | null) => {
      if (!range || syncingRange) return;
      if (sourceKey === "main" && canLoadMore && range.from < 40) onNeedMore();
      syncingRange = true;
      for (const pane of panes) {
        if (pane.key !== sourceKey) pane.chart.timeScale().setVisibleLogicalRange(range);
      }
      syncingRange = false;
    };

    const syncCrosshair = (sourceKey: string) => (param: MouseEventParams<Time>) => {
      if (syncingCrosshair) return;
      syncingCrosshair = true;
      const time = param.time ?? null;
      if (sourceKey === "main") onHoverCandleChange(time === null ? null : candleByTime.get(timeKey(time)) || null);
      for (const pane of panes) {
        if (pane.key === sourceKey) continue;
        if (time === null) {
          pane.chart.clearCrosshairPosition();
          continue;
        }
        const value = pane.valueByTime.get(timeKey(time));
        if (typeof value === "number" && Number.isFinite(value)) pane.chart.setCrosshairPosition(value, time, pane.syncSeries);
        else pane.chart.clearCrosshairPosition();
      }
      syncingCrosshair = false;
    };

    for (const pane of panes) {
      pane.chart.timeScale().subscribeVisibleLogicalRangeChange(syncVisibleRange(pane.key));
      pane.chart.subscribeCrosshairMove(syncCrosshair(pane.key));
    }

    const totalBars = series.candles.length;
    mainChart.timeScale().setVisibleLogicalRange({ from: Math.max(totalBars - 320, 0), to: totalBars + 8 });
    onHoverCandleChange(series.candles.at(-1) || null);

    return () => {
      onHoverCandleChange(null);
      for (const observer of observers) observer.disconnect();
      for (const pane of panes) pane.chart.remove();
    };
  }, [series, mainOverlays, activeIndicators, canLoadMore, onNeedMore, resetToken, onHoverCandleChange]);

  if (!series?.candles.length) return <div className="h-[430px] rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/50" />;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
          <div className="font-medium text-zinc-100">{series.symbolLabel} · {series.exchangeLabel} · {intervalLabel(series.interval)}</div>
          <div className="text-zinc-500">开 <span className="text-zinc-200">{formatNumber(series.candles.at(-1)?.open)}</span></div>
          <div className="text-zinc-500">高 <span className="text-zinc-200">{formatNumber(series.candles.at(-1)?.high)}</span></div>
          <div className="text-zinc-500">低 <span className="text-zinc-200">{formatNumber(series.candles.at(-1)?.low)}</span></div>
          <div className="text-zinc-500">收 <span className="text-zinc-200">{formatNumber(series.candles.at(-1)?.close)}</span></div>
        </div>
        <div ref={mainRef} className="h-[430px] w-full" />
      </div>

      {activeIndicators.includes("volume") ? <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3"><div className="mb-2 flex items-center justify-between gap-3"><div className="text-sm font-medium text-zinc-100">成交量</div><div className="text-xs text-zinc-500">{getIndicatorValueLabel(series, "volume")}</div></div><div ref={volumeRef} className="h-[168px] w-full" /></div> : null}
      {activeIndicators.includes("macd") ? <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3"><div className="mb-2 flex items-center justify-between gap-3"><div className="text-sm font-medium text-zinc-100">MACD</div><div className="text-xs text-zinc-500">{getIndicatorValueLabel(series, "macd")}</div></div><div ref={macdRef} className="h-[168px] w-full" /></div> : null}
      {activeIndicators.includes("rsi14") ? <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3"><div className="mb-2 flex items-center justify-between gap-3"><div className="text-sm font-medium text-zinc-100">RSI 14</div><div className="text-xs text-zinc-500">{getIndicatorValueLabel(series, "rsi14")}</div></div><div ref={rsiRef} className="h-[168px] w-full" /></div> : null}
    </div>
  );
}
export function MarketWorkspace() {
  const [catalog, setCatalog] = useState<MarketCatalog | null>(null);
  const [series, setSeries] = useState<MarketSeries | null>(null);
  const [market, setMarket] = useState<MarketId>("a_share");
  const [exchangeId, setExchangeId] = useState("binance");
  const [symbol, setSymbol] = useState("000001.SH");
  const [interval, setInterval] = useState("1d");
  const [status, setStatus] = useState("正在加载行情中心...");
  const [loading, setLoading] = useState(false);
  const [mainOverlays, setMainOverlays] = useState<MainOverlay[]>([]);
  const [subIndicators, setSubIndicators] = useState<SubIndicator[]>(["volume", "macd"]);
  const [historyLimit, setHistoryLimit] = useState(800);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const mainOverlayLabels: Record<MainOverlay, string> = { ma7: "MA7", ma20: "MA20" };
  const subIndicatorLabels: Record<SubIndicator, string> = { volume: "成交量", macd: "MACD", rsi14: "RSI" };

  const currentMarket = useMemo(() => catalog?.markets.find((item) => item.market === market) || null, [catalog, market]);
  const currentExchange = useMemo(
    () => currentMarket?.exchanges?.find((item) => item.exchangeId === exchangeId) || currentMarket?.exchanges?.[0] || null,
    [currentMarket, exchangeId]
  );

  const loadCatalog = async (forceRefresh = false) => {
    const next = await authorizedFetch<MarketCatalog>(`${PLATFORM_API_BASE}/market/catalog${forceRefresh ? "?forceRefresh=true" : ""}`, "");
    setCatalog(next);
    return next;
  };

  const loadSeries = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ market, symbol, interval, limit: String(historyLimit), forceRefresh: forceRefresh ? "true" : "false" });
      if (market === "crypto") query.set("exchangeId", exchangeId);
      const next = await authorizedFetch<MarketSeries>(`${PLATFORM_API_BASE}/market/series?${query.toString()}`, "");
      setSeries(next);
      setStatus(next.source.ok ? "行情数据已更新。" : next.source.detail);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载行情失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const next = await loadCatalog();
        const aShare = next.markets.find((item) => item.market === "a_share");
        if (aShare) {
          setSymbol(aShare.defaultSymbol);
          setInterval(aShare.defaultInterval);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载行情目录失败");
      }
    })();
  }, []);

  useEffect(() => {
    if (!catalog) return;
    const target = catalog.markets.find((item) => item.market === market);
    if (!target) return;

    if (market === "a_share") {
      const nextSymbol = target.symbols?.some((item) => item.symbol === symbol) ? symbol : target.defaultSymbol;
      const nextInterval = target.intervals.includes(interval) ? interval : target.defaultInterval;
      if (nextSymbol !== symbol) return void setSymbol(nextSymbol);
      if (nextInterval !== interval) return void setInterval(nextInterval);
    } else {
      const nextExchange = target.exchanges?.some((item) => item.exchangeId === exchangeId) ? exchangeId : target.defaultExchangeId || "binance";
      if (nextExchange !== exchangeId) return void setExchangeId(nextExchange);
      const targetExchange = target.exchanges?.find((item) => item.exchangeId === nextExchange) || target.exchanges?.[0];
      const nextSymbol = targetExchange?.symbols.some((item) => item.symbol === symbol) ? symbol : target.defaultSymbol;
      const nextInterval = target.intervals.includes(interval) ? interval : target.defaultInterval;
      if (nextSymbol !== symbol) return void setSymbol(nextSymbol);
      if (nextInterval !== interval) return void setInterval(nextInterval);
    }

    void loadSeries();
  }, [catalog, market, exchangeId, symbol, interval, historyLimit]);

  const toggleMainOverlay = (value: MainOverlay) => setMainOverlays((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
  const toggleSubIndicator = (value: SubIndicator) => setSubIndicators((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
  const expandHistory = useCallback(() => setHistoryLimit((current) => (loading || current >= 1200 ? current : Math.min(current + 200, 1200))), [loading]);
  const resetView = useCallback(() => {
    setResetToken((current) => current + 1);
    setHoveredCandle(series?.candles.at(-1) || null);
  }, [series]);

  const displayCandle = hoveredCandle || series?.candles.at(-1) || null;
  const candleDelta = displayCandle ? displayCandle.close - displayCandle.open : null;
  const candleDeltaPct = displayCandle && displayCandle.open ? ((displayCandle.close - displayCandle.open) / displayCandle.open) * 100 : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">行情中心</h1>
          <p className="mt-1 text-sm text-zinc-500">独立看 A 股和交易所级别行情，主图与子图共享时间轴，支持缩放与周期切换。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void loadCatalog(true)}>刷新目录</Button>
          <Button variant="outline" onClick={() => void loadSeries(true)} disabled={loading}>{loading ? "刷新中..." : "刷新行情"}</Button>
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.92fr_1.08fr]">
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-zinc-300">市场</label>
                <select value={market} onChange={(e) => setMarket(e.target.value as MarketId)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                  {(catalog?.markets || []).map((item) => <option key={item.market} value={item.market}>{item.label}</option>)}
                </select>
              </div>
              {market === "crypto" ? (
                <div className="space-y-2">
                  <label className="text-sm text-zinc-300">交易所</label>
                  <select value={exchangeId} onChange={(e) => setExchangeId(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                    {(currentMarket?.exchanges || []).map((item) => <option key={item.exchangeId} value={item.exchangeId}>{item.label}</option>)}
                  </select>
                </div>
              ) : <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">A 股行情模块统一使用东方财富，分钟线和日线都走同一套数据源。</div>}
              <div className="space-y-2">
                <label className="text-sm text-zinc-300">标的</label>
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                  {market === "crypto"
                    ? (currentExchange?.symbols || []).map((item) => <option key={item.symbol} value={item.symbol}>{item.label}</option>)
                    : (currentMarket?.symbols || []).map((item) => <option key={item.symbol} value={item.symbol}>{item.label}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-zinc-300">周期</label>
                <select value={interval} onChange={(e) => setInterval(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                  {(currentMarket?.intervals || []).map((item) => <option key={item} value={item}>{intervalLabel(item)}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="text-xs text-zinc-500">最新价</div><div className="mt-2 text-2xl font-semibold text-zinc-50">{formatNumber(series?.snapshot.last)}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="text-xs text-zinc-500">涨跌幅</div><div className={`mt-2 text-2xl font-semibold ${toneClass(series?.snapshot.changePct || 0)}`}>{formatNumber(series?.snapshot.changePct)}%</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="text-xs text-zinc-500">区间高低</div><div className="mt-2 text-sm text-zinc-200">{formatNumber(series?.snapshot.low)} / {formatNumber(series?.snapshot.high)}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="text-xs text-zinc-500">成交额 / 量</div><div className="mt-2 text-sm text-zinc-200">{series?.snapshot.turnoverLabel || "--"}</div></div>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-zinc-100">{series?.symbolLabel || "--"}</div>
                <div className="mt-1 text-xs text-zinc-500">{series?.exchangeLabel || "--"} · {series?.interval ? intervalLabel(series.interval) : "--"}</div>
              </div>
              <Badge variant={series?.source.ok ? "success" : "warning"}>{series?.source.ok ? "在线" : "回退"}</Badge>
            </div>
            <div className="text-sm text-zinc-400">{series?.source.detail || "等待行情源返回..."}</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">趋势</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.trend || "--"}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">MACD</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.macdState || "--"}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">RSI</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.rsiState || "--"}</div></div>
            </div>
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-3 text-xs leading-6 text-zinc-500">支持周期切换、滚轮缩放、拖拽平移，以及主图和子图统一十字线联动。</div>
            <div className="text-xs text-zinc-500">更新时间：{series?.generatedAt ? formatDateTime(series.generatedAt) : "--"}</div>
          </div>
        </div>
      </Card>
      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">联动图表</h2>
            <p className="mt-1 text-sm text-zinc-500">主图指标和子图都是可选项，时间轴统一，默认拉取更长的 800 根 K 线。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["ma7", "ma20"] as MainOverlay[]).map((item) => <button key={item} onClick={() => toggleMainOverlay(item)} className={`rounded-lg border px-3 py-1.5 text-sm transition ${mainOverlays.includes(item) ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600"}`}>{mainOverlayLabels[item]}</button>)}
            {(["volume", "macd", "rsi14"] as SubIndicator[]).map((item) => <button key={item} onClick={() => toggleSubIndicator(item)} className={`rounded-lg border px-3 py-1.5 text-sm transition ${subIndicators.includes(item) ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600"}`}>{subIndicatorLabels[item]}</button>)}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3 text-xs">
          <div className="text-zinc-500">时间 <span className="ml-1 text-zinc-200">{displayCandle ? formatCandleTime(displayCandle.ts, series?.interval || "1d") : "--"}</span></div>
          <div className="text-zinc-500">开 <span className="ml-1 text-zinc-200">{displayCandle ? formatNumber(displayCandle.open) : "--"}</span></div>
          <div className="text-zinc-500">高 <span className="ml-1 text-zinc-200">{displayCandle ? formatNumber(displayCandle.high) : "--"}</span></div>
          <div className="text-zinc-500">低 <span className="ml-1 text-zinc-200">{displayCandle ? formatNumber(displayCandle.low) : "--"}</span></div>
          <div className="text-zinc-500">收 <span className="ml-1 text-zinc-200">{displayCandle ? formatNumber(displayCandle.close) : "--"}</span></div>
          <div className="text-zinc-500">涨跌 <span className={`ml-1 ${toneClass(candleDelta || 0)}`}>{candleDelta !== null ? formatNumber(candleDelta) : "--"}</span></div>
          <div className="text-zinc-500">涨跌幅 <span className={`ml-1 ${toneClass(candleDeltaPct || 0)}`}>{candleDeltaPct !== null ? `${formatNumber(candleDeltaPct)}%` : "--"}</span></div>
          <div className="text-zinc-500">量 <span className="ml-1 text-zinc-200">{displayCandle ? formatCompact(displayCandle.volume) : "--"}</span></div>
        </div>

        <div className="mt-4"><ChartPane series={series} mainOverlays={mainOverlays} subIndicators={subIndicators} canLoadMore={historyLimit < 1200} onNeedMore={expandHistory} resetToken={resetToken} onHoverCandleChange={setHoveredCandle} /></div>

        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          {(["volume", "macd", "rsi14"] as SubIndicator[]).map((item) => <div key={item} className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3"><div className="text-xs text-zinc-500">{getSubIndicatorLabel(item)}</div><div className="mt-1 text-sm text-zinc-200">{getIndicatorValueLabel(series, item)}</div></div>)}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-3 text-xs text-zinc-500">
          <div>当前历史深度：{historyLimit} 根 K 线。拖到最左侧时会自动继续扩展，最高到 1200 根。</div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={resetView}>回到最新</Button>
            <Button variant="outline" onClick={expandHistory} disabled={loading || historyLimit >= 1200}>{historyLimit >= 1200 ? "已到上限" : "手动加载更多"}</Button>
          </div>
        </div>
      </Card>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">行情源状态</h2>
            <p className="mt-1 text-sm text-zinc-500">这里只看行情数据源，不和新闻源混在一起。</p>
          </div>
          <Badge variant="default">{catalog?.sources.length || 0} 个源</Badge>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {(catalog?.sources || []).map((source) => (
            <div key={source.sourceId} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{source.label}</div><Badge variant={source.ok ? "success" : "warning"}>{source.ok ? "正常" : "注意"}</Badge></div>
              <div className="mt-2 text-sm text-zinc-400">{source.detail}</div>
              <div className="mt-2 text-xs text-zinc-500">{formatDateTime(source.updatedAt)}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
