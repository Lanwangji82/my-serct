import { writeAuditEvent } from '../../audit-log-service';
import { createId, getPaperAccount, getStrategy, upsertPaperAccount } from '../../platform-store';
import { evaluatePreTradeRisk } from '../../risk-rules';
import { resolveBrokerCredential } from '../../secret-store';
import type { ActiveBrokerTarget, BrokerTarget, PaperAccount } from '../../platform-types';
import { getDefaultBrokerTargetForRuntime, parseBrokerTarget } from '../broker-model';
import { resolveBrokerExecutionAdapter, resolveBrokerMarketDataAdapter } from './broker-registry';

function ensurePaperAccount(userId: string, existing: PaperAccount | null): PaperAccount {
  if (existing) return existing;
  return {
    id: createId('paper'),
    userId,
    balanceUsd: 100_000,
    realizedPnl: 0,
    positions: [],
    updatedAt: Date.now(),
  };
}

export async function submitExecution(params: {
  actorUserId: string;
  strategyId: string;
  brokerTarget?: BrokerTarget;
  side: 'BUY' | 'SELL';
  quantity?: number;
  leverage?: number;
}) {
  const strategy = await getStrategy(params.strategyId);
  if (!strategy) {
    throw new Error('Strategy not found');
  }

  const brokerTarget = params.brokerTarget || getDefaultBrokerTargetForRuntime(strategy.runtime);
  const target = parseBrokerTarget(brokerTarget);
  const marketDataAdapter = resolveBrokerMarketDataAdapter(brokerTarget);

  const lastCandle = (
    await marketDataAdapter.marketData.fetchHistoricalKlines({
      brokerTarget: marketDataAdapter.brokerTarget,
      marketType: strategy.marketType,
      symbol: strategy.symbol,
      interval: strategy.interval,
      limit: 3,
    })
  ).at(-1);

  if (!lastCandle) {
    throw new Error('Unable to fetch current price for execution');
  }

  const quantity = Number(params.quantity || Number(strategy.parameters.positionSizeUsd || 1000) / lastCandle.close);
  const leverage = Number(params.leverage || 1);
  const requestedNotional = quantity * lastCandle.close;
  const paperAccount = ensurePaperAccount(params.actorUserId, await getPaperAccount(params.actorUserId));
  const risk = evaluatePreTradeRisk({
    strategy,
    requestedNotional,
    leverage,
    symbol: strategy.symbol,
    dayRealizedPnl: paperAccount.realizedPnl,
  });

  if (!risk.allow) {
    await writeAuditEvent({
      actorUserId: params.actorUserId,
      type: 'execution.rejected',
      payload: {
        strategyId: strategy.id,
        brokerTarget,
        breaches: risk.breaches,
        requestedNotional,
      },
    });
    return { accepted: false, brokerTarget, risk };
  }

  await writeAuditEvent({
    actorUserId: params.actorUserId,
    type: 'execution.accepted',
    payload: {
      strategyId: strategy.id,
      brokerTarget,
      requestedNotional,
      side: params.side,
      quantity,
    },
  });

  if (target.target === 'paper') {
    const existingPosition = paperAccount.positions.find((item) => item.symbol === strategy.symbol && item.marketType === strategy.marketType);
    const nextPositions = [...paperAccount.positions.filter((item) => !(item.symbol === strategy.symbol && item.marketType === strategy.marketType))];
    const signedQty = params.side === 'BUY' ? quantity : -quantity;
    const nextQty = (existingPosition?.quantity || 0) + signedQty;
    if (Math.abs(nextQty) > 1e-8) {
      nextPositions.push({
        symbol: strategy.symbol,
        marketType: strategy.marketType,
        quantity: nextQty,
        avgEntryPrice: lastCandle.close,
        updatedAt: Date.now(),
      });
    }

    const nextAccount: PaperAccount = {
      ...paperAccount,
      balanceUsd: paperAccount.balanceUsd - (params.side === 'BUY' ? requestedNotional : -requestedNotional),
      positions: nextPositions,
      updatedAt: Date.now(),
    };
    await upsertPaperAccount(nextAccount);
    const result = {
      accepted: true,
      brokerTarget,
      broker: 'paper',
      fillPrice: lastCandle.close,
      quantity,
      symbol: strategy.symbol,
      marketType: strategy.marketType,
      updatedAccount: nextAccount,
    };
    await writeAuditEvent({
      actorUserId: params.actorUserId,
      type: 'execution.sent',
      payload: result,
    });
    return result;
  }

  const credentials = await resolveBrokerCredential(params.actorUserId, brokerTarget);
  if (!credentials) {
    throw new Error(`Missing broker credentials for ${brokerTarget}`);
  }

  const executionAdapter = resolveBrokerExecutionAdapter(target.target as ActiveBrokerTarget);
  const orderResult = await executionAdapter.execution.placeOrder({
    brokerTarget: target.target as ActiveBrokerTarget,
    marketType: strategy.marketType,
    credentials,
    order: {
      symbol: strategy.symbol,
      side: params.side,
      type: 'MARKET',
      quantity: quantity.toFixed(strategy.marketType === 'spot' ? 5 : 3),
      newOrderRespType: 'RESULT',
    },
  });
  await writeAuditEvent({
    actorUserId: params.actorUserId,
    type: 'execution.sent',
    payload: {
      strategyId: strategy.id,
      brokerTarget,
      orderResult,
    },
  });
  return {
    accepted: true,
    brokerTarget,
    broker: executionAdapter.broker.label,
    orderResult,
  };
}
