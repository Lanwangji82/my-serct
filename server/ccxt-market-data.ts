import ccxt from 'ccxt';
import { getCcxtProxyOptions } from './proxy-config';
import { recordCcxtTelemetry } from './ccxt-telemetry';

type BinanceMarketType = 'spot' | 'futures';
export type MarketExchange = 'binance' | 'okx';

const QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'];
const exchangeCache = new Map<string, any>();

function getExchange(type: BinanceMarketType, exchange: MarketExchange) {
  const cacheKey = `${exchange}:${type}`;
  const cached = exchangeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let instance: any;
  if (exchange === 'okx') {
    instance = new ccxt.okx({
      enableRateLimit: true,
      ...getCcxtProxyOptions({ brokerId: 'okx' }),
      options: {
        defaultType: type === 'spot' ? 'spot' : 'swap',
      },
    });
  } else if (type === 'spot') {
    instance = new ccxt.binance({
      enableRateLimit: true,
      ...getCcxtProxyOptions({ brokerId: 'binance' }),
    });
  } else {
    instance = new ccxt.binanceusdm({
      enableRateLimit: true,
      ...getCcxtProxyOptions({ brokerId: 'binance' }),
    });
  }

  exchangeCache.set(cacheKey, instance);
  return instance;
}

function toUnifiedSymbol(symbol: string) {
  const normalized = symbol.toUpperCase();
  for (const quote of QUOTES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return `${normalized.slice(0, -quote.length)}/${quote}`;
    }
  }
  return normalized;
}

function toCompactSymbol(symbol: string) {
  return symbol
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/SWAP/g, '')
    .replace(/USDTUSDT/g, 'USDT');
}

async function resolveMarketSymbol(exchangeName: MarketExchange, type: BinanceMarketType, compactSymbol: string) {
  const exchange = getExchange(type, exchangeName);
  const markets = await exchange.loadMarkets();
  const normalizedTarget = compactSymbol.toUpperCase();
  const marketList = Object.values(markets) as any[];
  const matched = marketList.find((market) => {
    if (exchangeName === 'okx') {
      const typeMatch = type === 'spot' ? Boolean(market.spot) : Boolean(market.swap || market.future);
      if (!typeMatch) return false;
      const compact = toCompactSymbol(String(market.symbol || market.id || ''));
      return compact === normalizedTarget;
    }
    return String(market.id || '').toUpperCase() === normalizedTarget;
  });

  if (matched?.symbol) {
    return matched.symbol as string;
  }
  return toUnifiedSymbol(compactSymbol);
}

function getQueryValue(pathname: string, key: string) {
  const url = new URL(`https://quantx.local${pathname}`);
  return url.searchParams.get(key);
}

async function fetchTickers(type: BinanceMarketType, exchangeName: MarketExchange) {
  const exchange = getExchange(type, exchangeName);
  const tickers = await exchange.fetchTickers();
  return Object.values(tickers).map((ticker: any) => ({
    symbol: toCompactSymbol(String(ticker.symbol || ticker.id || '')),
    lastPrice: String(ticker.last ?? ticker.close ?? 0),
    priceChangePercent: String(ticker.percentage ?? 0),
    quoteVolume: String(ticker.quoteVolume ?? 0),
  }));
}

async function fetchFundingRates(exchangeName: MarketExchange) {
  const exchange = getExchange('futures', exchangeName);
  const rates = await exchange.fetchFundingRates();
  return Object.values(rates).map((rate: any) => ({
    symbol: toCompactSymbol(String(rate.symbol || rate.id || '')),
    lastFundingRate: String(rate.fundingRate ?? 0),
    nextFundingTime: Number(rate.nextFundingTimestamp ?? 0),
  }));
}

async function fetchExchangeInfo(type: BinanceMarketType, exchangeName: MarketExchange) {
  const exchange = getExchange(type, exchangeName);
  const markets = await exchange.loadMarkets();
  return {
    symbols: Object.values(markets).map((market: any) => ({
      symbol: toCompactSymbol(String(market.symbol || market.id || '')),
      status: market.active === false ? 'BREAK' : 'TRADING',
      contractStatus: market.active === false ? 'BREAK' : 'TRADING',
      baseAsset: market.base,
      quoteAsset: market.quote,
    })),
  };
}

async function fetchKlines(type: BinanceMarketType, exchangeName: MarketExchange, path: string) {
  const exchange = getExchange(type, exchangeName);
  const symbol = await resolveMarketSymbol(exchangeName, type, getQueryValue(path, 'symbol') || '');
  const interval = getQueryValue(path, 'interval') || '1h';
  const limit = Number(getQueryValue(path, 'limit') || 500);
  const rows = await exchange.fetchOHLCV(symbol, interval, undefined, limit);
  return rows.map((item) => [item[0], String(item[1]), String(item[2]), String(item[3]), String(item[4]), String(item[5]), item[0], '0']);
}

async function fetchOrderBook(type: BinanceMarketType, exchangeName: MarketExchange, path: string) {
  const exchange = getExchange(type, exchangeName);
  const symbol = await resolveMarketSymbol(exchangeName, type, getQueryValue(path, 'symbol') || '');
  const limit = Number(getQueryValue(path, 'limit') || 100);
  const book = await exchange.fetchOrderBook(symbol, limit);
  return {
    lastUpdateId: Date.now(),
    asks: (book.asks || []).map((item) => [String(item[0]), String(item[1])]),
    bids: (book.bids || []).map((item) => [String(item[0]), String(item[1])]),
  };
}

export function useCcxtMarketData() {
  return (process.env.MARKET_DATA_DRIVER || 'ccxt').toLowerCase() === 'ccxt';
}

export async function fetchViaCcxt(type: BinanceMarketType, path: string, exchange: MarketExchange = 'binance') {
  const normalizedPath = path.split('?')[0];
  const startedAt = Date.now();
  const endpointLabel = `ccxt:${exchange}:${type}`;

  const execute = async <T>(operation: string, run: () => Promise<T>) => {
    try {
      const data = await run();
      recordCcxtTelemetry({
        scope: 'public',
        operation,
        exchange,
        marketType: type,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        endpointLabel,
      });
      return { data, baseUrl: endpointLabel };
    } catch (error) {
      recordCcxtTelemetry({
        scope: 'public',
        operation,
        exchange,
        marketType: type,
        status: 'error',
        durationMs: Date.now() - startedAt,
        endpointLabel,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  if (normalizedPath.endsWith('/ping')) {
    return execute('ping', async () => {
      await getExchange(type, exchange).fetchTime();
      return {};
    });
  }

  if (normalizedPath.endsWith('/time')) {
    return execute('time', async () => {
      const serverTime = await getExchange(type, exchange).fetchTime();
      return { serverTime };
    });
  }

  if (normalizedPath.endsWith('/ticker/24hr')) {
    return execute('ticker/24hr', () => fetchTickers(type, exchange));
  }

  if (normalizedPath.endsWith('/premiumIndex')) {
    return execute('premiumIndex', () => fetchFundingRates(exchange));
  }

  if (normalizedPath.endsWith('/exchangeInfo')) {
    return execute('exchangeInfo', () => fetchExchangeInfo(type, exchange));
  }

  if (normalizedPath.endsWith('/klines')) {
    return execute('klines', () => fetchKlines(type, exchange, path));
  }

  if (normalizedPath.endsWith('/depth')) {
    return execute('depth', () => fetchOrderBook(type, exchange, path));
  }

  throw new Error(`Unsupported ccxt market data path: ${path}`);
}
