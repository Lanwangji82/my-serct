import './bootstrap-env';
import express from 'express';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { computeIndicatorBundle } from './indicator-utils';
import { getOrderBookProjection } from './orderbook-projection';
import { WebSocketServer } from 'ws';
import { getCacheStore } from './cache-store';
import { getMarketStreamProjection } from './market-stream';
import { closeAccountStreamSession, createAccountStreamSession, getAccountStreamSession } from './account-stream';
import { getKafkaTopicMap, getMessageBus } from './message-bus';
import { getRuntimeHealthSnapshot } from './runtime-monitor';
import { getClickHouseStore } from './clickhouse-store';
import { registerPlatformApi } from './platform-api';
import { fetchViaCcxt, useCcxtMarketData, type MarketExchange } from './ccxt-market-data';
import { getCcxtTelemetrySnapshot } from './ccxt-telemetry';
import { benchmarkClashSelector, optimizeClashSelector } from './clash-controller';
import {
  cancelOrderCcxt,
  fetchFundingBalancesCcxt,
  fetchFuturesBalancesCcxt,
  fetchFuturesPositionsCcxt,
  fetchOpenOrdersCcxt,
  fetchOrderHistoryCcxt,
  fetchSpotAccountCcxt,
  fetchTradeHistoryCcxt,
  placeOrderCcxt,
  setFuturesLeverageCcxt,
  setFuturesMarginTypeCcxt,
  validateCcxtBinanceCredentials,
} from './ccxt-private-api';

type BinanceMarketType = 'spot' | 'futures';

const app = express();
const port = Number(process.env.BINANCE_PROXY_PORT || 8787);
const server = createServer(app);
const orderbookWss = new WebSocketServer({ server, path: '/ws/binance/orderbook' });
const marketWss = new WebSocketServer({ server, path: '/ws/binance/market' });
const accountWss = new WebSocketServer({ server, path: '/ws/binance/account' });
const cacheStore = getCacheStore();
const messageBus = getMessageBus();
const clickhouseStore = getClickHouseStore();

const SPOT_BASE_URLS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const FUTURES_BASE_URLS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
];

const CACHE_TTL_MS = 60_000;
const ACTIVE_QUERY_TTL_MS = 90_000;
const ACTIVE_QUERY_SWEEP_MS = 5_000;
const ACTIVE_QUERY_PREFERENCE_TTL_MS = 24 * 60 * 60_000;
const BACKGROUND_LOG_THROTTLE_MS = 15_000;

interface ActiveQuerySubscription {
  key: string;
  type: BinanceMarketType;
  symbol: string;
  interval: string;
  limit: number;
  warmIntervals: string[];
  keepIndicatorsWarm: boolean;
  expiresAt: number;
  lastKlineWarmAt: number;
  lastIndicatorWarmAt: number;
}

const activeQuerySubscriptions = new Map<string, ActiveQuerySubscription>();
const activeQueryRefreshInflight = new Set<string>();
const backgroundLogTimestamps = new Map<string, number>();

app.use(express.json({ limit: '1mb' }));
registerPlatformApi(app);

function isTransientNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('AbortError')
    || message.includes('This operation was aborted')
    || message.includes('fetch failed')
    || message.includes('ECONNRESET')
    || message.includes('ETIMEDOUT')
    || message.includes('UND_ERR_CONNECT_TIMEOUT');
}

function logBackgroundIssue(key: string, message: string, error: unknown) {
  const now = Date.now();
  const lastLoggedAt = backgroundLogTimestamps.get(key) || 0;
  if (now - lastLoggedAt < BACKGROUND_LOG_THROTTLE_MS) {
    return;
  }

  backgroundLogTimestamps.set(key, now);
  if (isTransientNetworkError(error)) {
    const details = error instanceof Error ? error.message : String(error ?? 'unknown error');
    console.warn(`${message}: transient Binance network issue (${details})`);
    return;
  }

  console.warn(message, error);
}

function getBaseUrls(type: BinanceMarketType) {
  return type === 'spot' ? SPOT_BASE_URLS : FUTURES_BASE_URLS;
}

function getOrderbookProjectionLimitCap(type: BinanceMarketType) {
  return type === 'spot' ? 5000 : 1000;
}

