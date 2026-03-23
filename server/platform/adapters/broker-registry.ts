import type { ActiveBrokerId, ActiveBrokerTarget, BrokerMode, BrokerTarget, ExchangeMarketType } from '../../platform-types';
import { parseBrokerTarget } from '../broker-model';
import { fetchHistoricalKlinesFromBinance } from './binance-market-adapter';
import { placeOrderWithBinanceBroker } from './binance-broker-adapter';
import { fetchHistoricalKlinesFromOkx } from './okx-market-adapter';
import { placeOrderWithOkxBroker } from './okx-broker-adapter';

export interface HistoricalKlineRequest {
  brokerTarget?: BrokerTarget;
  marketType: ExchangeMarketType;
  symbol: string;
  interval: string;
  limit: number;
}

export interface BrokerExecutionRequest {
  brokerTarget: ActiveBrokerTarget;
  marketType: ExchangeMarketType;
  credentials: { apiKey: string; apiSecret: string };
  order: Record<string, string | number | boolean | undefined>;
}

interface BrokerRegistryEntry {
  brokerId: ActiveBrokerId;
  label: string;
  supportedModes: Array<Exclude<BrokerMode, 'paper'>>;
  marketData?: {
    fetchHistoricalKlines: (params: HistoricalKlineRequest) => Promise<any[]>;
  };
  execution?: {
    placeOrder: (params: BrokerExecutionRequest) => Promise<unknown>;
  };
}

const REGISTRY = new Map<ActiveBrokerId, BrokerRegistryEntry>([
  ['binance', {
    brokerId: 'binance',
    label: 'Binance',
    supportedModes: ['sandbox', 'production'],
    marketData: {
      fetchHistoricalKlines: fetchHistoricalKlinesFromBinance,
    },
    execution: {
      placeOrder: placeOrderWithBinanceBroker,
    },
  }],
  ['okx', {
    brokerId: 'okx',
    label: 'OKX',
    supportedModes: ['sandbox', 'production'],
    marketData: {
      fetchHistoricalKlines: fetchHistoricalKlinesFromOkx,
    },
    execution: {
      placeOrder: placeOrderWithOkxBroker,
    },
  }],
]);

function toBrokerTarget(brokerId: ActiveBrokerId, brokerMode: Exclude<BrokerMode, 'paper'>): ActiveBrokerTarget {
  return `${brokerId}:${brokerMode}` as ActiveBrokerTarget;
}

export function listBrokerRegistrySummaries() {
  return Array.from(REGISTRY.values()).map((entry) => ({
    brokerId: entry.brokerId,
    label: entry.label,
    supportsMarketData: Boolean(entry.marketData),
    supportsExecution: Boolean(entry.execution),
    targets: entry.supportedModes.map((mode) => ({
      target: toBrokerTarget(entry.brokerId, mode),
      mode,
      label: `${entry.label} ${mode === 'production' ? 'Production' : 'Sandbox'}`,
    })),
  }));
}

export function getDefaultMarketDataBrokerTarget(preferredMode: Exclude<BrokerMode, 'paper'> = 'sandbox'): ActiveBrokerTarget {
  const envTarget = process.env.DEFAULT_MARKET_DATA_BROKER_TARGET;
  if (envTarget) {
    const parsed = parseBrokerTarget(envTarget);
    if (parsed.target !== 'paper') {
      const brokerId = parsed.brokerId as ActiveBrokerId;
      const brokerMode = parsed.brokerMode as Exclude<BrokerMode, 'paper'>;
      const entry = REGISTRY.get(brokerId);
      if (entry?.marketData && entry.supportedModes.includes(brokerMode)) {
        return parsed.target as ActiveBrokerTarget;
      }
    }
  }

  for (const entry of REGISTRY.values()) {
    if (entry.marketData && entry.supportedModes.includes(preferredMode)) {
      return toBrokerTarget(entry.brokerId, preferredMode);
    }
  }

  for (const entry of REGISTRY.values()) {
    if (entry.marketData && entry.supportedModes[0]) {
      return toBrokerTarget(entry.brokerId, entry.supportedModes[0]);
    }
  }

  throw new Error('No broker market data adapters are registered');
}

export function resolveBrokerMarketDataAdapter(target?: BrokerTarget) {
  const effectiveTarget = !target || target === 'paper' ? getDefaultMarketDataBrokerTarget('sandbox') : target;
  const parsed = parseBrokerTarget(effectiveTarget);
  if (parsed.target === 'paper') {
    throw new Error('Paper target cannot be used as a market data adapter');
  }
  const brokerId = parsed.brokerId as ActiveBrokerId;
  const entry = REGISTRY.get(brokerId);
  if (!entry?.marketData) {
    throw new Error(`No market data adapter registered for ${brokerId}`);
  }
  return {
    brokerTarget: parsed.target as ActiveBrokerTarget,
    broker: entry,
    marketData: entry.marketData,
  };
}

export function resolveBrokerExecutionAdapter(target: ActiveBrokerTarget) {
  const parsed = parseBrokerTarget(target);
  if (parsed.target === 'paper') {
    throw new Error('Paper execution does not use a broker execution adapter');
  }
  const brokerId = parsed.brokerId as ActiveBrokerId;
  const entry = REGISTRY.get(brokerId);
  if (!entry?.execution) {
    throw new Error(`No execution adapter registered for ${brokerId}`);
  }
  return {
    brokerTarget: parsed.target as ActiveBrokerTarget,
    broker: entry,
    execution: entry.execution,
  };
}
