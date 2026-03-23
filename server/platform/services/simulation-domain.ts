import { executeBacktest, listBacktestRuns } from '../../backtest-service';

export async function runPlatformBacktest(params: {
  actorUserId: string;
  strategyId: string;
  lookback?: number;
  initialCapital?: number;
  feeBps?: number;
  slippageBps?: number;
}) {
  return executeBacktest(params);
}

export async function listPlatformBacktests(strategyId?: string) {
  return listBacktestRuns(strategyId);
}
