import { getCacheStore } from './cache-store';
import { getKafkaTopicMap, getMessageBus } from './message-bus';
import { useCcxtMarketData } from './ccxt-market-data';

type BinanceMarketType = 'spot' | 'futures';

const TOP_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

const SPOT_WS_URL = `wss://stream.binance.com:9443/stream?streams=${TOP_SYMBOLS.map((s) => `${s.toLowerCase()}@ticker`).join('/')}`;
const FUTURES_WS_URL = `wss://fstream.binance.com/stream?streams=${TOP_SYMBOLS.map((s) => `${s.toLowerCase()}@ticker`).join('/')}`;
const FUNDING_POLL_INTERVAL_MS = 10_000;
const MARKET_CACHE_TTL_MS = 15_000;
const CCXT_MARKET_POLL_INTERVAL_MS = 1500;

interface TickerPayload {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

interface FundingPayload {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface MarketPayload {
  type: BinanceMarketType;
  tickers: TickerPayload[];
  fundingRates: FundingPayload[];
  updatedAt: number;
}

type Listener = (payload: MarketPayload) => void;

function getFundingPath() {
  return '/fapi/v1/premiumIndex';
}

export class MarketStreamProjection {
  private listeners = new Map<number, Listener>();
  private nextListenerId = 1;
  private tickers = new Map<string, TickerPayload>();
  private fundingRates = new Map<string, FundingPayload>();
  private ws: WebSocket | null = null;
  private fundingTimer: ReturnType<typeof setInterval> | null = null;
  private updatedAt = 0;
  private started = false;
  private readonly cacheStore = getCacheStore();
  private readonly messageBus = getMessageBus();

  constructor(
    private readonly type: BinanceMarketType,
    private readonly fetchPublic: (type: BinanceMarketType, path: string, timeoutMs?: number) => Promise<{ data: unknown; baseUrl: string }>,
  ) {}

  private getWsUrl() {
    return this.type === 'spot' ? SPOT_WS_URL : FUTURES_WS_URL;
  }

  private getCacheKey() {
    return `market:${this.type}:top-symbols`;
  }

  private async restoreCachedPayload() {
    const cached = await this.cacheStore.get<MarketPayload>(this.getCacheKey());
    if (!cached) return;

    cached.tickers.forEach((ticker) => {
      this.tickers.set(ticker.symbol, ticker);
    });
    cached.fundingRates.forEach((fundingRate) => {
      this.fundingRates.set(fundingRate.symbol, fundingRate);
    });
    this.updatedAt = cached.updatedAt || Date.now();
  }

  private publish() {
    this.updatedAt = Date.now();
    const payload: MarketPayload = {
      type: this.type,
      tickers: TOP_SYMBOLS.map((symbol) => this.tickers.get(symbol)).filter(Boolean) as TickerPayload[],
      fundingRates: TOP_SYMBOLS.map((symbol) => this.fundingRates.get(symbol)).filter(Boolean) as FundingPayload[],
      updatedAt: this.updatedAt,
    };

    void this.cacheStore.set(this.getCacheKey(), payload, MARKET_CACHE_TTL_MS);
    const topics = getKafkaTopicMap();
    void this.messageBus.publish(topics.marketSnapshot, this.type, payload);
    this.listeners.forEach((listener) => listener(payload));
  }

  private async pollFunding() {
    if (this.type !== 'futures') return;
    try {
      const result = await this.fetchPublic('futures', getFundingPath(), 2200);
      const fundingData = Array.isArray(result.data) ? result.data : [];
      fundingData.forEach((item: any) => {
        if (!TOP_SYMBOLS.includes(item.symbol)) return;
        this.fundingRates.set(item.symbol, {
          symbol: item.symbol,
          lastFundingRate: item.lastFundingRate,
          nextFundingTime: item.nextFundingTime,
        });
      });
      this.publish();
    } catch (error) {
      console.warn('Failed to poll funding rates for market stream', error);
    }
  }

  private connectWs() {
    if (useCcxtMarketData()) {
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.getWsUrl());
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const ticker = message.data;
      if (!ticker?.s || !TOP_SYMBOLS.includes(ticker.s)) return;

      this.tickers.set(ticker.s, {
        symbol: ticker.s,
        lastPrice: ticker.c,
        priceChangePercent: ticker.P,
        quoteVolume: ticker.q,
      });
      this.publish();
    };

    this.ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connectWs(), 1000);
    };

    this.ws.onerror = () => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      }
    };
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    void this.restoreCachedPayload();
    if (useCcxtMarketData()) {
      void this.pollTickerSnapshot();
      this.fundingTimer = setInterval(() => {
        void this.pollTickerSnapshot();
        if (this.type === 'futures') {
          void this.pollFunding();
        }
      }, CCXT_MARKET_POLL_INTERVAL_MS);
      if (this.type === 'futures') {
        void this.pollFunding();
      }
      return;
    }

    this.connectWs();
    if (this.type === 'futures') {
      void this.pollFunding();
      this.fundingTimer = setInterval(() => {
        void this.pollFunding();
      }, FUNDING_POLL_INTERVAL_MS);
    }
  }

  private async pollTickerSnapshot() {
    try {
      const path = this.type === 'spot' ? '/api/v3/ticker/24hr' : '/fapi/v1/ticker/24hr';
      const result = await this.fetchPublic(this.type, path, 2200);
      const tickerData = Array.isArray(result.data) ? result.data : [];
      tickerData.forEach((item: any) => {
        if (!TOP_SYMBOLS.includes(item.symbol)) return;
        this.tickers.set(item.symbol, {
          symbol: item.symbol,
          lastPrice: item.lastPrice,
          priceChangePercent: item.priceChangePercent,
          quoteVolume: item.quoteVolume,
        });
      });
      this.publish();
    } catch (error) {
      console.warn('Failed to poll market tickers via public adapter', error);
    }
  }

  subscribe(listener: Listener) {
    this.ensureStarted();
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    listener({
      type: this.type,
      tickers: TOP_SYMBOLS.map((symbol) => this.tickers.get(symbol)).filter(Boolean) as TickerPayload[],
      fundingRates: TOP_SYMBOLS.map((symbol) => this.fundingRates.get(symbol)).filter(Boolean) as FundingPayload[],
      updatedAt: this.updatedAt,
    });

    return () => {
      this.listeners.delete(id);
    };
  }
}

const projections = new Map<BinanceMarketType, MarketStreamProjection>();

export function getMarketStreamProjection(
  type: BinanceMarketType,
  fetchPublic: (type: BinanceMarketType, path: string, timeoutMs?: number) => Promise<{ data: unknown; baseUrl: string }>
) {
  const existing = projections.get(type);
  if (existing) return existing;
  const projection = new MarketStreamProjection(type, fetchPublic);
  projections.set(type, projection);
  return projection;
}
