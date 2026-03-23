import type { ActiveBrokerId, ActiveBrokerTarget, BrokerId, BrokerMode, BrokerTarget, StrategyRuntime } from '../platform-types';

export function parseBrokerTarget(target?: string | null): { brokerId: BrokerId; brokerMode: BrokerMode; target: BrokerTarget } {
  if (!target || target === 'paper') {
    return { brokerId: 'paper', brokerMode: 'paper', target: 'paper' };
  }

  const [brokerId, brokerMode] = target.split(':');
  const isSupportedBroker = brokerId === 'binance' || brokerId === 'okx' || brokerId === 'bybit' || brokerId === 'ibkr';
  if (isSupportedBroker && brokerMode === 'production') {
    return { brokerId, brokerMode: 'production', target: `${brokerId}:production` as ActiveBrokerTarget };
  }
  if (isSupportedBroker) {
    return { brokerId, brokerMode: 'sandbox', target: `${brokerId}:sandbox` as ActiveBrokerTarget };
  }
  return { brokerId: 'binance', brokerMode: 'sandbox', target: 'binance:sandbox' };
}

export function buildBrokerTarget(brokerId: BrokerId, brokerMode: BrokerMode): BrokerTarget {
  if (brokerId === 'paper' || brokerMode === 'paper') {
    return 'paper';
  }
  return `${brokerId}:${brokerMode}` as ActiveBrokerTarget;
}

export function getDefaultBrokerTargetForRuntime(runtime: StrategyRuntime): BrokerTarget {
  if (runtime === 'paper') return 'paper';
  if (runtime === 'production') return 'binance:production';
  return 'binance:sandbox';
}

export function getBrokerLabel(target: BrokerTarget) {
  if (target === 'paper') return 'Paper';
  const { brokerId, brokerMode } = parseBrokerTarget(target);
  const title = brokerId.charAt(0).toUpperCase() + brokerId.slice(1);
  return `${title} ${brokerMode === 'production' ? 'Production' : 'Sandbox'}`;
}
