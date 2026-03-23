import { submitExecution } from '../adapters/execution-gateway';

export async function submitPlatformExecution(params: {
  actorUserId: string;
  strategyId: string;
  brokerTarget?: any;
  side: 'BUY' | 'SELL';
  quantity?: number;
  leverage?: number;
}) {
  return submitExecution(params);
}
