import { Kafka } from 'kafkajs';
import { getCacheStore } from './cache-store';
import { computeIndicatorBundle, type CandlePoint } from './indicator-utils';
import { getKafkaTopicMap, getMessageBus, publishDeadLetter } from './message-bus';
import { createRuntimeMonitor } from './runtime-monitor';
import { indicatorSnapshotCacheKey } from './cache-keys';

const cacheStore = getCacheStore();
const messageBus = getMessageBus();
const topics = getKafkaTopicMap();
const runtimeMonitor = createRuntimeMonitor('stream-compute-worker', {
  port: Number(process.env.STREAM_COMPUTE_HEALTH_PORT || 8792),
});

interface IndicatorComputeRequestPayload {
  type: 'spot' | 'futures';
  symbol: string;
  interval: string;
  limit: number;
  baseUrl: string | null;
  candles: CandlePoint[];
  requestedAt: number;
}

function getKafkaConfig() {
  const brokers = (process.env.KAFKA_BROKERS || '127.0.0.1:9092')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    clientId: process.env.STREAM_COMPUTE_CLIENT_ID || 'quantx-stream-compute-worker',
    groupId: process.env.STREAM_COMPUTE_GROUP_ID || 'quantx-stream-compute-workers',
    brokers,
  };
}

async function processIndicatorRequest(payload: IndicatorComputeRequestPayload) {
  await runtimeMonitor.increment('compute_requests');
  const indicatorCacheKey = indicatorSnapshotCacheKey(payload.type, payload.symbol, payload.interval, payload.limit);
  const bundle = computeIndicatorBundle(payload.candles || []);
  const responsePayload = {
    type: payload.type,
    symbol: payload.symbol.toUpperCase(),
    interval: payload.interval,
    limit: payload.limit,
    baseUrl: payload.baseUrl,
    ...bundle,
  };

  await cacheStore.set(indicatorCacheKey, responsePayload, 3_000);
  await runtimeMonitor.increment('compute_responses');
  await messageBus.publish(
    topics.indicatorSnapshot,
    `${payload.type}:${payload.symbol.toUpperCase()}:${payload.interval}`,
    responsePayload,
  );
}

async function main() {
  const { clientId, groupId, brokers } = getKafkaConfig();
  const kafka = new Kafka({ clientId, brokers });
  const consumer = kafka.consumer({ groupId });

  await consumer.connect();
  await consumer.subscribe({ topic: topics.indicatorComputeRequest, fromBeginning: false });
  await runtimeMonitor.markLive({
    brokers,
    groupId,
    topic: topics.indicatorComputeRequest,
  });

  console.log(`[StreamCompute] Connected to ${brokers.join(', ')} as ${clientId} / ${groupId}`);
  console.log(`[StreamCompute] Subscribed topic: ${topics.indicatorComputeRequest}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      try {
        const payload = JSON.parse(message.value.toString()) as IndicatorComputeRequestPayload;
        await processIndicatorRequest(payload);
        await runtimeMonitor.markLive({
          brokers,
          groupId,
          symbol: payload.symbol,
          interval: payload.interval,
        });
      } catch (error) {
        console.warn('[StreamCompute] Failed to process indicator compute request', error);
        await runtimeMonitor.increment('compute_failures');
        let failedPayload: unknown;
        try {
          failedPayload = message.value ? JSON.parse(message.value.toString()) : undefined;
        } catch {
          failedPayload = message.value?.toString();
        }
        await publishDeadLetter(messageBus, {
          source: 'stream-compute-worker',
          topic: topics.indicatorComputeRequest,
          key: message.key?.toString(),
          error: error instanceof Error ? error.message : 'Indicator compute failed',
          payload: failedPayload,
          failedAt: Date.now(),
        }).catch(() => undefined);
        await runtimeMonitor.markDegraded(error instanceof Error ? error.message : 'Indicator compute failed');
      }
    },
  });
}

void main().catch((error) => {
  console.error('[StreamCompute] Fatal error', error);
  void runtimeMonitor.markError(error instanceof Error ? error.message : 'Stream compute worker fatal error');
  process.exitCode = 1;
});
