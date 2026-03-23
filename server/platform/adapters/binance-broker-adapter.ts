import type { BrokerTarget, ExchangeMarketType } from '../../platform-types';
import { placeOrderCcxt } from '../../ccxt-private-api';
import { parseBrokerTarget } from '../broker-model';

export async function placeOrderWithBinanceBroker(params: {
  brokerTarget: Exclude<BrokerTarget, 'paper'>;
  marketType: ExchangeMarketType;
  credentials: { apiKey: string; apiSecret: string };
  order: Record<string, string | number | boolean | undefined>;
}) {
  const target = parseBrokerTarget(params.brokerTarget);
  if (target.brokerId !== 'binance') {
    throw new Error(`Unsupported broker target for Binance broker adapter: ${params.brokerTarget}`);
  }
  return placeOrderCcxt(params.marketType, params.credentials, params.order);
}
