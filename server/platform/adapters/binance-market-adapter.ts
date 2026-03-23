import type { ExchangeMarketType, BrokerTarget } from '../../platform-types';
import { fetchViaCcxt } from '../../ccxt-market-data';
import { parseBrokerTarget } from '../broker-model';

export async function fetchHistoricalKlinesFromBinance(params: {
  brokerTarget?: BrokerTarget;
  marketType: ExchangeMarketType;
  symbol: string;
  interval: string;
  limit: number;
}) {
  const target = parseBrokerTarget(params.brokerTarget);
  if (target.brokerId !== 'binance' && target.brokerId !== 'paper') {
    throw new Error(`Unsupported broker target for Binance adapter: ${target.target}`);
  }

  const path = params.marketType === 'spot'
    ? `/api/v3/klines?symbol=${params.symbol.toUpperCase()}&interval=${params.interval}&limit=${params.limit}`
    : `/fapi/v1/klines?symbol=${params.symbol.toUpperCase()}&interval=${params.interval}&limit=${params.limit}`;

  const result = await fetchViaCcxt(params.marketType, path, 'binance');
  const json = result.data as any[];
  if (!Array.isArray(json)) {
    return [];
  }

  return json.map((item: any[]) => ({
    time: Number(item[0]) / 1000,
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5] || 0),
  }));
}
