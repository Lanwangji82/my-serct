export interface ChartPoint {
  time: number;
  value: number;
}

export interface CandlePoint {
  time: number;
  close: number;
}

export interface IndicatorBundlePayload {
  updatedAt: number;
  ma: Record<string, ChartPoint[]>;
  ema: Record<string, ChartPoint[]>;
  rsi: ChartPoint[];
  macd: {
    macdLine: ChartPoint[];
    signalLine: ChartPoint[];
    histogram: ChartPoint[];
  };
}

function getPointValue(point: CandlePoint | ChartPoint) {
  return 'close' in point ? point.close : point.value;
}

export function calculateMA(data: CandlePoint[], period: number) {
  if (!data || data.length < period) return [] as ChartPoint[];
  const ma: ChartPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    let validCount = 0;

    for (let j = 0; j < period; j++) {
      const item = data[i - j];
      if (!item || typeof item.close !== 'number' || Number.isNaN(item.close)) continue;
      sum += item.close;
      validCount++;
    }

    if (validCount === period) {
      ma.push({ time: data[i].time, value: sum / period });
    }
  }

  return ma;
}

export function calculateEMA(data: Array<CandlePoint | ChartPoint>, period: number) {
  if (!data || data.length === 0) return [] as ChartPoint[];
  const ema: ChartPoint[] = [];
  const k = 2 / (period + 1);

  let firstValidIdx = -1;
  for (let i = 0; i < data.length; i++) {
    const value = getPointValue(data[i]);
    if (typeof value === 'number' && !Number.isNaN(value)) {
      firstValidIdx = i;
      break;
    }
  }

  if (firstValidIdx === -1) return ema;

  let prevEma = getPointValue(data[firstValidIdx]);

  for (let i = firstValidIdx; i < data.length; i++) {
    const value = getPointValue(data[i]);
    const time = data[i].time;
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    const nextEma = (value - prevEma) * k + prevEma;
    ema.push({ time, value: nextEma });
    prevEma = nextEma;
  }

  return ema;
}

export function calculateRSI(data: CandlePoint[], period = 14) {
  if (!data || data.length <= period) return [] as ChartPoint[];
  const rsi: ChartPoint[] = [];
  let gains = 0;
  let losses = 0;
  let validInitialCount = 0;

  for (let i = 1; i < data.length && validInitialCount < period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
    validInitialCount++;
  }

  if (validInitialCount < period) return rsi;

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi.push({ time: data[i].time, value: 100 });
    } else {
      const rs = avgGain / avgLoss;
      rsi.push({ time: data[i].time, value: 100 - (100 / (1 + rs)) });
    }
  }

  return rsi;
}

export function calculateMACD(data: CandlePoint[], fast = 12, slow = 26, signal = 9) {
  if (!data || data.length < slow) {
    return { macdLine: [] as ChartPoint[], signalLine: [] as ChartPoint[], histogram: [] as ChartPoint[] };
  }

  const emaFast = calculateEMA(data, fast);
  const emaSlow = calculateEMA(data, slow);
  const fastMap = new Map(emaFast.map((item) => [item.time, item.value]));
  const macdLine: ChartPoint[] = [];

  emaSlow.forEach((item) => {
    const fastValue = fastMap.get(item.time);
    if (fastValue !== undefined) {
      macdLine.push({ time: item.time, value: fastValue - item.value });
    }
  });

  if (macdLine.length < signal) {
    return { macdLine, signalLine: [] as ChartPoint[], histogram: [] as ChartPoint[] };
  }

  const signalLine = calculateEMA(macdLine, signal);
  const macdMap = new Map(macdLine.map((item) => [item.time, item.value]));
  const histogram: ChartPoint[] = signalLine.map((item) => ({
    time: item.time,
    value: (macdMap.get(item.time) ?? 0) - item.value,
  }));

  return { macdLine, signalLine, histogram };
}

export function computeIndicatorBundle(candles: CandlePoint[]): IndicatorBundlePayload {
  const ma7 = calculateMA(candles, 7);
  const ma25 = calculateMA(candles, 25);
  const ma99 = calculateMA(candles, 99);
  const ema7 = calculateEMA(candles, 7);
  const ema25 = calculateEMA(candles, 25);
  const ema99 = calculateEMA(candles, 99);
  const rsi = calculateRSI(candles, 14);
  const macd = calculateMACD(candles);

  return {
    updatedAt: Date.now(),
    ma: { 7: ma7, 25: ma25, 99: ma99 },
    ema: { 7: ema7, 25: ema25, 99: ema99 },
    rsi,
    macd,
  };
}
