import ccxt from 'ccxt';
import { getCcxtProxyOptions } from './proxy-config';
import { recordCcxtTelemetry } from './ccxt-telemetry';

type BinanceMarketType = 'spot' | 'futures';
type BrokerExchange = 'binance' | 'okx';

export interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface FuturesBalance {
  asset: string;
  balance: string;
  availableBalance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
}

export interface FundingBalance {
  asset: string;
  free: string;
  locked: string;
  freeze: string;
  withdrawing: string;
  btcValuation: string;
}

export interface FuturesPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  notional: string;
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: string;
  type: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  updateTime?: number;
  time?: number;
  avgPrice?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
}

export interface BinanceTradeFill {
  symbol: string;
  id: number;
  orderId: number;
  side?: string;
  price: string;
  qty: string;
  quoteQty?: string;
  realizedPnl?: string;
  commission?: string;
  commissionAsset?: string;
  time: number;
  buyer?: boolean;
}

function createSpotExchange(credentials: { apiKey: string; apiSecret: string }) {
  return new ccxt.binance({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    ...getCcxtProxyOptions(),
  });
}

function createFuturesExchange(credentials: { apiKey: string; apiSecret: string }) {
  return new ccxt.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    ...getCcxtProxyOptions(),
  });
}

function createOkxExchange(type: BinanceMarketType, credentials: { apiKey: string; apiSecret: string; password?: string }) {
  return new ccxt.okx({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    password: credentials.password || process.env.OKX_API_PASSPHRASE || '',
    enableRateLimit: true,
    ...getCcxtProxyOptions(),
    options: {
      defaultType: type === 'spot' ? 'spot' : 'swap',
    },
  });
}

function toUnifiedSymbol(symbol: string) {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('USDT')) return `${normalized.slice(0, -4)}/USDT`;
  if (normalized.endsWith('USDC')) return `${normalized.slice(0, -4)}/USDC`;
  return normalized;
}

function toCompactSymbol(symbol: string) {
  return symbol.toUpperCase().replace('/', '').replace(':USDT', '');
}

function normalizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown ccxt error');
  if (/api[- ]?key|permission|auth|invalid/i.test(message)) {
    return 'Binance rejected this API key or permission scope.';
  }
  if (/network|timeout|fetch failed|econnreset|timed out/i.test(message)) {
    return 'Unable to reach Binance through ccxt right now.';
  }
  return message;
}

function normalizeBrokerError(exchange: BrokerExchange, error: unknown) {
  const normalized = normalizeError(error);
  if (exchange === 'binance') {
    return normalized;
  }
  if (/api[- ]?key|permission|auth|invalid|passphrase/i.test(String(error instanceof Error ? error.message : error))) {
    return 'The broker rejected this API key, secret, or passphrase.';
  }
  if (/network|timeout|fetch failed|econnreset|timed out/i.test(String(error instanceof Error ? error.message : error))) {
    return 'Unable to reach the broker through ccxt right now.';
  }
  return normalized;
}

function normalizeOrder(order: any): BinanceOrder {
  return {
    symbol: toCompactSymbol(String(order.symbol || order.info?.symbol || '')),
    orderId: Number(order.id || order.info?.orderId || 0),
    clientOrderId: String(order.clientOrderId || order.info?.clientOrderId || ''),
    side: String(order.side || order.info?.side || '').toUpperCase(),
    type: String(order.type || order.info?.type || '').toUpperCase(),
    status: String(order.status || order.info?.status || '').toUpperCase(),
    price: String(order.price ?? order.info?.price ?? 0),
    origQty: String(order.amount ?? order.info?.origQty ?? 0),
    executedQty: String(order.filled ?? order.info?.executedQty ?? 0),
    updateTime: Number(order.lastUpdateTimestamp || order.info?.updateTime || 0),
    time: Number(order.timestamp || order.info?.time || 0),
    avgPrice: String(order.average ?? order.info?.avgPrice ?? 0),
    stopPrice: String(order.stopPrice ?? order.info?.stopPrice ?? 0),
    reduceOnly: Boolean(order.reduceOnly ?? order.info?.reduceOnly ?? false),
  };
}

