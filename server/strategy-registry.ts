import { createId, getStrategy, listStrategies, upsertStrategy } from './platform-store';
import type { StrategyDefinition } from './platform-types';

const defaultStrategies: Array<Omit<StrategyDefinition, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'BTC SMA Trend',
    description: 'Fast/slow SMA crossover for BTCUSDT with conservative futures risk caps.',
    marketType: 'futures',
    symbol: 'BTCUSDT',
    interval: '1h',
    runtime: 'sandbox',
    template: 'smaCross',
    parameters: {
      fastPeriod: 20,
      slowPeriod: 50,
      positionSizeUsd: 1500,
    },
    risk: {
      maxNotional: 5000,
      maxLeverage: 3,
      maxDailyLoss: 400,
      allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
    },
  },
  {
    name: 'ETH Breakout',
    description: 'Simple breakout strategy suited for paper/testnet validation.',
    marketType: 'spot',
    symbol: 'ETHUSDT',
    interval: '4h',
    runtime: 'paper',
    template: 'breakout',
    parameters: {
      breakoutLookback: 20,
      stopLossPct: 2,
      takeProfitPct: 4,
      positionSizeUsd: 1000,
    },
    risk: {
      maxNotional: 3000,
      maxLeverage: 1,
      maxDailyLoss: 250,
      allowedSymbols: ['ETHUSDT'],
    },
  },
];

export async function ensureDefaultStrategies() {
  const existing = await listStrategies();
  if (existing.length >= defaultStrategies.length) {
    return existing;
  }

  const now = Date.now();
  for (const item of defaultStrategies) {
    const alreadyExists = existing.some((strategy) => strategy.name === item.name && strategy.symbol === item.symbol);
    if (alreadyExists) {
      continue;
    }
    await upsertStrategy({
      ...item,
      id: createId('strat'),
      createdAt: now,
      updatedAt: now,
    });
  }
  return listStrategies();
}

export async function listRegisteredStrategies() {
  await ensureDefaultStrategies();
  return listStrategies();
}

export async function saveStrategy(input: Omit<StrategyDefinition, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
  const existing = input.id ? await getStrategy(input.id) : null;
  const now = Date.now();
  const strategy: StrategyDefinition = {
    ...input,
    id: existing?.id || createId('strat'),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await upsertStrategy(strategy);
  return strategy;
}
