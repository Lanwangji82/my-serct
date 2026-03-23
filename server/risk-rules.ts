import type { StrategyDefinition } from './platform-types';

export interface RiskEvaluationInput {
  strategy: StrategyDefinition;
  requestedNotional: number;
  leverage: number;
  symbol: string;
  dayRealizedPnl: number;
}

export interface RiskEvaluationResult {
  allow: boolean;
  breaches: string[];
}

export function evaluatePreTradeRisk(input: RiskEvaluationInput): RiskEvaluationResult {
  const breaches: string[] = [];
  const { strategy } = input;

  if (strategy.risk.maxNotional > 0 && input.requestedNotional > strategy.risk.maxNotional) {
    breaches.push('max_notional');
  }
  if (strategy.risk.maxLeverage > 0 && input.leverage > strategy.risk.maxLeverage) {
    breaches.push('max_leverage');
  }
  if (strategy.risk.maxDailyLoss > 0 && Math.abs(input.dayRealizedPnl) > strategy.risk.maxDailyLoss) {
    breaches.push('max_daily_loss');
  }
  if (strategy.risk.allowedSymbols.length > 0 && !strategy.risk.allowedSymbols.includes(input.symbol.toUpperCase())) {
    breaches.push('symbol_not_allowed');
  }

  return {
    allow: breaches.length === 0,
    breaches,
  };
}