function normalizeTrade(trade: any): BinanceTradeFill {
  return {
    symbol: toCompactSymbol(String(trade.symbol || trade.info?.symbol || '')),
    id: Number(trade.id || trade.info?.id || 0),
    orderId: Number(trade.order || trade.info?.orderId || 0),
    side: trade.side ? String(trade.side).toUpperCase() : undefined,
    price: String(trade.price ?? trade.info?.price ?? 0),
    qty: String(trade.amount ?? trade.info?.qty ?? 0),
    quoteQty: String(trade.cost ?? trade.info?.quoteQty ?? 0),
    realizedPnl: String(trade.info?.realizedPnl ?? 0),
    commission: String(trade.fee?.cost ?? trade.info?.commission ?? 0),
    commissionAsset: String(trade.fee?.currency ?? trade.info?.commissionAsset ?? ''),
    time: Number(trade.timestamp || trade.info?.time || 0),
    buyer: typeof trade.side === 'string' ? trade.side.toLowerCase() === 'buy' : undefined,
  };
}

async function withCcxtPrivateTelemetry<T>(
  marketType: BinanceMarketType,
  operation: string,
  run: () => Promise<T>,
  exchange: BrokerExchange = 'binance',
) {
  const startedAt = Date.now();
  const endpointLabel = `ccxt:${exchange}:${marketType}:private`;
  try {
    const data = await run();
    recordCcxtTelemetry({
      scope: 'private',
      operation,
      exchange,
      marketType,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      endpointLabel,
    });
    return data;
  } catch (error) {
    recordCcxtTelemetry({
      scope: 'private',
      operation,
      exchange,
      marketType,
      status: 'error',
      durationMs: Date.now() - startedAt,
      endpointLabel,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function validateCcxtBinanceCredentials(credentials: { apiKey: string; apiSecret: string }) {
  try {
    await Promise.allSettled([
      withCcxtPrivateTelemetry('spot', 'validateCredentials:spot', () => createSpotExchange(credentials).fetchBalance()),
      withCcxtPrivateTelemetry('futures', 'validateCredentials:futures', () => createFuturesExchange(credentials).fetchBalance()),
    ]);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchSpotAccountCcxt(credentials: { apiKey: string; apiSecret: string }) {
  try {
    const balance = await withCcxtPrivateTelemetry('spot', 'fetchSpotAccount', () => createSpotExchange(credentials).fetchBalance());
    return Object.entries(balance.free || {}).map(([asset, free]) => ({
      asset,
      free: String(free ?? 0),
      locked: String(balance.used?.[asset] ?? 0),
    })).filter((item) => Number(item.free) > 0 || Number(item.locked) > 0) as SpotBalance[];
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchFuturesBalancesCcxt(credentials: { apiKey: string; apiSecret: string }) {
  try {
    const balance = await withCcxtPrivateTelemetry('futures', 'fetchFuturesBalances', () => createFuturesExchange(credentials).fetchBalance());
    const assets = Array.isArray((balance.info as any)?.assets) ? (balance.info as any).assets : [];
    return assets.map((item: any) => ({
      asset: String(item.asset || ''),
      balance: String(item.walletBalance ?? item.marginBalance ?? 0),
      availableBalance: String(item.availableBalance ?? item.availableMargin ?? 0),
      crossWalletBalance: String(item.crossWalletBalance ?? item.walletBalance ?? 0),
      crossUnPnl: String(item.crossUnPnl ?? item.unrealizedProfit ?? 0),
    })).filter((item: FuturesBalance) => Number(item.balance) !== 0 || Number(item.availableBalance) !== 0);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchFundingBalancesCcxt(credentials: { apiKey: string; apiSecret: string }) {
  try {
    const balance = await withCcxtPrivateTelemetry('spot', 'fetchFundingBalances', () => createSpotExchange(credentials).fetchBalance());
    return Object.entries(balance.total || {}).map(([asset, total]) => ({
      asset,
      free: String(balance.free?.[asset] ?? total ?? 0),
      locked: String(balance.used?.[asset] ?? 0),
      freeze: '0',
      withdrawing: '0',
      btcValuation: '0',
    })).filter((item) => Number(item.free) > 0 || Number(item.locked) > 0) as FundingBalance[];
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchFuturesPositionsCcxt(credentials: { apiKey: string; apiSecret: string }) {
  try {
    const positions = await withCcxtPrivateTelemetry('futures', 'fetchFuturesPositions', () => createFuturesExchange(credentials).fetchPositions());
    return positions.map((position: any) => ({
      symbol: toCompactSymbol(String(position.symbol || position.info?.symbol || '')),
      positionAmt: String(position.contracts ?? position.info?.positionAmt ?? 0),
      entryPrice: String(position.entryPrice ?? position.info?.entryPrice ?? 0),
      markPrice: String(position.markPrice ?? position.info?.markPrice ?? 0),
      unrealizedProfit: String(position.unrealizedPnl ?? position.info?.unRealizedProfit ?? 0),
      liquidationPrice: String(position.liquidationPrice ?? position.info?.liquidationPrice ?? 0),
      leverage: String(position.leverage ?? position.info?.leverage ?? 0),
      marginType: String(position.marginMode ?? position.info?.marginType ?? 'cross'),
      isolatedMargin: String(position.info?.isolatedMargin ?? 0),
      notional: String(position.notional ?? position.info?.notional ?? 0),
    })).filter((item: FuturesPosition) => Number(item.positionAmt) !== 0);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchOpenOrdersCcxt(type: BinanceMarketType, credentials: { apiKey: string; apiSecret: string }) {
  try {
    const exchange = type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials);
    const orders = await withCcxtPrivateTelemetry(type, 'fetchOpenOrders', () => exchange.fetchOpenOrders());
    return orders.map(normalizeOrder);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchOrderHistoryCcxt(type: BinanceMarketType, symbol: string, credentials: { apiKey: string; apiSecret: string }, limit = 20) {
  try {
    const exchange = type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials);
    const orders = await withCcxtPrivateTelemetry(type, 'fetchOrderHistory', () => exchange.fetchOrders(toUnifiedSymbol(symbol), undefined, limit));
    return orders.map(normalizeOrder);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function fetchTradeHistoryCcxt(type: BinanceMarketType, symbol: string, credentials: { apiKey: string; apiSecret: string }, limit = 20) {
  try {
    const exchange = type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials);
    const trades = await withCcxtPrivateTelemetry(type, 'fetchTradeHistory', () => exchange.fetchMyTrades(toUnifiedSymbol(symbol), undefined, limit));
    return trades.map(normalizeTrade);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function setFuturesLeverageCcxt(symbol: string, leverage: number, credentials: { apiKey: string; apiSecret: string }) {
  try {
    await withCcxtPrivateTelemetry('futures', 'setFuturesLeverage', () => createFuturesExchange(credentials).setLeverage(leverage, toUnifiedSymbol(symbol)));
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function setFuturesMarginTypeCcxt(symbol: string, marginType: 'CROSSED' | 'ISOLATED', credentials: { apiKey: string; apiSecret: string }) {
  try {
    await withCcxtPrivateTelemetry('futures', 'setFuturesMarginType', () => createFuturesExchange(credentials).setMarginMode(marginType === 'ISOLATED' ? 'isolated' : 'cross', toUnifiedSymbol(symbol)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/no need|same margin mode/i.test(message)) {
      throw new Error(normalizeError(error));
    }
  }
}

export async function placeOrderCcxt(
  type: BinanceMarketType,
  credentials: { apiKey: string; apiSecret: string },
  params: Record<string, string | number | boolean | undefined>
) {
  try {
    const exchange = type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials);
    const symbol = toUnifiedSymbol(String(params.symbol || ''));
    const orderType = String(params.type || 'MARKET').toLowerCase();
    const side = String(params.side || 'BUY').toLowerCase() as 'buy' | 'sell';
    const amount = Number(params.quantity || 0);
    const price = params.price !== undefined ? Number(params.price) : undefined;
    const order = await withCcxtPrivateTelemetry(type, 'placeOrder', () => exchange.createOrder(symbol, orderType, side, amount, price, params));
    return normalizeOrder(order);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function placeOrderWithBrokerCcxt(
  exchangeName: BrokerExchange,
  type: BinanceMarketType,
  credentials: { apiKey: string; apiSecret: string; password?: string },
  params: Record<string, string | number | boolean | undefined>
) {
  try {
    const exchange = exchangeName === 'okx'
      ? createOkxExchange(type, credentials)
      : (type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials));
    const symbol = toUnifiedSymbol(String(params.symbol || ''));
    const orderType = String(params.type || 'MARKET').toLowerCase();
    const side = String(params.side || 'BUY').toLowerCase() as 'buy' | 'sell';
    const amount = Number(params.quantity || 0);
    const price = params.price !== undefined ? Number(params.price) : undefined;
    const order = await withCcxtPrivateTelemetry(type, 'placeOrder', () => exchange.createOrder(symbol, orderType, side, amount, price, params), exchangeName);
    return normalizeOrder(order);
  } catch (error) {
    throw new Error(normalizeBrokerError(exchangeName, error));
  }
}

export async function cancelOrderCcxt(
  type: BinanceMarketType,
  credentials: { apiKey: string; apiSecret: string },
  params: { symbol: string; orderId: number }
) {
  try {
    const exchange = type === 'spot' ? createSpotExchange(credentials) : createFuturesExchange(credentials);
    const order = await withCcxtPrivateTelemetry(type, 'cancelOrder', () => exchange.cancelOrder(String(params.orderId), toUnifiedSymbol(params.symbol)));
    return normalizeOrder(order);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}
