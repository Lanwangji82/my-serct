export type StreamTaskType =
  | 'indicator.compute'
  | 'kline.aggregate'
  | 'funding.anomaly'
  | 'orderbook.imbalance'
  | 'risk.evaluate';

export interface StreamTaskEnvelope<TPayload = unknown> {
  taskType: StreamTaskType;
  taskVersion: 1;
  taskId: string;
  source: string;
  createdAt: number;
  marketType?: 'spot' | 'futures';
  symbol?: string;
  interval?: string;
  payload: TPayload;
}

export function createStreamTaskEnvelope<TPayload>(
  source: string,
  taskType: StreamTaskType,
  payload: TPayload,
  meta?: Partial<Pick<StreamTaskEnvelope<TPayload>, 'marketType' | 'symbol' | 'interval'>>,
): StreamTaskEnvelope<TPayload> {
  return {
    taskType,
    taskVersion: 1,
    taskId: `${taskType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source,
    createdAt: Date.now(),
    payload,
    ...meta,
  };
}

