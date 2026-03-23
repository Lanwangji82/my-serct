import { getCacheStore } from './cache-store';
import { getKafkaTopicMap, getMessageBus } from './message-bus';
import { fetchViaCcxt, useCcxtMarketData } from './ccxt-market-data';

type BinanceMarketType = 'spot' | 'futures';

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

const SPOT_ORDERBOOK_SNAPSHOT_LIMIT = 5000;
const FUTURES_ORDERBOOK_SNAPSHOT_LIMIT = 1000;
const SPOT_ORDERBOOK_MAX_LEVELS = 20000;
const FUTURES_ORDERBOOK_MAX_LEVELS = 4000;
const ORDERBOOK_RENDER_DEPTH = 160;
const ORDERBOOK_RESYNC_INTERVAL_MS = 90_000;
const ORDERBOOK_NOTIFY_INTERVAL_MS = 80;
const ORDERBOOK_CACHE_TTL_MS = 15_000;
const ORDERBOOK_LOG_THROTTLE_MS = 20_000;

type DepthUpdateMessage = {
  U?: number;
  u?: number;
  pu?: number;
  a?: string[][];
  b?: string[][];
};

type OrderbookProjectionPayload = {
  asks: string[][];
  bids: string[][];
  updatedAt: number;
  ready: boolean;
  step?: number;
};

function isValidLevelTuple(level: unknown): level is [string, string] {
  return Array.isArray(level)
    && level.length >= 2
    && typeof level[0] === 'string'
    && typeof level[1] === 'string';
}

function isValidRawOrderbookPayload(payload: unknown): payload is OrderbookProjectionPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<OrderbookProjectionPayload>;
  return Array.isArray(candidate.asks)
    && Array.isArray(candidate.bids)
    && candidate.asks.every(isValidLevelTuple)
    && candidate.bids.every(isValidLevelTuple)
    && typeof candidate.updatedAt === 'number'
    && typeof candidate.ready === 'boolean';
}

const orderbookLogTimestamps = new Map<string, number>();

function logOrderbookIssue(key: string, message: string, error?: unknown) {
  const now = Date.now();
  const lastLoggedAt = orderbookLogTimestamps.get(key) || 0;
  if (now - lastLoggedAt < ORDERBOOK_LOG_THROTTLE_MS) {
    return;
  }

  orderbookLogTimestamps.set(key, now);
  if (error) {
    console.warn(message, error);
    return;
  }
  console.warn(message);
}

function getBaseUrls(type: BinanceMarketType) {
  return type === 'spot' ? SPOT_BASE_URLS : FUTURES_BASE_URLS;
}

function getOrderbookSnapshotLimit(type: BinanceMarketType) {
  return type === 'spot' ? SPOT_ORDERBOOK_SNAPSHOT_LIMIT : FUTURES_ORDERBOOK_SNAPSHOT_LIMIT;
}

function getOrderbookMaxLevels(type: BinanceMarketType) {
  return type === 'spot' ? SPOT_ORDERBOOK_MAX_LEVELS : FUTURES_ORDERBOOK_MAX_LEVELS;
}

function trimDepthLevels(levels: Map<string, string>, keep: number, side: 'asks' | 'bids') {
  if (levels.size <= keep) return;
  const sortedPrices = Array.from(levels.entries())
    .map(([price, amount]) => ({ price, amount, numericPrice: Number(price) }))
    .filter((level) => Number.isFinite(level.numericPrice))
    .sort((a, b) => side === 'asks' ? a.numericPrice - b.numericPrice : b.numericPrice - a.numericPrice);

  levels.clear();
  sortedPrices.slice(0, keep).forEach((level) => {
    levels.set(level.price, level.amount);
  });
}

function applyDepthLevels(levels: Map<string, string>, updates: string[][] | undefined) {
  if (!updates?.length) return false;
  updates.forEach(([price, amount]) => {
    if (parseFloat(amount) === 0) levels.delete(price);
    else levels.set(price, amount);
  });
  return true;
}

function aggregateLevels(levels: Map<string, string>, step: number | undefined, side: 'asks' | 'bids', limit: number) {
  const sorted = Array.from(levels.entries())
    .map(([price, amount]) => ({ price: Number(price), amount: Number(amount) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.amount) && level.amount > 0)
    .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);

  if (!step || step <= 0) {
    return sorted.slice(0, limit).map((level) => [String(level.price), String(level.amount)]);
  }

  const grouped = new Map<number, number>();
  sorted.forEach((level) => {
    const bucket = side === 'asks'
      ? Math.ceil(level.price / step) * step
      : Math.floor(level.price / step) * step;
    const normalizedBucket = Number(bucket.toFixed(8));
    grouped.set(normalizedBucket, (grouped.get(normalizedBucket) || 0) + level.amount);
  });

  return Array.from(grouped.entries())
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => side === 'asks' ? a[0] - b[0] : b[0] - a[0])
    .slice(0, limit)
    .map(([price, amount]) => [String(price), String(amount)]);
}

async function fetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