async function probeBaseUrl(baseUrl: string, pingPath: string, timeoutMs: number) {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}${pingPath}`, { signal: controller.signal });
    if (!res.ok) return null;
    return { baseUrl, latency: Math.round(performance.now() - start) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getRankedBinanceBaseUrls(type: BinanceMarketType, timeoutMs = 1800) {
  const cacheKey = `${type}-ranked`;
  const cached = await cacheStore.get<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const pingPath = type === 'spot' ? '/api/v3/ping' : '/fapi/v1/ping';
  const results = await Promise.all(getBaseUrls(type).map((baseUrl) => probeBaseUrl(baseUrl, pingPath, timeoutMs)));
  const ranked = results
    .filter((item): item is { baseUrl: string; latency: number } => item !== null)
    .sort((a, b) => a.latency - b.latency)
    .map((item) => item.baseUrl);

  const urls = ranked.length > 0 ? ranked : getBaseUrls(type);
  await cacheStore.set(cacheKey, urls, CACHE_TTL_MS);
  return urls;
}

async function fetchPublicBinance(type: BinanceMarketType, path: string, timeoutMs = 2200, exchange: MarketExchange = 'binance') {
  const cacheKey = `${exchange}:${type}:${path}`;
  const ttlMs = getPublicCacheTtlMs(path);
  const cached = ttlMs > 0 ? await cacheStore.get<{ data: unknown; baseUrl: string }>(cacheKey) : null;
  if (cached) {
    return {
      data: cached.data,
      baseUrl: cached.baseUrl,
    };
  }

  const shouldPreferDirect = exchange === 'binance' && (path.includes('/klines') || path.includes('/depth'));

  if (useCcxtMarketData() && !shouldPreferDirect) {
    try {
      const result = await fetchViaCcxt(type, path, exchange);
      if (ttlMs > 0) {
        await cacheStore.set(cacheKey, result, ttlMs);
      }
      return result;
    } catch (error) {
      console.warn(`[ccxt] failed to serve ${exchange} ${type} ${path}, falling back to direct Binance`, error);
    }
  }

  if (exchange !== 'binance') {
    throw new Error(`Exchange ${exchange} requires ccxt market data driver`);
  }

  const rankedBaseUrls = await getRankedBinanceBaseUrls(type, timeoutMs);

  for (const baseUrl of rankedBaseUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        if (ttlMs > 0) {
          await cacheStore.set(cacheKey, {
            data,
            baseUrl,
          }, ttlMs);
        }
        return {
          data,
          baseUrl,
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Failed to fetch Binance public path ${path}`);
}

function getPublicCacheTtlMs(path: string) {
  if (path.includes('/depth')) return 400;
  if (path.includes('/klines')) return 4_000;
  if (path.includes('/ticker/24hr')) return 1_500;
  if (path.includes('/premiumIndex')) return 1_500;
  if (path.includes('/exchangeInfo')) return 300_000;
  if (path.includes('/time') || path.includes('/ping')) return 1_000;
  return 0;
}

function formatBinanceKlines(klines: any[]) {
  return klines.map((item: any[]) => ({
    time: Number(item[0]) / 1000,
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5] || 0),
    quoteVolume: Number(item[7] || 0),
  })).sort((a, b) => a.time - b.time);
}

function parseIntervalToSeconds(interval: string) {
  const match = /^(\d+)([mhdwM])$/.exec(interval);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const unitSecondsMap: Record<string, number> = {
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
    M: 30 * 24 * 60 * 60,
  };
  return value * (unitSecondsMap[unit] || 0);
}

function getFreshnessWindowMs(interval: string) {
  const seconds = parseIntervalToSeconds(interval);
  if (!seconds) return 60_000;
  return Math.max(15_000, Math.min(seconds * 1000 * 2, 10 * 60_000));
}

function getActiveWarmIntervalMs(interval: string) {
  return Math.max(5_000, Math.floor(getFreshnessWindowMs(interval) / 2));
}

function getActiveQueryKey(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  return `${type}:${symbol.toUpperCase()}:${interval}:${limit}`;
}

function getActiveQueryPreferenceKey(type: BinanceMarketType, symbol: string) {
  return `active-query-pref:${type}:${symbol.toUpperCase()}`;
}

function normalizeWarmIntervals(interval: string, warmIntervals?: string[]) {
  const candidates = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const merged = [interval, ...(warmIntervals || [])]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, arr) => arr.indexOf(item) === index);
  const normalized = merged.filter((item) => candidates.includes(item));
  return normalized.length ? normalized : [interval];
}

