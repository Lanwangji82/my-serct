export type BinanceMarketType = 'spot' | 'futures';

export function rankedBaseUrlsCacheKey(type: BinanceMarketType) {
  return `${type}-ranked`;
}

export function marketTopSymbolsCacheKey(type: BinanceMarketType) {
  return `market:${type}:top-symbols`;
}

export function orderbookProjectionCacheKey(type: BinanceMarketType, symbol: string) {
  return `orderbook:${type}:${symbol.toUpperCase()}`;
}

export function indicatorSnapshotCacheKey(type: BinanceMarketType, symbol: string, interval: string, limit: number) {
  return `indicator:${type}:${symbol.toUpperCase()}:${interval}:${limit}`;
}

export function klineSnapshotCacheKey(type: BinanceMarketType, symbol: string, interval: string, limit: number) {
  return `kline:${type}:${symbol.toUpperCase()}:${interval}:${limit}`;
}

export function accountSnapshotCacheKey(token: string) {
  return `account:${token}:snapshot`;
}

export function anonymousAccountSnapshotCacheKey(updatedAt: number) {
  return `account:anonymous:${updatedAt}`;
}

export function activeQueryPreferenceCacheKey(type: BinanceMarketType, symbol: string) {
  return `active-query-pref:${type}:${symbol.toUpperCase()}`;
}

export function proxyHealthCacheKey() {
  return 'bus:proxy:health';
}

