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
import { Badge, Button, Card } from "../components/common/ui";
import { authorizedFetch, formatDateTime, PLATFORM_API_BASE } from "../lib/platform-client";

const marketCatalogCache: { value: MarketCatalog | null } = { value: null };
const marketBoardCache = new Map<string, MarketBoardPayload>();
const marketSeriesCache = new Map<string, MarketSeries>();

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
    defaultMarketType?: string;
    marketTypes?: Array<{ id: string; label: string }>;
    exchanges?: Array<{
      exchangeId: string;
      label: string;
      symbols?: Array<{ symbol: string; label: string }>;
      symbolsByMarketType?: Record<string, Array<{ symbol: string; label: string }>>;
    }>;
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
  marketType?: string;
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

type SortField = "changePct" | "turnover" | "marketCap";
type SortDirection = "asc" | "desc";

type MarketListRow = {
  symbol: string;
  label: string;
  kind: string;
  exchangeId: string;
  exchangeLabel: string;
  last: number;
  changePct: number;
  turnover: number;
  turnoverLabel: string;
  marketCap: number;
  marketCapLabel: string;
  sourceOk: boolean;
};

type MarketBoardPayload = {
  market: MarketId;
  marketType?: string;
  label: string;
  generatedAt: number;
  total?: number;
  page?: number;
  pageSize?: number;
  source: SourceStatus;
  items: MarketListRow[];
};