async function upsertActiveQuerySubscription(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number,
  keepIndicatorsWarm: boolean,
  warmIntervals?: string[]
) {
  const normalizedSymbol = symbol.toUpperCase();
  const key = getActiveQueryKey(type, normalizedSymbol, interval, limit);
  const existing = activeQuerySubscriptions.get(key);
  const preferenceKey = getActiveQueryPreferenceKey(type, normalizedSymbol);
  const persistedWarmIntervals = await cacheStore.get<string[]>(preferenceKey);
  const mergedWarmIntervals = normalizeWarmIntervals(
    interval,
    [
      ...(existing?.warmIntervals || []),
      ...(persistedWarmIntervals || []),
      ...(warmIntervals || []),
    ]
  );
  const next: ActiveQuerySubscription = {
    key,
    type,
    symbol: normalizedSymbol,
    interval,
    limit,
    warmIntervals: mergedWarmIntervals,
    keepIndicatorsWarm: keepIndicatorsWarm || existing?.keepIndicatorsWarm || false,
    expiresAt: Date.now() + ACTIVE_QUERY_TTL_MS,
    lastKlineWarmAt: existing?.lastKlineWarmAt || 0,
    lastIndicatorWarmAt: existing?.lastIndicatorWarmAt || 0,
  };
  activeQuerySubscriptions.set(key, next);
  await cacheStore.set(preferenceKey, mergedWarmIntervals, ACTIVE_QUERY_PREFERENCE_TTL_MS);
  return next;
}

function pruneExpiredActiveQuerySubscriptions() {
  const now = Date.now();
  for (const [key, subscription] of activeQuerySubscriptions.entries()) {
    if (subscription.expiresAt <= now) {
      activeQuerySubscriptions.delete(key);
    }
  }
}

function getAggregationBaseIntervals(interval: string) {
  const targetSeconds = parseIntervalToSeconds(interval);
  if (!targetSeconds) return [] as string[];

  const candidates = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  return candidates.filter((candidate) => {
    if (candidate === interval) return false;
    const candidateSeconds = parseIntervalToSeconds(candidate);
    return Boolean(candidateSeconds && targetSeconds % candidateSeconds === 0 && candidateSeconds < targetSeconds);
  }).sort((a, b) => (parseIntervalToSeconds(a) || 0) - (parseIntervalToSeconds(b) || 0));
}

function aggregateCandles(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number }>,
  interval: string,
  limit: number
) {
  const intervalSeconds = parseIntervalToSeconds(interval);
  if (!intervalSeconds || !candles.length) return candles.slice(-limit);

  const buckets = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number }>();
  candles.forEach((candle) => {
    const bucketTime = Math.floor(candle.time / intervalSeconds) * intervalSeconds;
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        quoteVolume: candle.quoteVolume || 0,
      });
      return;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume || 0;
    existing.quoteVolume += candle.quoteVolume || 0;
  });

  return Array.from(buckets.values())
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

