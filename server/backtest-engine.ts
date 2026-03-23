import type { BacktestRun, BacktestTrade, StrategyDefinition } from './platform-types';
import { createId } from './platform-store';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function rollingMean(candles: Candle[], endIndex: number, period: number) {
  if (endIndex + 1 < period) return null;
  const slice = candles.slice(endIndex + 1 - period, endIndex + 1).map((item) => item.close);
  return average(slice);
}

export function runBacktest(params: {
  strategy: StrategyDefinition;
  candles: Candle[];
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
  lookback: number;
}): BacktestRun {
  const { strategy, candles, initialCapital, feeBps, slippageBps, lookback } = params;
  let cash = initialCapital;
  let positionQty = 0;
  let entryPrice = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  const returns: number[] = [];
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  const positionSizeUsd = Number(strategy.parameters.positionSizeUsd || initialCapital * 0.1);

  for (let i = 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const previous = candles[i - 1];
    let signal: 'BUY' | 'SELL' | null = null;
    let reason = '';

    if (strategy.template === 'smaCross') {
      const fast = Number(strategy.parameters.fastPeriod || 20);
      const slow = Number(strategy.parameters.slowPeriod || 50);
      const prevFast = rollingMean(candles, i - 1, fast);
      const prevSlow = rollingMean(candles, i - 1, slow);
      const currFast = rollingMean(candles, i, fast);
      const currSlow = rollingMean(candles, i, slow);
      if (prevFast !== null && prevSlow !== null && currFast !== null && currSlow !== null) {
        if (prevFast <= prevSlow && currFast > currSlow) {
          signal = 'BUY';
          reason = 'sma_cross_up';
        } else if (prevFast >= prevSlow && currFast < currSlow) {
          signal = 'SELL';
          reason = 'sma_cross_down';
        }
      }
    } else if (strategy.template === 'breakout') {
      const breakoutLookback = Number(strategy.parameters.breakoutLookback || 20);
      if (i >= breakoutLookback) {
        const window = candles.slice(i - breakoutLookback, i);
        const highest = Math.max(...window.map((item) => item.high));
        const lowest = Math.min(...window.map((item) => item.low));
        if (previous.close <= highest && candle.close > highest) {
          signal = 'BUY';
          reason = 'breakout_high';
        } else if (positionQty > 0 && candle.close < lowest) {
          signal = 'SELL';
          reason = 'breakout_low';
        }
      }
    }

    const slippedPrice = candle.close * (1 + (signal === 'BUY' ? slippageBps : -slippageBps) / 10_000);
    const feeRate = feeBps / 10_000;

    if (signal === 'BUY' && positionQty === 0) {
      const quantity = Math.max(0, positionSizeUsd / slippedPrice);
      const gross = quantity * slippedPrice;
      const fee = gross * feeRate;
      if (gross + fee <= cash) {
        cash -= gross + fee;
        positionQty = quantity;
        entryPrice = slippedPrice;
        trades.push({ time: candle.time, side: 'BUY', price: slippedPrice, quantity, fee, pnl: 0, reason });
      }
    } else if (signal === 'SELL' && positionQty > 0) {
      const gross = positionQty * slippedPrice;
      const fee = gross * feeRate;
      const pnl = (slippedPrice - entryPrice) * positionQty - fee;
      cash += gross - fee;
      trades.push({ time: candle.time, side: 'SELL', price: slippedPrice, quantity: positionQty, fee, pnl, reason });
      positionQty = 0;
      entryPrice = 0;
    }

    const equity = cash + positionQty * candle.close;
    equityCurve.push({ time: candle.time, equity });
    if (equityCurve.length > 1) {
      const prevEquity = equityCurve[equityCurve.length - 2].equity;
      if (prevEquity > 0) {
        returns.push((equity - prevEquity) / prevEquity);
      }
    }
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  if (positionQty > 0) {
    const last = candles[candles.length - 1];
    const gross = positionQty * last.close;
    const fee = gross * (feeBps / 10_000);
    const pnl = (last.close - entryPrice) * positionQty - fee;
    cash += gross - fee;
    trades.push({
      time: last.time,
      side: 'SELL',
      price: last.close,
      quantity: positionQty,
      fee,
      pnl,
      reason: 'forced_close',
    });
    equityCurve.push({ time: last.time, equity: cash });
  }

  const sellTrades = trades.filter((item) => item.side === 'SELL');
  const wins = sellTrades.filter((item) => item.pnl > 0).length;
  const endingEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const avgReturn = average(returns);
  const volatility = stdDev(returns);
  const sharpe = volatility > 0 ? (avgReturn / volatility) * Math.sqrt(Math.max(lookback, 1)) : 0;

  return {
    id: createId('bt'),
    strategyId: strategy.id,
    symbol: strategy.symbol,
    interval: strategy.interval,
    marketType: strategy.marketType,
    startedAt: Date.now(),
    completedAt: Date.now(),
    source: 'broker-historical',
    params: { lookback, initialCapital, feeBps, slippageBps },
    metrics: {
      totalReturnPct: initialCapital > 0 ? ((endingEquity - initialCapital) / initialCapital) * 100 : 0,
      sharpe,
      maxDrawdownPct,
      winRatePct: sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0,
      trades: trades.length,
      endingEquity,
    },
    equityCurve,
    trades,
  };
}