type ChartPaneProps = {
  series: MarketSeries | null;
  mainOverlays: MainOverlay[];
  subIndicators: SubIndicator[];
  canLoadMore: boolean;
  onNeedMore: () => void;
  onHoverCandleChange: (candle: Candle | null) => void;
  onRegisterReset: (handler: (() => void) | null) => void;
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

function listToneClass(value: number) {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
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
const ChartPane = React.memo(function ChartPane({ series, mainOverlays, subIndicators, canLoadMore, onNeedMore, onHoverCandleChange, onRegisterReset }: ChartPaneProps) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const volumeRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const mainChartApiRef = useRef<any>(null);
  const mainSeriesRef = useRef<any>(null);
  const ma7SeriesRef = useRef<any>(null);
  const ma20SeriesRef = useRef<any>(null);
  const mainOverlaysRef = useRef<MainOverlay[]>(mainOverlays);
  const overlayDataRef = useRef<{ ma7: Array<{ time: Time; value: number }>; ma20: Array<{ time: Time; value: number }> }>({ ma7: [], ma20: [] });
  const closeByTimeRef = useRef<Map<string, number>>(new Map());
  const candleByTimeRef = useRef<Map<string, Candle>>(new Map());
  const subChartEntriesRef = useRef<Array<{ key: SubIndicator; chart: any; syncSeries: any; valueByTime: Map<string, number> }>>([]);
  const syncingRangeRef = useRef(false);
  const syncingCrosshairRef = useRef(false);
  const lastHoverKeyRef = useRef("");

  const activeIndicators = useMemo(
    () => (["volume", "macd", "rsi14"] as SubIndicator[]).filter((item) => subIndicators.includes(item)),
    [subIndicators]
  );

  useEffect(() => {
    mainOverlaysRef.current = mainOverlays;
  }, [mainOverlays]);

  const createBaseChart = useCallback((container: HTMLDivElement, height: number, interval: string, showTimeAxis: boolean) => {
    return createChart(container, {
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
        tickMarkFormatter: (time) => formatAxisTime(time, interval),
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
  }, []);

  const syncMainOverlays = useCallback(() => {
    const chart = mainChartApiRef.current;
    if (!chart) return;

    if (mainOverlaysRef.current.includes("ma7")) {
      if (!ma7SeriesRef.current) {
        ma7SeriesRef.current = chart.addSeries(LineSeries, {
          color: "#38bdf8",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
      }
      ma7SeriesRef.current.setData(overlayDataRef.current.ma7);
    } else if (ma7SeriesRef.current) {
      chart.removeSeries(ma7SeriesRef.current);
      ma7SeriesRef.current = null;
    }

    if (mainOverlaysRef.current.includes("ma20")) {
      if (!ma20SeriesRef.current) {
        ma20SeriesRef.current = chart.addSeries(LineSeries, {
          color: "#fbbf24",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
      }
      ma20SeriesRef.current.setData(overlayDataRef.current.ma20);
    } else if (ma20SeriesRef.current) {
      chart.removeSeries(ma20SeriesRef.current);
      ma20SeriesRef.current = null;
    }
  }, []);

  const syncAllRanges = useCallback((sourceKey: string, range: { from: number; to: number } | null) => {
    if (!range || syncingRangeRef.current) return;
    syncingRangeRef.current = true;
    if (sourceKey !== "main") mainChartApiRef.current?.timeScale().setVisibleLogicalRange(range);
    for (const entry of subChartEntriesRef.current) {
      if (entry.key !== sourceKey) entry.chart.timeScale().setVisibleLogicalRange(range);
    }
    syncingRangeRef.current = false;
  }, []);

  const syncCrosshairAcrossCharts = useCallback((sourceKey: string, time: Time | null) => {
    if (syncingCrosshairRef.current) return;
    syncingCrosshairRef.current = true;

    const nextKey = time === null ? "" : timeKey(time);
    if (nextKey !== lastHoverKeyRef.current) {
      lastHoverKeyRef.current = nextKey;
      onHoverCandleChange(time === null ? null : candleByTimeRef.current.get(nextKey) || null);
    }

    if (sourceKey !== "main") {
      const mainValue = time === null ? undefined : closeByTimeRef.current.get(nextKey);
      if (time !== null && typeof mainValue === "number" && Number.isFinite(mainValue) && mainChartApiRef.current && mainSeriesRef.current) {
        mainChartApiRef.current.setCrosshairPosition(mainValue, time, mainSeriesRef.current);
      } else {
        mainChartApiRef.current?.clearCrosshairPosition();
      }
    }

    for (const entry of subChartEntriesRef.current) {
      if (entry.key === sourceKey) continue;
      if (time === null) {
        entry.chart.clearCrosshairPosition();
        continue;
      }
      const value = entry.valueByTime.get(nextKey);
      if (typeof value === "number" && Number.isFinite(value)) entry.chart.setCrosshairPosition(value, time, entry.syncSeries);
      else entry.chart.clearCrosshairPosition();
    }

    syncingCrosshairRef.current = false;
  }, [onHoverCandleChange]);

  useEffect(() => {
    if (!series?.candles.length || !mainRef.current) return;

    const interval = series.interval;
    const candlesWithTime = series.candles.map((candle) => ({ candle, time: toChartTime(candle.ts, interval) }));
    const candleData = candlesWithTime.map(({ candle, time }) => ({ time, open: candle.open, high: candle.high, low: candle.low, close: candle.close }));
    closeByTimeRef.current = new Map(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle.close]));
    candleByTimeRef.current = new Map(candlesWithTime.map(({ candle, time }) => [timeKey(time), candle]));
    overlayDataRef.current = {
      ma7: candlesWithTime.filter(({ candle }) => typeof candle.ma7 === "number").map(({ candle, time }) => ({ time, value: Number(candle.ma7) })),
      ma20: candlesWithTime.filter(({ candle }) => typeof candle.ma20 === "number").map(({ candle, time }) => ({ time, value: Number(candle.ma20) })),
    };

    const chart = createBaseChart(mainRef.current, 430, interval, true);
    mainChartApiRef.current = chart;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: Math.max(mainRef.current?.clientWidth || 320, 320) }));
    observer.observe(mainRef.current);

    const mainSeries = chart.addSeries(CandlestickSeries, {
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
    mainSeriesRef.current = mainSeries;
    syncMainOverlays();

    const handleVisibleRange = (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (canLoadMore && range.from < 40) onNeedMore();
      syncAllRanges("main", range);
    };
    const handleCrosshair = (param: MouseEventParams<Time>) => {
      syncCrosshairAcrossCharts("main", param.time ?? null);
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
    chart.subscribeCrosshairMove(handleCrosshair);

    const totalBars = series.candles.length;
    const resetToLatest = () => {
      const range = { from: Math.max(totalBars - 320, 0), to: totalBars + 8 };
      chart.timeScale().setVisibleLogicalRange(range);
      syncAllRanges("main", range);
    };
    resetToLatest();
    onRegisterReset(resetToLatest);
    onHoverCandleChange(series.candles.at(-1) || null);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.unsubscribeCrosshairMove(handleCrosshair);
      onRegisterReset(null);
      onHoverCandleChange(null);
      ma7SeriesRef.current = null;
      ma20SeriesRef.current = null;
      mainSeriesRef.current = null;
      mainChartApiRef.current = null;
      observer.disconnect();
      chart.remove();
    };
  }, [series, canLoadMore, onNeedMore, onHoverCandleChange, onRegisterReset, createBaseChart, syncAllRanges, syncCrosshairAcrossCharts, syncMainOverlays]);

  useEffect(() => {
    if (!series?.candles.length) return;
    syncMainOverlays();
  }, [series, mainOverlays, syncMainOverlays]);

  useEffect(() => {
    for (const entry of subChartEntriesRef.current) entry.chart.remove();
    subChartEntriesRef.current = [];
    if (!series?.candles.length) return;

    const interval = series.interval;
    const candlesWithTime = series.candles.map((candle) => ({ candle, time: toChartTime(candle.ts, interval) }));
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

    const observers: ResizeObserver[] = [];
    const lastIndicator = activeIndicators[activeIndicators.length - 1];

    const createIndicatorChart = (container: HTMLDivElement, key: SubIndicator) => {
      const chart = createBaseChart(container, 168, interval, lastIndicator === key);
      const observer = new ResizeObserver(() => chart.applyOptions({ width: Math.max(container.clientWidth, 320) }));
      observer.observe(container);
      observers.push(observer);
      return chart;
    };

    const attachIndicator = (key: SubIndicator, chart: any, syncSeries: any, valueByTime: Map<string, number>) => {
      const handleVisibleRange = (range: { from: number; to: number } | null) => syncAllRanges(key, range);
      const handleCrosshair = (param: MouseEventParams<Time>) => syncCrosshairAcrossCharts(key, param.time ?? null);
      chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.subscribeCrosshairMove(handleCrosshair);
      const mainRange = mainChartApiRef.current?.timeScale().getVisibleLogicalRange();
      if (mainRange) chart.timeScale().setVisibleLogicalRange(mainRange);
      subChartEntriesRef.current.push({ key, chart, syncSeries, valueByTime });
      return () => {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
        chart.unsubscribeCrosshairMove(handleCrosshair);
      };
    };

    const cleanups: Array<() => void> = [];

    if (activeIndicators.includes("volume") && volumeRef.current) {
      const chart = createIndicatorChart(volumeRef.current, "volume");
      const seriesApi = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, lastValueVisible: true, priceLineVisible: false });
      seriesApi.setData(volumeData);
      cleanups.push(attachIndicator("volume", chart, seriesApi, volumeByTime));
    }

    if (activeIndicators.includes("macd") && macdRef.current) {
      const chart = createIndicatorChart(macdRef.current, "macd");
      const bar = chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false });
      bar.setData(histogramData);
      const dif = chart.addSeries(LineSeries, { color: "#f97316", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      dif.setData(macdData);
      const dea = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dea.setData(signalData);
      dif.createPriceLine({ price: 0, color: "#71717a", lineStyle: 2, axisLabelVisible: false, title: "" });
      cleanups.push(attachIndicator("macd", chart, dif, macdByTime));
    }

    if (activeIndicators.includes("rsi14") && rsiRef.current) {
      const chart = createIndicatorChart(rsiRef.current, "rsi14");
      const seriesApi = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      seriesApi.setData(rsiData);
      seriesApi.createPriceLine({ price: 70, color: "#f59e0b", lineStyle: 2, axisLabelVisible: false, title: "" });
      seriesApi.createPriceLine({ price: 30, color: "#10b981", lineStyle: 2, axisLabelVisible: false, title: "" });
      cleanups.push(attachIndicator("rsi14", chart, seriesApi, rsiByTime));
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
      for (const observer of observers) observer.disconnect();
      for (const entry of subChartEntriesRef.current) entry.chart.remove();
      subChartEntriesRef.current = [];
    };
  }, [series, activeIndicators, createBaseChart, syncAllRanges, syncCrosshairAcrossCharts]);

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
});
export function MarketWorkspace() {
  const LIST_PAGE_SIZE = 100;
  const [catalog, setCatalog] = useState<MarketCatalog | null>(() => marketCatalogCache.value);
  const [series, setSeries] = useState<MarketSeries | null>(null);
  const [listRows, setListRows] = useState<MarketListRow[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [market, setMarket] = useState<MarketId>("a_share");
  const [exchangeId, setExchangeId] = useState("binance");
  const [cryptoMarketType, setCryptoMarketType] = useState<"spot" | "swap">("spot");
  const [symbol, setSymbol] = useState("000001.SH");
  const [interval, setInterval] = useState("1d");
  const [sortField, setSortField] = useState<SortField>("changePct");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [listPage, setListPage] = useState(1);
  const [status, setStatus] = useState("正在加载行情中心...");
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [mainOverlays, setMainOverlays] = useState<MainOverlay[]>([]);
  const [subIndicators, setSubIndicators] = useState<SubIndicator[]>(["volume", "macd"]);
  const [historyLimit, setHistoryLimit] = useState(800);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const loadingRef = useRef(false);
  const historyLimitRef = useRef(800);
  const expandingHistoryRef = useRef(false);
  const seriesRequestSeqRef = useRef(0);
  const listRequestSeqRef = useRef(0);
  const resetChartRef = useRef<(() => void) | null>(null);
  const seriesAbortRef = useRef<AbortController | null>(null);
  const boardContextRef = useRef("");

  const mainOverlayLabels: Record<MainOverlay, string> = { ma7: "MA7", ma20: "MA20" };
  const subIndicatorLabels: Record<SubIndicator, string> = { volume: "成交量", macd: "MACD", rsi14: "RSI" };

  const currentMarket = useMemo(() => catalog?.markets.find((item) => item.market === market) || null, [catalog, market]);
  const currentExchange = useMemo(
    () => currentMarket?.exchanges?.find((item) => item.exchangeId === exchangeId) || currentMarket?.exchanges?.[0] || null,
    [currentMarket, exchangeId]
  );
  const totalListPages = Math.max(1, Math.ceil((listTotal || listRows.length) / LIST_PAGE_SIZE));

  const buildBoardCacheKey = useCallback(
    () => [market, market === "crypto" ? exchangeId : "default", market === "crypto" ? cryptoMarketType : "default", listPage, sortField, sortDirection].join(":"),
    [market, exchangeId, cryptoMarketType, listPage, sortField, sortDirection]
  );
  const buildSeriesCacheKey = useCallback(
    () => [market, market === "crypto" ? exchangeId : "default", market === "crypto" ? cryptoMarketType : "default", symbol, interval, historyLimit].join(":"),
    [market, exchangeId, cryptoMarketType, symbol, interval, historyLimit]
  );

  const loadCatalog = async (forceRefresh = false) => {
    if (!forceRefresh && marketCatalogCache.value) {
      setCatalog(marketCatalogCache.value);
      return marketCatalogCache.value;
    }
    const next = await authorizedFetch<MarketCatalog>(`${PLATFORM_API_BASE}/market/catalog${forceRefresh ? "?forceRefresh=true" : ""}`, "");
    marketCatalogCache.value = next;
    setCatalog(next);
    return next;
  };

  const loadBoard = async (forceRefresh = false) => {
    const cacheKey = buildBoardCacheKey();
    if (!forceRefresh) {
      const cached = marketBoardCache.get(cacheKey);
      if (cached) {
        setListRows(cached.items || []);
        setListTotal(cached.total || (cached.items || []).length);
        setStatus(cached.source?.ok ? "行情列表已就绪。" : cached.source?.detail || "行情列表已就绪。");
        return;
      }
    }
    const requestSeq = ++listRequestSeqRef.current;
    setListLoading(true);
    try {
      const query = new URLSearchParams({ market, forceRefresh: forceRefresh ? "true" : "false" });
      query.set("page", String(listPage));
      query.set("pageSize", String(LIST_PAGE_SIZE));
      query.set("sortField", sortField);
      query.set("sortDirection", sortDirection);
      if (market === "crypto") {
        query.set("exchangeId", exchangeId);
        query.set("marketType", cryptoMarketType);
      }
      const payload = await authorizedFetch<MarketBoardPayload>(`${PLATFORM_API_BASE}/market/board?${query.toString()}`, "");
      if (requestSeq !== listRequestSeqRef.current) return;
      marketBoardCache.set(cacheKey, payload);
      setListRows(payload.items || []);
      setListTotal(payload.total || (payload.items || []).length);
      setStatus(payload.source?.ok ? "行情列表已更新。" : payload.source?.detail || "行情列表已更新。");
    } catch (error) {
      if (requestSeq !== listRequestSeqRef.current) return;
      setStatus(error instanceof Error ? error.message : "加载行情列表失败");
      setListRows([]);
      setListTotal(0);
    } finally {
      if (requestSeq === listRequestSeqRef.current) setListLoading(false);
    }
  };

  const loadSeries = async (forceRefresh = false) => {
    const cacheKey = buildSeriesCacheKey();
    if (!forceRefresh) {
      const cached = marketSeriesCache.get(cacheKey);
      if (cached) {
        setSeries(cached);
        setStatus(cached.source.ok ? "行情数据已就绪。" : cached.source.detail);
        return;
      }
    }
    const requestSeq = ++seriesRequestSeqRef.current;
    seriesAbortRef.current?.abort();
    const controller = new AbortController();
    seriesAbortRef.current = controller;
    setLoading(true);
    try {
      const query = new URLSearchParams({ market, symbol, interval, limit: String(historyLimit), forceRefresh: forceRefresh ? "true" : "false" });
      if (market === "crypto") {
        query.set("exchangeId", exchangeId);
        query.set("marketType", cryptoMarketType);
      }
      const next = await authorizedFetch<MarketSeries>(`${PLATFORM_API_BASE}/market/series?${query.toString()}`, "", { signal: controller.signal });
      if (requestSeq !== seriesRequestSeqRef.current) return;
      marketSeriesCache.set(cacheKey, next);
      setSeries(next);
      setStatus(next.source.ok ? "行情数据已更新。" : next.source.detail);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (requestSeq !== seriesRequestSeqRef.current) return;
      setStatus(error instanceof Error ? error.message : "加载行情失败");
    } finally {
      if (requestSeq === seriesRequestSeqRef.current && !controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const next = await loadCatalog();
        const aShare = next.markets.find((item) => item.market === "a_share");
        const crypto = next.markets.find((item) => item.market === "crypto");
        if (aShare) {
          setSymbol(aShare.defaultSymbol);
          setInterval(aShare.defaultInterval);
        }
        if (crypto?.defaultExchangeId) setExchangeId(crypto.defaultExchangeId);
        if (crypto?.defaultMarketType === "spot" || crypto?.defaultMarketType === "swap") {
          setCryptoMarketType(crypto.defaultMarketType);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "加载行情目录失败");
      }
    })();
    return () => {
      seriesAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    loadingRef.current = loading;
    if (!loading) expandingHistoryRef.current = false;
  }, [loading]);

  useEffect(() => {
    historyLimitRef.current = historyLimit;
  }, [historyLimit]);

  useEffect(() => {
    if (listRows.length === 0) return;
    const nextContext = market === "crypto" ? `${market}:${exchangeId}:${cryptoMarketType}` : market;
    if (boardContextRef.current !== nextContext) {
      boardContextRef.current = nextContext;
      if (!listRows.some((item) => item.symbol === symbol)) {
        setSymbol(listRows[0].symbol);
      }
    }
  }, [listRows, market, exchangeId, cryptoMarketType, symbol]);

  useEffect(() => {
    if (!catalog) return;
    const target = catalog.markets.find((item) => item.market === market);
    if (!target) return;

    if (market === "crypto") {
      const availableMarketTypes = (target.marketTypes || [])
        .map((item) => item.id)
        .filter((item): item is "spot" | "swap" => item === "spot" || item === "swap");
      const nextMarketType = availableMarketTypes.includes(cryptoMarketType)
        ? cryptoMarketType
        : ((target.defaultMarketType as "spot" | "swap" | undefined) || availableMarketTypes[0] || "spot");
      if (nextMarketType !== cryptoMarketType) return void setCryptoMarketType(nextMarketType);
      const nextExchange = target.exchanges?.some((item) => item.exchangeId === exchangeId) ? exchangeId : target.defaultExchangeId || "binance";
      if (nextExchange !== exchangeId) return void setExchangeId(nextExchange);
      const targetExchange = target.exchanges?.find((item) => item.exchangeId === nextExchange) || target.exchanges?.[0];
      const targetSymbols = targetExchange?.symbolsByMarketType?.[nextMarketType] || targetExchange?.symbols || [];
      const defaultSymbol = targetSymbols[0]?.symbol || target.defaultSymbol;
      const nextSymbol = targetSymbols.some((item) => item.symbol === symbol) ? symbol : defaultSymbol;
      const nextInterval = target.intervals.includes(interval) ? interval : target.defaultInterval;
      if (nextSymbol !== symbol) return void setSymbol(nextSymbol);
      if (nextInterval !== interval) return void setInterval(nextInterval);
    } else {
      const nextInterval = target.intervals.includes(interval) ? interval : target.defaultInterval;
      if (nextInterval !== interval) return void setInterval(nextInterval);
    }
  }, [catalog, market, exchangeId, symbol, interval]);

  useEffect(() => {
    setListPage(1);
  }, [market, exchangeId, cryptoMarketType]);

  useEffect(() => {
    setListPage(1);
  }, [sortField, sortDirection]);

  useEffect(() => {
    if (listPage > totalListPages) setListPage(totalListPages);
  }, [listPage, totalListPages]);

  useEffect(() => {
    if (!catalog) return;
    void loadBoard();
  }, [catalog, market, exchangeId, cryptoMarketType, listPage, sortField, sortDirection, buildBoardCacheKey]);

  useEffect(() => {
    if (!catalog) return;
    void loadSeries();
  }, [catalog, market, exchangeId, cryptoMarketType, symbol, interval, historyLimit, buildSeriesCacheKey]);

  const toggleMainOverlay = (value: MainOverlay) => setMainOverlays((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
  const toggleSubIndicator = (value: SubIndicator) => setSubIndicators((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
  const registerResetHandler = useCallback((handler: (() => void) | null) => {
    resetChartRef.current = handler;
  }, []);
  const expandHistory = useCallback(() => {
    const current = historyLimitRef.current;
    if (loadingRef.current || expandingHistoryRef.current || current >= 1200) return;
    expandingHistoryRef.current = true;
    setHistoryLimit(Math.min(current + 200, 1200));
  }, []);
  const resetView = useCallback(() => {
    resetChartRef.current?.();
    setHoveredCandle(series?.candles.at(-1) || null);
  }, [series]);

  const displayCandle = hoveredCandle || series?.candles.at(-1) || null;
  const candleDelta = displayCandle ? displayCandle.close - displayCandle.open : null;
  const candleDeltaPct = displayCandle && displayCandle.open ? ((displayCandle.close - displayCandle.open) / displayCandle.open) * 100 : null;
  const selectedListRow = useMemo(() => listRows.find((item) => item.symbol === symbol) || null, [listRows, symbol]);
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSortField(field);
    setSortDirection("desc");
  };
  const renderSortArrows = (field: SortField) => {
    const active = sortField === field;
    return (
      <span className="ml-1 inline-flex flex-col leading-none text-[10px]">
        <span className={active && sortDirection === "asc" ? "text-zinc-100" : "text-zinc-600"}>▲</span>
        <span className={active && sortDirection === "desc" ? "text-zinc-100" : "text-zinc-600"}>▼</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">行情中心</h1>
          <p className="mt-1 text-sm text-zinc-500">先看股票或币种列表的涨跌幅与成交额，再点进具体标的查看 K 线和指标状态。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void loadCatalog(true)}>刷新目录</Button>
          <Button variant="outline" onClick={() => void loadBoard(true)} disabled={listLoading}>{listLoading ? "刷新列表..." : "刷新列表"}</Button>
          <Button variant="outline" onClick={() => void loadSeries(true)} disabled={loading}>{loading ? "刷新中..." : "刷新行情"}</Button>
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.92fr_1.08fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {(["a_share", "crypto"] as MarketId[]).map((item) => (
                  <button
                    key={item}
                    onClick={() => setMarket(item)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      market === item ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600"
                    }`}
                  >
                    {item === "a_share" ? "股票列表" : "币种列表"}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {market === "crypto" ? (
                  <>
                    <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
                      {((currentMarket?.marketTypes?.length ? currentMarket.marketTypes : [{ id: "spot", label: "现货" }, { id: "swap", label: "合约" }]) as Array<{ id: string; label: string }>).map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setCryptoMarketType(item.id as "spot" | "swap")}
                          className={`rounded-md px-3 py-1.5 text-sm transition ${
                            cryptoMarketType === item.id ? "bg-zinc-100 text-zinc-950" : "text-zinc-300 hover:text-zinc-100"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <select value={exchangeId} onChange={(e) => setExchangeId(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                      {(currentMarket?.exchanges || []).map((item) => <option key={item.exchangeId} value={item.exchangeId}>{item.label}</option>)}
                    </select>
                  </>
                ) : null}
                <select value={interval} onChange={(e) => setInterval(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600">
                  {(currentMarket?.intervals || []).map((item) => <option key={item} value={item}>{intervalLabel(item)}</option>)}
                </select>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-zinc-100">{market === "a_share" ? "股票列表" : "币种列表"}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {market === "a_share"
                      ? "A股已经扩到全市场列表；点击表头箭头可按涨幅、成交额或市值排序。"
                      : `当前展示 ${cryptoMarketType === "swap" ? "合约" : "现货"} 列表；点击表头箭头可按涨幅、成交额或市值排序。`}
                  </div>
                </div>
                <div className="text-xs text-zinc-500">
                  共 {(listTotal || listRows.length).toLocaleString("zh-CN")} 条，第 {listPage}/{totalListPages} 页
                </div>
              </div>
              <div className="grid grid-cols-[1.25fr_0.7fr_0.8fr_0.8fr] gap-3 px-4 py-3 text-xs text-zinc-500">
                <div>{market === "a_share" ? "股票" : "币种"}</div>
                <button onClick={() => toggleSort("changePct")} className="flex items-center justify-end text-right transition hover:text-zinc-300">
                  涨跌幅
                  {renderSortArrows("changePct")}
                </button>
                <button onClick={() => toggleSort("turnover")} className="flex items-center justify-end text-right transition hover:text-zinc-300">
                  成交额
                  {renderSortArrows("turnover")}
                </button>
                <button onClick={() => toggleSort("marketCap")} className="flex items-center justify-end text-right transition hover:text-zinc-300">
                  市值
                  {renderSortArrows("marketCap")}
                </button>
              </div>
              <div className="max-h-[420px] space-y-2 overflow-y-auto px-3 pb-3">
                {listRows.map((item) => (
                  <button
                    key={`${item.exchangeId}:${item.symbol}`}
                    onClick={() => {
                      setSymbol(item.symbol);
                      if (market === "crypto" && item.exchangeId !== exchangeId) setExchangeId(item.exchangeId);
                    }}
                    className={`grid w-full grid-cols-[1.25fr_0.7fr_0.8fr_0.8fr] gap-3 rounded-xl border px-3 py-3 text-left transition ${
                      symbol === item.symbol ? "border-zinc-100 bg-zinc-100/10" : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
                    }`}
                  >
                    <div>
                      <div className="font-medium text-zinc-100">{item.label}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {item.symbol}
                        {market === "crypto" ? ` · ${item.exchangeLabel} · ${cryptoMarketType === "swap" ? "合约" : "现货"}` : item.kind === "index" ? " · 指数" : " · 个股"}
                      </div>
                    </div>
                    <div className={`text-right text-sm font-medium ${listToneClass(item.changePct)}`}>{formatNumber(item.changePct)}%</div>
                    <div className="text-right text-sm text-zinc-300">{item.turnoverLabel}</div>
                    <div className="text-right text-sm text-zinc-300">{item.marketCapLabel}</div>
                  </button>
                ))}
                {!listLoading && listRows.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-sm text-zinc-500">当前没有可展示的行情列表。</div> : null}
                {listLoading ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-sm text-zinc-500">正在更新列表快照...</div> : null}
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
                <div className="text-xs text-zinc-500">当前页只渲染 {LIST_PAGE_SIZE} 条，减轻全市场列表卡顿。</div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => setListPage((current) => Math.max(1, current - 1))} disabled={listPage <= 1}>
                    上一页
                  </Button>
                  <Button variant="outline" onClick={() => setListPage((current) => Math.min(totalListPages, current + 1))} disabled={listPage >= totalListPages}>
                    下一页
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-zinc-100">{series?.symbolLabel || selectedListRow?.label || "--"}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {series?.exchangeLabel || selectedListRow?.exchangeLabel || "--"}
                  {market === "crypto" ? ` · ${((series?.marketType || cryptoMarketType) === "swap" ? "合约" : "现货")}` : ""}
                  {" · "}
                  {series?.interval ? intervalLabel(series.interval) : intervalLabel(interval)}
                </div>
              </div>
              <Badge variant={series?.source.ok ? "success" : "warning"}>{series?.source.ok ? "在线" : "回退"}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">最新价</div><div className="mt-2 text-2xl font-semibold text-zinc-50">{formatNumber(series?.snapshot.last || selectedListRow?.last)}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">涨跌幅</div><div className={`mt-2 text-2xl font-semibold ${listToneClass(series?.snapshot.changePct || selectedListRow?.changePct || 0)}`}>{formatNumber(series?.snapshot.changePct || selectedListRow?.changePct)}%</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">区间高低</div><div className="mt-2 text-sm text-zinc-200">{formatNumber(series?.snapshot.low)} / {formatNumber(series?.snapshot.high)}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">成交额</div><div className="mt-2 text-sm text-zinc-200">{series?.snapshot.turnoverLabel || selectedListRow?.turnoverLabel || "--"}</div></div>
            </div>
            <div className="text-sm text-zinc-400">{series?.source.detail || "点击左侧标的后，这里会显示行情源说明。"}</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">趋势</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.trend || "--"}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">MACD</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.macdState || "--"}</div></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><div className="text-xs text-zinc-500">RSI</div><div className="mt-2 text-sm text-zinc-100">{series?.indicators.rsiState || "--"}</div></div>
            </div>
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-3 text-xs leading-6 text-zinc-500">先在左侧看列表排序，再进入右侧详情。这里保留周期切换、滚轮缩放、拖拽平移，以及主图和子图统一十字线联动。</div>
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

        <div className="mt-4"><ChartPane series={series} mainOverlays={mainOverlays} subIndicators={subIndicators} canLoadMore={historyLimit < 1200} onNeedMore={expandHistory} onHoverCandleChange={setHoveredCandle} onRegisterReset={registerResetHandler} /></div>

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