async function queryHistoricalKlines(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  const escapedType = type.replace(/'/g, "''");
  const escapedSymbol = symbol.toUpperCase().replace(/'/g, "''");
  const escapedInterval = interval.replace(/'/g, "''");
  const rows = await clickhouseStore.queryJson<{
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    quote_volume: number;
  }>(`
    SELECT ts, open, high, low, close, volume, quote_volume
    FROM klines
    WHERE market_type = '${escapedType}'
      AND symbol = '${escapedSymbol}'
      AND interval = '${escapedInterval}'
    ORDER BY ts DESC
    LIMIT ${Math.max(1, Math.min(limit, 1500))}
  `);

  const data = rows
    .map((row) => ({
      time: Math.floor(new Date(row.ts).getTime() / 1000),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
      quoteVolume: Number(row.quote_volume || 0),
    }))
    .sort((a, b) => a.time - b.time);

  const latestTime = data[data.length - 1]?.time ?? null;
  return {
    data,
    latestTime,
    updatedAt: latestTime ? latestTime * 1000 : null,
  };
}

async function queryAggregatedHistoricalKlines(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  const baseIntervals = getAggregationBaseIntervals(interval);

  for (const baseInterval of baseIntervals) {
    const multiplier = Math.max(1, Math.ceil((parseIntervalToSeconds(interval) || 0) / Math.max(parseIntervalToSeconds(baseInterval) || 1, 1)));
    const baseResult = await queryHistoricalKlines(type, symbol, baseInterval, Math.min(limit * multiplier + 20, 5000));
    const baseRows = baseResult.data;
    if (baseRows.length < Math.max(50, limit)) {
      continue;
    }

    const aggregated = aggregateCandles(baseRows, interval, limit);
    if (aggregated.length >= Math.min(limit, 200)) {
      return {
        source: `clickhouse-aggregated:${baseInterval}`,
        data: aggregated,
        updatedAt: baseResult.updatedAt,
      };
    }
  }

  return null;
}

async function queryHistoricalIndicatorSnapshot(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  const escapedType = type.replace(/'/g, "''");
  const escapedSymbol = symbol.toUpperCase().replace(/'/g, "''");
  const escapedInterval = interval.replace(/'/g, "''");

  const rows = await clickhouseStore.queryJson<{
    ts: string;
    base_url: string;
    ma_json: string;
    ema_json: string;
    rsi_json: string;
    macd_json: string;
  }>(`
    SELECT ts, base_url, ma_json, ema_json, rsi_json, macd_json
    FROM indicator_snapshots
    WHERE market_type = '${escapedType}'
      AND symbol = '${escapedSymbol}'
      AND interval = '${escapedInterval}'
      AND data_limit = ${Math.max(1, Math.min(limit, 1500))}
    ORDER BY ts DESC
    LIMIT 1
  `);

  const latest = rows[0];
  if (!latest) return null;

  return {
    baseUrl: String(latest.base_url || ''),
    updatedAt: new Date(latest.ts).getTime(),
    ma: JSON.parse(latest.ma_json || '{}'),
    ema: JSON.parse(latest.ema_json || '{}'),
    rsi: JSON.parse(latest.rsi_json || '[]'),
    macd: JSON.parse(latest.macd_json || '{}'),
  };
}

async function fetchAndPublishKlineSnapshot(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  const path = type === 'spot'
    ? `/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    : `/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

  const { data, baseUrl } = await fetchPublicBinance(type, path, 2200);
  const candles = Array.isArray(data) ? formatBinanceKlines(data) : [];
  const topics = getKafkaTopicMap();
  const updatedAt = Date.now();
  void messageBus.publish(topics.klineSnapshot, `${type}:${symbol.toUpperCase()}:${interval}`, {
    type,
    symbol: symbol.toUpperCase(),
    interval,
    limit,
    baseUrl,
    candles,
    updatedAt,
  });

  return {
    source: 'binance' as const,
    baseUrl,
    updatedAt,
    data: candles,
  };
}

async function refreshIndicatorSnapshotInBackground(
  type: BinanceMarketType,
  symbol: string,
  interval: string,
  limit: number
) {
  try {
    const klineResult = await fetchAndPublishKlineSnapshot(type, symbol, interval, limit);
    const formattedCandles = klineResult.data;
    const candles = formattedCandles.map((item) => ({
      time: item.time,
      close: item.close,
    }));
    const topics = getKafkaTopicMap();
    const indicatorCacheKey = `indicator:${type}:${symbol.toUpperCase()}:${interval}:${limit}`;

    void messageBus.publish(topics.indicatorComputeRequest, `${type}:${symbol.toUpperCase()}:${interval}`, {
      type,
      symbol: symbol.toUpperCase(),
      interval,
      limit,
      baseUrl: klineResult.baseUrl,
      candles,
      requestedAt: Date.now(),
    });

    const payload = {
      baseUrl: klineResult.baseUrl,
      ...computeIndicatorBundle(candles),
    };
    await cacheStore.set(indicatorCacheKey, payload, 3_000);
    void messageBus.publish(topics.indicatorSnapshot, `${type}:${symbol.toUpperCase()}:${interval}`, {
      type,
      symbol: symbol.toUpperCase(),
      interval,
      limit,
      ...payload,
    });
  } catch (error) {
    logBackgroundIssue(
      `indicator:${type}:${symbol.toUpperCase()}:${interval}:${limit}`,
      'Failed to refresh indicator snapshot in background',
      error
    );
  }
}

async function warmActiveQuerySubscription(subscription: ActiveQuerySubscription) {
  const now = Date.now();
  const primaryWarmIntervalMs = getActiveWarmIntervalMs(subscription.interval);

  if (now - subscription.lastKlineWarmAt >= primaryWarmIntervalMs) {
    subscription.lastKlineWarmAt = now;
    for (const warmInterval of subscription.warmIntervals) {
      const inflightKey = `kline:${subscription.type}:${subscription.symbol}:${warmInterval}:${subscription.limit}`;
      if (activeQueryRefreshInflight.has(inflightKey)) {
        continue;
      }

      activeQueryRefreshInflight.add(inflightKey);
      void fetchAndPublishKlineSnapshot(subscription.type, subscription.symbol, warmInterval, subscription.limit)
        .catch((error) => {
          logBackgroundIssue(
            inflightKey,
            'Failed to warm active kline subscription',
            error
          );
        })
        .finally(() => {
          activeQueryRefreshInflight.delete(inflightKey);
        });
    }
  }

  if (!subscription.keepIndicatorsWarm || now - subscription.lastIndicatorWarmAt < primaryWarmIntervalMs) {
    return;
  }

  const indicatorInflightKey = `indicator:${subscription.key}`;
  if (activeQueryRefreshInflight.has(indicatorInflightKey)) {
    return;
  }

  activeQueryRefreshInflight.add(indicatorInflightKey);
  subscription.lastIndicatorWarmAt = Date.now();

  try {
    await refreshIndicatorSnapshotInBackground(subscription.type, subscription.symbol, subscription.interval, subscription.limit);
  } finally {
    activeQueryRefreshInflight.delete(indicatorInflightKey);
  }
}

setInterval(() => {
  pruneExpiredActiveQuerySubscriptions();
  const subscriptions = Array.from(activeQuerySubscriptions.values());
  subscriptions.forEach((subscription) => {
    void warmActiveQuerySubscription(subscription);
  });
}, ACTIVE_QUERY_SWEEP_MS);

function toQueryString(params: Record<string, string | number | boolean | undefined>) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    searchParams.set(key, String(value));
  });
  return searchParams.toString();
}

function sign(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function signedRequest({
  type,
  method,
  path,
  params,
  apiKey,
  apiSecret,
}: {
  type: BinanceMarketType;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  apiKey: string;
  apiSecret: string;
}) {
  const rankedBaseUrls = await getRankedBinanceBaseUrls(type, 2200);
  const timePath = type === 'spot' ? '/api/v3/time' : '/fapi/v1/time';
  const { data: timeData } = await fetchPublicBinance(type, timePath, 2200);
  const timestamp = Number(timeData.serverTime || Date.now());

  const query = toQueryString({
    recvWindow: 5000,
    timestamp,
    ...(params || {}),
  });
  const signature = sign(apiSecret, query);
  const signedQuery = `${query}&signature=${signature}`;

  let lastError: unknown = null;

  for (const baseUrl of rankedBaseUrls) {
    try {
      const response = await fetch(`${baseUrl}${path}?${signedQuery}`, {
        method,
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
      });

      const rawText = await response.text();
      const json = rawText ? JSON.parse(rawText) : null;

      if (!response.ok) {
        throw new Error(json?.msg || json?.message || `Request failed with status ${response.status}`);
      }

      return {
        data: json,
        baseUrl,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Binance signed request failed');
}

app.get('/health', async (_req, res) => {
  const payload = { ok: true, cache: await cacheStore.getStats(), bus: await messageBus.getStats() };
  const topics = getKafkaTopicMap();
  void messageBus.publish(topics.proxyHealth, 'proxy', {
    updatedAt: Date.now(),
    cache: payload.cache,
    bus: payload.bus,
  });
  res.json(payload);
});

app.get('/api/binance/cache/stats', async (_req, res) => {
  res.json(await cacheStore.getStats());
});

app.get('/api/binance/bus/stats', async (_req, res) => {
  res.json(await messageBus.getStats());
});

app.get('/api/binance/storage/stats', async (_req, res) => {
  res.json(await clickhouseStore.getStats());
});

app.get('/api/binance/runtime/health', async (_req, res) => {
  const [proxyHealth, projectionConsumer, streamCompute, clickhousePersist] = await Promise.all([
    cacheStore.get('bus:proxy:health'),
    getRuntimeHealthSnapshot('kafka-projection-consumer'),
    getRuntimeHealthSnapshot('stream-compute-worker'),
    getRuntimeHealthSnapshot('clickhouse-persistence-worker'),
  ]);

  res.json({
    proxy: proxyHealth,
    kafkaProjectionConsumer: projectionConsumer,
    streamComputeWorker: streamCompute,
    clickhousePersistenceWorker: clickhousePersist,
    activeQuerySubscriptions: activeQuerySubscriptions.size,
    updatedAt: Date.now(),
  });
});

app.get('/api/binance/runtime/ccxt', (_req, res) => {
  res.json(getCcxtTelemetrySnapshot());
});

app.get('/api/binance/runtime/clash/benchmark', async (req, res) => {
  try {
    const exchange = String(req.query.exchange || 'binance').toLowerCase() === 'okx' ? 'okx' : 'binance';
    const ranked = await benchmarkClashSelector(exchange);
    res.json({
      exchange,
      ranked,
      updatedAt: Date.now(),
    });
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Clash benchmark failed' });
  }
});

app.post('/api/binance/runtime/clash/optimize', async (req, res) => {
  try {
    const exchange = String(req.body?.exchange || 'binance').toLowerCase() === 'okx' ? 'okx' : 'binance';
    res.json(await optimizeClashSelector(exchange));
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Clash optimize failed' });
  }
});

app.post('/api/binance/query/subscribe', async (req, res) => {
  try {
    const {
      type,
      symbol,
      interval,
      limit,
      includeIndicators,
      warmIntervals,
    } = req.body as {
      type: BinanceMarketType;
      symbol: string;
      interval?: string;
      limit?: number;
      includeIndicators?: boolean;
      warmIntervals?: string[];
    };

    if (!type || !symbol) {
      res.status(400).json({ message: 'type and symbol are required' });
      return;
    }

    const normalizedInterval = interval || '1h';
    const normalizedLimit = Math.min(Math.max(Number(limit || 1000), 50), 1500);
    const subscription = await upsertActiveQuerySubscription(
      type,
      symbol,
      normalizedInterval,
      normalizedLimit,
      Boolean(includeIndicators),
      warmIntervals
    );

    res.json({
      ok: true,
      key: subscription.key,
      keepIndicatorsWarm: subscription.keepIndicatorsWarm,
      warmIntervals: subscription.warmIntervals,
      expiresAt: subscription.expiresAt,
      warmIntervalMs: getActiveWarmIntervalMs(subscription.interval),
    });
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Active query subscribe error' });
  }
});

app.post('/api/binance/public', async (req, res) => {
  try {
    const { type, path, timeoutMs, exchange } = req.body as { type: BinanceMarketType; path: string; timeoutMs?: number; exchange?: MarketExchange };
    if (!type || !path) {
      res.status(400).json({ message: 'type and path are required' });
      return;
    }

    const result = await fetchPublicBinance(type, path, timeoutMs, exchange || 'binance');
    res.json(result);
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Binance public proxy error' });
  }
});

app.post('/api/binance/orderbook/projected', async (req, res) => {
  try {
    const {
      type,
      symbol,
      limit,
      step,
    } = req.body as {
      type: BinanceMarketType;
      symbol: string;
      limit?: number;
      step?: number;
    };

    if (!type || !symbol) {
      res.status(400).json({ message: 'type and symbol are required' });
      return;
    }

    const manager = getOrderBookProjection(type, symbol);
    const cap = getOrderbookProjectionLimitCap(type);
    const normalizedStep = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : undefined;
    const result = manager.getProjection(Math.min(Math.max(Number(limit || 160), 20), cap), normalizedStep);
    res.json(result);
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Projected orderbook proxy error' });
  }
});

app.post('/api/binance/klines/query', async (req, res) => {
  try {
    const {
      type,
      symbol,
      interval,
      limit,
    } = req.body as {
      type: BinanceMarketType;
      symbol: string;
      interval?: string;
      limit?: number;
    };

    if (!type || !symbol) {
      res.status(400).json({ message: 'type and symbol are required' });
      return;
    }

    const normalizedInterval = interval || '1h';
    const normalizedLimit = Math.min(Math.max(Number(limit || 1000), 50), 1500);
    await upsertActiveQuerySubscription(type, symbol, normalizedInterval, normalizedLimit, false);
    const historicalRows = await queryHistoricalKlines(type, symbol, normalizedInterval, normalizedLimit);
    const freshnessWindowMs = getFreshnessWindowMs(normalizedInterval);
    const historicalIsFresh = historicalRows.updatedAt !== null && Date.now() - historicalRows.updatedAt <= freshnessWindowMs;

    if (historicalRows.data.length >= Math.min(normalizedLimit, 200)) {
      if (!historicalIsFresh) {
        void fetchAndPublishKlineSnapshot(type, symbol, normalizedInterval, normalizedLimit).catch(() => undefined);
      }
      res.json({
        source: 'clickhouse',
        stale: !historicalIsFresh,
        updatedAt: historicalRows.updatedAt || Date.now(),
        data: historicalRows.data,
      });
      return;
    }

    const aggregatedRows = await queryAggregatedHistoricalKlines(type, symbol, normalizedInterval, normalizedLimit);
    if (aggregatedRows) {
      const aggregatedIsFresh = aggregatedRows.updatedAt !== null && aggregatedRows.updatedAt !== undefined
        ? Date.now() - aggregatedRows.updatedAt <= freshnessWindowMs
        : false;
      if (!aggregatedIsFresh) {
        void fetchAndPublishKlineSnapshot(type, symbol, normalizedInterval, normalizedLimit).catch(() => undefined);
      }
      res.json({
        source: aggregatedRows.source,
        stale: !aggregatedIsFresh,
        updatedAt: aggregatedRows.updatedAt || Date.now(),
        data: aggregatedRows.data,
      });
      return;
    }
    res.json(await fetchAndPublishKlineSnapshot(type, symbol, normalizedInterval, normalizedLimit));
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Historical kline query error' });
  }
});

app.post('/api/binance/indicators', async (req, res) => {
  try {
    const {
      type,
      symbol,
      interval,
      limit,
    } = req.body as {
      type: BinanceMarketType;
      symbol: string;
      interval?: string;
      limit?: number;
    };

    if (!type || !symbol) {
      res.status(400).json({ message: 'type and symbol are required' });
      return;
    }

    const normalizedInterval = interval || '1h';
    const normalizedLimit = Math.min(Math.max(Number(limit || 1000), 100), 1500);
    await upsertActiveQuerySubscription(type, symbol, normalizedInterval, normalizedLimit, true);
    const indicatorCacheKey = `indicator:${type}:${symbol.toUpperCase()}:${normalizedInterval}:${normalizedLimit}`;
    const cached = await cacheStore.get<{
      baseUrl: string;
      updatedAt: number;
      ma: Record<string, unknown>;
      ema: Record<string, unknown>;
      rsi: unknown[];
      macd: Record<string, unknown>;
    }>(indicatorCacheKey);

    if (cached) {
      res.json(cached);
      return;
    }

    const historicalSnapshot = await queryHistoricalIndicatorSnapshot(type, symbol, normalizedInterval, normalizedLimit);
    if (historicalSnapshot) {
      const freshnessWindowMs = getFreshnessWindowMs(normalizedInterval);
      const isFresh = Date.now() - historicalSnapshot.updatedAt <= freshnessWindowMs;
      if (!isFresh) {
        void refreshIndicatorSnapshotInBackground(type, symbol, normalizedInterval, normalizedLimit);
      }
      await cacheStore.set(indicatorCacheKey, historicalSnapshot, 3_000);
      res.json({
        ...historicalSnapshot,
        stale: !isFresh,
      });
      return;
    }

    const klineResult = await fetchAndPublishKlineSnapshot(type, symbol, normalizedInterval, normalizedLimit);
    const formattedCandles = klineResult.data;
    const candles = formattedCandles.map((item) => ({
      time: item.time,
      close: item.close,
    }));
    const topics = getKafkaTopicMap();
    void messageBus.publish(topics.indicatorComputeRequest, `${type}:${symbol.toUpperCase()}:${normalizedInterval}`, {
      type,
      symbol: symbol.toUpperCase(),
      interval: normalizedInterval,
      limit: normalizedLimit,
      baseUrl: klineResult.baseUrl,
      candles,
      requestedAt: Date.now(),
    });

    const payload = {
      baseUrl: klineResult.baseUrl,
      ...computeIndicatorBundle(candles),
    };
    await cacheStore.set(indicatorCacheKey, payload, 3_000);
    void messageBus.publish(topics.indicatorSnapshot, `${type}:${symbol.toUpperCase()}:${normalizedInterval}`, {
      type,
      symbol: symbol.toUpperCase(),
      interval: normalizedInterval,
      limit: normalizedLimit,
      ...payload,
    });
    res.json(payload);
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Binance indicator proxy error' });
  }
});

app.post('/api/binance/account-stream/open', async (req, res) => {
  try {
    const { credentials } = req.body as { credentials?: { apiKey?: string; apiSecret?: string } };
    if (!credentials?.apiKey || !credentials?.apiSecret) {
      res.status(400).json({ message: 'apiKey and apiSecret are required' });
      return;
    }

    const token = createAccountStreamSession(
      {
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      }
    );
    res.json({ token });
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Failed to open account stream' });
  }
});

app.post('/api/binance/account-stream/close', (req, res) => {
  const { token } = req.body as { token?: string };
  if (token) {
    closeAccountStreamSession(token);
  }
  res.json({ ok: true });
});

app.post('/api/binance/signed', async (req, res) => {
  try {
    const { type, method, path, params, credentials } = req.body as {
      type: BinanceMarketType;
      method: 'GET' | 'POST' | 'DELETE';
      path: string;
      params?: Record<string, string | number | boolean | undefined>;
      credentials?: { apiKey?: string; apiSecret?: string };
    };

    if (!type || !method || !path || !credentials?.apiKey || !credentials?.apiSecret) {
      res.status(400).json({ message: 'type, method, path, apiKey, and apiSecret are required' });
      return;
    }
    const normalizedCredentials = {
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    };

    let data: unknown;
    if (method === 'GET' && path === '/api/v3/account') {
      data = { balances: await fetchSpotAccountCcxt(normalizedCredentials) };
    } else if (method === 'GET' && path === '/fapi/v2/balance') {
      data = await fetchFuturesBalancesCcxt(normalizedCredentials);
    } else if (method === 'POST' && path === '/sapi/v1/asset/get-funding-asset') {
      data = await fetchFundingBalancesCcxt(normalizedCredentials);
    } else if (method === 'GET' && path === '/fapi/v2/positionRisk') {
      data = await fetchFuturesPositionsCcxt(normalizedCredentials);
    } else if (method === 'GET' && path === '/api/v3/openOrders') {
      data = await fetchOpenOrdersCcxt('spot', normalizedCredentials);
    } else if (method === 'GET' && path === '/fapi/v1/openOrders') {
      data = await fetchOpenOrdersCcxt('futures', normalizedCredentials);
    } else if (method === 'GET' && path === '/api/v3/allOrders') {
      data = await fetchOrderHistoryCcxt('spot', String(params?.symbol || ''), normalizedCredentials, Number(params?.limit || 20));
    } else if (method === 'GET' && path === '/fapi/v1/allOrders') {
      data = await fetchOrderHistoryCcxt('futures', String(params?.symbol || ''), normalizedCredentials, Number(params?.limit || 20));
    } else if (method === 'GET' && path === '/api/v3/myTrades') {
      data = await fetchTradeHistoryCcxt('spot', String(params?.symbol || ''), normalizedCredentials, Number(params?.limit || 20));
    } else if (method === 'GET' && path === '/fapi/v1/userTrades') {
      data = await fetchTradeHistoryCcxt('futures', String(params?.symbol || ''), normalizedCredentials, Number(params?.limit || 20));
    } else if (method === 'POST' && path === '/fapi/v1/leverage') {
      await setFuturesLeverageCcxt(String(params?.symbol || ''), Number(params?.leverage || 1), normalizedCredentials);
      data = { ok: true };
    } else if (method === 'POST' && path === '/fapi/v1/marginType') {
      await setFuturesMarginTypeCcxt(String(params?.symbol || ''), String(params?.marginType || 'CROSSED').toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED', normalizedCredentials);
      data = { ok: true };
    } else if (method === 'POST' && (path === '/api/v3/order' || path === '/fapi/v1/order')) {
      data = await placeOrderCcxt(type, normalizedCredentials, params || {});
    } else if (method === 'DELETE' && (path === '/api/v3/order' || path === '/fapi/v1/order')) {
      data = await cancelOrderCcxt(type, normalizedCredentials, {
        symbol: String(params?.symbol || ''),
        orderId: Number(params?.orderId || 0),
      });
    } else {
      throw new Error(`Unsupported signed path for ccxt adapter: ${method} ${path}`);
    }

    const result = { data, baseUrl: `ccxt:${type}` };
    res.json(result);
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'Binance signed proxy error' });
  }
});

orderbookWss.on('connection', (socket, req) => {
  const requestUrl = new URL(req.url || '/ws/binance/orderbook', `http://${req.headers.host || '127.0.0.1'}`);
  const type = requestUrl.searchParams.get('type') as BinanceMarketType | null;
  const symbol = requestUrl.searchParams.get('symbol');
  const cap = getOrderbookProjectionLimitCap(type || 'spot');
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get('limit') || 160), 20), cap);
  const stepValue = Number(requestUrl.searchParams.get('step'));
  const step = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : undefined;

  if (!type || !symbol || !['spot', 'futures'].includes(type)) {
    socket.send(JSON.stringify({ message: 'type and symbol are required' }));
    socket.close();
    return;
  }

  const manager = getOrderBookProjection(type, symbol);
  const unsubscribe = manager.subscribe(limit, step, (payload) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  });

  socket.on('close', () => {
    unsubscribe();
  });

  socket.on('error', () => {
    unsubscribe();
  });
});

marketWss.on('connection', (socket, req) => {
  const requestUrl = new URL(req.url || '/ws/binance/market', `http://${req.headers.host || '127.0.0.1'}`);
  const type = requestUrl.searchParams.get('type') as BinanceMarketType | null;

  if (!type || !['spot', 'futures'].includes(type)) {
    socket.send(JSON.stringify({ message: 'type is required' }));
    socket.close();
    return;
  }

  const projection = getMarketStreamProjection(type, fetchPublicBinance);
  const unsubscribe = projection.subscribe((payload) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  });

  socket.on('close', () => {
    unsubscribe();
  });

  socket.on('error', () => {
    unsubscribe();
  });
});

accountWss.on('connection', (socket, req) => {
  const requestUrl = new URL(req.url || '/ws/binance/account', `http://${req.headers.host || '127.0.0.1'}`);
  const token = requestUrl.searchParams.get('token');

  if (!token) {
    socket.send(JSON.stringify({ message: 'token is required' }));
    socket.close();
    return;
  }

  const session = getAccountStreamSession(token);
  if (!session) {
    socket.send(JSON.stringify({ message: 'account stream session not found' }));
    socket.close();
    return;
  }

  const unsubscribe = session.subscribe((payload) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  });

  socket.on('close', () => {
    unsubscribe();
  });

  socket.on('error', () => {
    unsubscribe();
  });
});

server.listen(port, () => {
  console.log(`Binance local proxy listening on http://127.0.0.1:${port}`);
});
