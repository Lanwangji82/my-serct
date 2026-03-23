import { Kafka } from 'kafkajs';
import { getCacheStore } from './cache-store';
import { getKafkaTopicMap, getMessageBus, publishDeadLetter } from './message-bus';
import { createRuntimeMonitor, getRuntimeHealthSnapshot } from './runtime-monitor';
import {
  accountSnapshotCacheKey,
  anonymousAccountSnapshotCacheKey,
  indicatorSnapshotCacheKey,
  marketTopSymbolsCacheKey,
  orderbookProjectionCacheKey,
  proxyHealthCacheKey,
} from './cache-keys';

const cacheStore = getCacheStore();
const messageBus = getMessageBus();
const topics = getKafkaTopicMap();

const MARKET_CACHE_TTL_MS = 15_000;
const ORDERBOOK_CACHE_TTL_MS = 15_000;
const ACCOUNT_CACHE_TTL_MS = 60_000;
const INDICATOR_CACHE_TTL_MS = 3_000;
const HEALTH_CACHE_TTL_MS = 15_000;
const runtimeMonitor = createRuntimeMonitor('kafka-projection-consumer', {
  port: Number(process.env.KAFKA_CONSUMER_HEALTH_PORT || 8791),
});

function getKafkaConfig() {
  const brokers = (process.env.KAFKA_BROKERS || '127.0.0.1:9092')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    clientId: process.env.KAFKA_CONSUMER_CLIENT_ID || 'quantx-projection-consumer',
    groupId: process.env.KAFKA_CONSUMER_GROUP_ID || 'quantx-projection-workers',
    brokers,
  };
}

async function writeProjection(topic: string, payload: any) {
  await runtimeMonitor.increment('messages_processed');

  if (topic === topics.marketSnapshot) {
    if (!payload?.type) return;
    await runtimeMonitor.increment('market_snapshots');
    await cacheStore.set(marketTopSymbolsCacheKey(payload.type), payload, MARKET_CACHE_TTL_MS);
    return;
  }

  if (topic === topics.orderbookProjection) {
    if (!payload?.type || !payload?.symbol) return;
    await runtimeMonitor.increment('orderbook_snapshots');
    await cacheStore.set(orderbookProjectionCacheKey(payload.type, String(payload.symbol)), {
      asks: payload.asks || [],
      bids: payload.bids || [],
      updatedAt: payload.updatedAt || Date.now(),
      ready: Boolean(payload.ready),
    }, ORDERBOOK_CACHE_TTL_MS);
    return;
  }

  if (topic === topics.accountSnapshot) {
    const token = payload?.token || payload?.sessionToken || null;
    if (!token && !payload?.updatedAt) return;
    await runtimeMonitor.increment('account_snapshots');
    const key = token ? accountSnapshotCacheKey(String(token)) : anonymousAccountSnapshotCacheKey(payload.updatedAt);
    await cacheStore.set(key, payload, ACCOUNT_CACHE_TTL_MS);
    return;
  }

  if (topic === topics.indicatorSnapshot) {
    if (!payload?.type || !payload?.symbol || !payload?.interval || !payload?.limit) return;
    await runtimeMonitor.increment('indicator_snapshots');
    await cacheStore.set(
      indicatorSnapshotCacheKey(payload.type, String(payload.symbol), payload.interval, payload.limit),
      {
        baseUrl: payload.baseUrl,
        updatedAt: payload.updatedAt || Date.now(),
        ma: payload.ma || {},
        ema: payload.ema || {},
        rsi: payload.rsi || [],
        macd: payload.macd || {},
      },
      INDICATOR_CACHE_TTL_MS
    );
    return;
  }

  if (topic === topics.proxyHealth) {
    await runtimeMonitor.increment('proxy_health_events');
    await cacheStore.set(proxyHealthCacheKey(), payload, HEALTH_CACHE_TTL_MS);
  }
}

async function main() {
  const { clientId, groupId, brokers } = getKafkaConfig();
  const kafka = new Kafka({ clientId, brokers });
  const consumer = kafka.consumer({ groupId });
  const topicList = Object.values(topics);

  await consumer.connect();
  await Promise.all(topicList.map((topic) => consumer.subscribe({ topic, fromBeginning: false })));
  await runtimeMonitor.markLive({
    brokers,
    groupId,
    topics: topicList,
    cache: await getCacheStore().getStats(),
    self: await getRuntimeHealthSnapshot('kafka-projection-consumer'),
  });

  console.log(`[KafkaConsumer] Connected to ${brokers.join(', ')} as ${clientId} / ${groupId}`);
  console.log(`[KafkaConsumer] Subscribed topics: ${topicList.join(', ')}`);

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;

      try {
        const payload = JSON.parse(message.value.toString());
        await writeProjection(topic, payload);
        await runtimeMonitor.markLive({ brokers, groupId, topic });
      } catch (error) {
        console.warn(`[KafkaConsumer] Failed to process topic ${topic}`, error);
        await runtimeMonitor.increment('message_failures');
        let failedPayload: unknown;
        try {
          failedPayload = message.value ? JSON.parse(message.value.toString()) : undefined;
        } catch {
          failedPayload = message.value?.toString();
        }
        await publishDeadLetter(messageBus, {
          source: 'kafka-projection-consumer',
          topic,
          key: message.key?.toString(),
          error: error instanceof Error ? error.message : 'Failed to process Kafka message',
          payload: failedPayload,
          failedAt: Date.now(),
        }).catch(() => undefined);
        await runtimeMonitor.markDegraded(error instanceof Error ? error.message : 'Failed to process Kafka message', { topic });
      }
    },
  });
}

void main().catch((error) => {
  console.error('[KafkaConsumer] Fatal error', error);
  void runtimeMonitor.markError(error instanceof Error ? error.message : 'Kafka projection consumer fatal error');
  process.exitCode = 1;
});
