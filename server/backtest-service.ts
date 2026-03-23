import { writeAuditEvent } from './audit-log-service';
import { runBacktest } from './backtest-engine';
import { appendBacktest, getStrategy, listBacktests } from './platform-store';
import { resolveBrokerMarketDataAdapter } from './platform/adapters/broker-registry';

export async function executeBacktest(params: {
  actorUserId: string;
  strategyId: string;
  lookback?: number;
  initialCapital?: number;
  feeBps?: number;
  slippageBps?: number;
}) {
  const strategy = await getStrategy(params.strategyId);
  if (!strategy) {
    throw new Error('Strategy not found');
  }

  const lookback = Math.min(Math.max(Number(params.lookback || 500), 100), 1500);
  const marketDataAdapter = resolveBrokerMarketDataAdapter();
  const candles = await marketDataAdapter.marketData.fetchHistoricalKlines({
    brokerTarget: marketDataAdapter.brokerTarget,
    marketType: strategy.marketType,
    symbol: strategy.symbol,
    interval: strategy.interval,
    limit: lookback,
  });
  if (candles.length < 100) {
    throw new Error('Not enough historical candles to run backtest');
  }

  const run = runBacktest({
    strategy,
    candles,
    lookback,
    initialCapital: Number(params.initialCapital || 10_000),
    feeBps: Number(params.feeBps || 4),
    slippageBps: Number(params.slippageBps || 2),
  });
  await appendBacktest(run);
  await writeAuditEvent({
    actorUserId: params.actorUserId,
    type: 'backtest.run',
    payload: {
      strategyId: params.strategyId,
      runId: run.id,
      metrics: run.metrics,
    },
  });
  return run;
}

export async function listBacktestRuns(strategyId?: string) {
  return listBacktests(strategyId);
}