class OrderBookProjection {
  private asks = new Map<string, string>();
  private bids = new Map<string, string>();
  private pendingEvents: DepthUpdateMessage[] = [];
  private snapshotLoaded = false;
  private isHydrating = false;
  private lastUpdateId = 0;
  private ws: WebSocket | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private updatedAt = 0;
  private readonly lowerSymbol: string;
  private listeners = new Map<number, { limit: number; step?: number; listener: (payload: OrderbookProjectionPayload) => void }>();
  private nextListenerId = 1;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cacheStore = getCacheStore();
  private readonly messageBus = getMessageBus();

  constructor(
    private readonly type: BinanceMarketType,
    private readonly symbol: string,
  ) {
    this.lowerSymbol = symbol.toLowerCase();
  }

  private getDepthPath() {
    const limit = getOrderbookSnapshotLimit(this.type);
    return this.type === 'spot'
      ? `/api/v3/depth?symbol=${this.symbol.toUpperCase()}&limit=${limit}`
      : `/fapi/v1/depth?symbol=${this.symbol.toUpperCase()}&limit=${limit}`;
  }

  private getWsUrl() {
    const baseUrl = this.type === 'spot' ? 'wss://stream.binance.com:9443' : 'wss://fstream.binance.com';
    return `${baseUrl}/ws/${this.lowerSymbol}@depth@100ms`;
  }

  private getCacheKey() {
    return `orderbook:${this.type}:${this.symbol.toUpperCase()}`;
  }

  private async restoreCachedProjection() {
    const cached = await this.cacheStore.get<OrderbookProjectionPayload>(this.getCacheKey());
    if (!cached?.ready) return;
    if (!isValidRawOrderbookPayload(cached)) {
      logOrderbookIssue(
        `${this.type}:${this.symbol.toUpperCase()}:cache`,
        `[orderbook] ignoring invalid cached projection for ${this.type}:${this.symbol.toUpperCase()}`
      );
      await this.cacheStore.delete(this.getCacheKey());
      return;
    }

    this.asks.clear();
    this.bids.clear();
    cached.asks.forEach((ask) => this.asks.set(ask[0], ask[1]));
    cached.bids.forEach((bid) => this.bids.set(bid[0], bid[1]));
    this.updatedAt = cached.updatedAt || Date.now();
    this.snapshotLoaded = true;
  }

  private reset() {
    this.asks.clear();
    this.bids.clear();
    this.pendingEvents.length = 0;
    this.snapshotLoaded = false;
    this.lastUpdateId = 0;
  }

  private markUpdated() {
    this.updatedAt = Date.now();
    this.scheduleNotify();
  }

