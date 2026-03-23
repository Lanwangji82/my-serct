import type { BrokerTarget, ExchangeMarketType } from '../../platform-types';
import { placeOrderWithBrokerCcxt } from '../../ccxt-private-api';
import { parseBrokerTarget } from '../broker-model';

export async function placeOrderWithOkxBroker(params: {
  brokerTarget: Exclude<BrokerTarget, 'paper'>;
  marketType: ExchangeMarketType;
  credentials: { apiKey: string; apiSecret: string; password?: string };
  order: Record<string, string | number | boolean | undefined>;
}) {
  const target = parseBrokerTarget(params.brokerTarget);
  if (target.brokerId !== 'okx') {
    throw new Error(`Unsupported broker target for OKX broker adapter: ${params.brokerTarget}`);
  }
  return placeOrderWithBrokerCcxt('okx', params.marketType, params.credentials, params.order);
}