  private getRawProjection(limit = ORDERBOOK_RENDER_DEPTH): OrderbookProjectionPayload {
    const asks = Array.from(this.asks.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, limit);
    const bids = Array.from(this.bids.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .slice(0, limit);

    return {
      asks,
      bids,
      updatedAt: this.updatedAt,
      ready: this.snapshotLoaded,
    };
  }

  private scheduleNotify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const cacheProjection = this.getRawProjection(getOrderbookMaxLevels(this.type));
      void this.cacheStore.set(this.getCacheKey(), cacheProjection, ORDERBOOK_CACHE_TTL_MS);
      this.listeners.forEach(({ limit, step, listener }) => {
        const projection = this.getProjection(limit, step);
        const topics = getKafkaTopicMap();
        void this.messageBus.publish(topics.orderbookProjection, `${this.type}:${this.symbol.toUpperCase()}`, {
          type: this.type,
          symbol: this.symbol.toUpperCase(),
          limit,
          ...projection,
        });
        listener(projection);
      });
    }, ORDERBOOK_NOTIFY_INTERVAL_MS);
  }

  private applyBufferedEvent(event: DepthUpdateMessage) {
    if (!event.u || !event.U) return true;
    if (event.u <= this.lastUpdateId) return true;

    const nextUpdateId = this.lastUpdateId + 1;
    const hasGap = typeof event.pu === 'number'
      ? event.pu !== this.lastUpdateId
      : event.U > nextUpdateId;

    if (this.lastUpdateId > 0 && hasGap) {
      return false;
    }

    const matchesSnapshot = event.U <= nextUpdateId && event.u >= nextUpdateId;
    if (this.lastUpdateId > 0 && !matchesSnapshot && event.U > nextUpdateId) {
      return false;
    }

    const asksUpdated = applyDepthLevels(this.asks, event.a);
    const bidsUpdated = applyDepthLevels(this.bids, event.b);

    const maxLevels = getOrderbookMaxLevels(this.type);
    if (this.asks.size > maxLevels) trimDepthLevels(this.asks, maxLevels, 'asks');
    if (this.bids.size > maxLevels) trimDepthLevels(this.bids, maxLevels, 'bids');

    if (asksUpdated || bidsUpdated) {
      this.markUpdated();
    }

    this.lastUpdateId = event.u;
    return true;
  }

  private async hydrateSnapshot() {
    if (this.isHydrating) return;
    this.isHydrating = true;

    try {
      const path = this.getDepthPath();
      let data: any = null;

      if (useCcxtMarketData()) {
        data = (await fetchViaCcxt(this.type, path)).data;
      } else {
        const baseUrls = getBaseUrls(this.type);
        for (const baseUrl of baseUrls) {
          try {
            data = await fetchJson(`${baseUrl}${path}`, 2200);
            break;
          } catch {
            continue;
          }
        }
      }

      if (!data?.asks || !data?.bids || typeof data.lastUpdateId !== 'number') {
        logOrderbookIssue(
          `${this.type}:${this.symbol.toUpperCase()}:snapshot`,
          `[orderbook] invalid snapshot payload for ${this.type}:${this.symbol.toUpperCase()}`
        );
        this.snapshotLoaded = false;
        return;
      }

      this.asks.clear();
      this.bids.clear();
      data.asks.forEach((ask: string[]) => this.asks.set(ask[0], ask[1]));
      data.bids.forEach((bid: string[]) => this.bids.set(bid[0], bid[1]));
      const maxLevels = getOrderbookMaxLevels(this.type);
      trimDepthLevels(this.asks, maxLevels, 'asks');
      trimDepthLevels(this.bids, maxLevels, 'bids');

      this.lastUpdateId = data.lastUpdateId;
      this.snapshotLoaded = true;

      while (this.pendingEvents.length > 0 && this.pendingEvents[0]?.u && this.pendingEvents[0].u <= this.lastUpdateId) {
        this.pendingEvents.shift();
      }

      const firstEvent = this.pendingEvents[0];
      if (firstEvent?.U && firstEvent?.u) {
        const nextUpdateId = this.lastUpdateId + 1;
        if (!(firstEvent.U <= nextUpdateId && firstEvent.u >= nextUpdateId)) {
          this.reset();
          return;
        }
      }

      while (this.pendingEvents.length > 0) {
        const nextEvent = this.pendingEvents.shift();
        if (!nextEvent) continue;
        const applied = this.applyBufferedEvent(nextEvent);
        if (!applied) {
          this.reset();
          return;
        }
      }

      this.markUpdated();
    } catch (error) {
      logOrderbookIssue(
        `${this.type}:${this.symbol.toUpperCase()}:hydrate`,
        `[orderbook] failed to hydrate snapshot for ${this.type}:${this.symbol.toUpperCase()}:`,
        error
      );
      this.snapshotLoaded = false;
    } finally {
      this.isHydrating = false;
      if (!this.snapshotLoaded) {
        setTimeout(() => {
          void this.hydrateSnapshot();
        }, 1500);
      }
    }
  }

  private connectWs() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.getWsUrl());
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as DepthUpdateMessage;
      if (!this.snapshotLoaded) {
        this.pendingEvents.push(data);
        if (this.pendingEvents.length > 200) {
          this.pendingEvents.splice(0, this.pendingEvents.length - 200);
        }
        return;
      }

      const applied = this.applyBufferedEvent(data);
      if (!applied) {
        this.reset();
        void this.hydrateSnapshot();
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connectWs(), 1000);
    };

    this.ws.onerror = () => {
      // Let the runtime transition the socket to closed state; forcing close() here
      // can recurse through the Node 22 WebSocket error path.
    };
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    void this.restoreCachedProjection().catch((error) => {
      logOrderbookIssue(
        `${this.type}:${this.symbol.toUpperCase()}:restore`,
        `[orderbook] failed to restore cached projection for ${this.type}:${this.symbol.toUpperCase()}:`,
        error
      );
    });
    void this.hydrateSnapshot();
    if (useCcxtMarketData()) {
      this.resyncTimer = setInterval(() => {
        void this.hydrateSnapshot();
      }, 1000);
      return;
    }
    this.connectWs();
    this.resyncTimer = setInterval(() => {
      this.reset();
      void this.hydrateSnapshot();
    }, ORDERBOOK_RESYNC_INTERVAL_MS);
  }

  getProjection(limit = ORDERBOOK_RENDER_DEPTH, step?: number): OrderbookProjectionPayload {
    this.ensureStarted();
    const asks = aggregateLevels(this.asks, step, 'asks', limit);
    const bids = aggregateLevels(this.bids, step, 'bids', limit);

    return {
      asks,
      bids,
      updatedAt: this.updatedAt,
      ready: this.snapshotLoaded,
      step,
    };
  }

  subscribe(
    limit: number,
    step: number | undefined,
    listener: (payload: OrderbookProjectionPayload) => void
  ) {
    this.ensureStarted();
    const id = this.nextListenerId++;
    this.listeners.set(id, { limit, step, listener });
    listener(this.getProjection(limit, step));

    return () => {
      this.listeners.delete(id);
    };
  }
}

const orderBookManagers = new Map<string, OrderBookProjection>();

export function getOrderBookProjection(type: BinanceMarketType, symbol: string) {
  const key = `${type}:${symbol.toUpperCase()}`;
  const existing = orderBookManagers.get(key);
  if (existing) return existing;
  const manager = new OrderBookProjection(type, symbol.toUpperCase());
  orderBookManagers.set(key, manager);
  return manager;
}
