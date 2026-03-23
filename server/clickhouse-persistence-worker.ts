import { Kafka } from 'kafkajs';
import { getKafkaTopicMap, getMessageBus, publishDeadLetter } from './message-bus';
import { getClickHouseStore } from './clickhouse-store';
import { createRuntimeMonitor } from './runtime-monitor';

const topics = getKafkaTopicMap();
const messageBus = getMessageBus();
const clickhouseStore = getClickHouseStore();
const runtimeMonitor = createRuntimeMonitor('clickhouse-persistence-worker', {
  port: Number(process.env.CLICKHOUSE_PERSIST_HEALTH_PORT || 8793),
});

function getKafkaConfig() {
  const brokers = (process.env.KAFKA_BROKERS || '127.0.0.1:9092')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    clientId: process.env.CLICKHOUSE_PERSIST_CLIENT_ID || 'quantx-clickhouse-persistence-worker',
    groupId: process.env.CLICKHOUSE_PERSIST_GROUP_ID || 'quantx-clickhouse-persistence-workers',
    brokers,
  };
}

function toDateTime64(value?: number) {
  return new Date(value || Date.now()).toISOString().replace('T', ' ').replace('Z', '');
}

async function persistKlineSnapshot(payload: any) {
  const rows = Array.isArray(payload?.candles) ? payload.candles.map((item: any) => ({
    ts: toDateTime64((Number(item.time) || 0) * 1000),
    market_type: payload.type,
    symbol: String(payload.symbol || ''),
    interval: String(payload.interval || ''),
    open: Number(item.open || 0),
    high: Number(item.high || 0),
    low: Number(item.low || 0),
    close: Number(item.close || 0),
    volume: Number(item.volume || 0),
    quote_volume: Number(item.quoteVolume || 0),
  })) : [];

  if (rows.length) {
    await clickhouseStore.insertJsonEachRow('klines', rows);
  }
}

async function persistMarketSnapshot(payload: any) {
  const ts = toDateTime64(payload.updatedAt);
  const tickerRows = Array.isArray(payload.tickers) ? payload.tickers.map((item: any) => ({
    ts,
    market_type: payload.type,
    symbol: item.symbol,
    last_price: String(item.lastPrice || ''),
    price_change_percent: String(item.priceChangePercent || ''),
    quote_volume: String(item.quoteVolume || ''),
  })) : [];

  if (tickerRows.length) {
    await clickhouseStore.insertJsonEachRow('market_snapshots', tickerRows);
  }

  const fundingRows = Array.isArray(payload.fundingRates) ? payload.fundingRates.map((item: any) => ({
    ts,
    symbol: item.symbol,
    last_funding_rate: String(item.lastFundingRate || ''),
    next_funding_time: Number(item.nextFundingTime || 0),
  })) : [];

  if (fundingRows.length) {
    await clickhouseStore.insertJsonEachRow('funding_snapshots', fundingRows);
  }
}

async function persistOrderbookSnapshot(payload: any) {
  await clickhouseStore.insertJsonEachRow('orderbook_snapshots', [{
    ts: toDateTime64(payload.updatedAt),
    market_type: payload.type,
    symbol: String(payload.symbol || ''),
    depth_limit: Number(payload.limit || 0),
    ready: payload.ready ? 1 : 0,
    asks_json: JSON.stringify(payload.asks || []),
    bids_json: JSON.stringify(payload.bids || []),
  }]);
}

async function persistIndicatorSnapshot(payload: any) {
  await clickhouseStore.insertJsonEachRow('indicator_snapshots', [{
    ts: toDateTime64(payload.updatedAt),
    market_type: payload.type,
    symbol: String(payload.symbol || ''),
    interval: String(payload.interval || ''),
    data_limit: Number(payload.limit || 0),
    base_url: String(payload.baseUrl || ''),
    ma_json: JSON.stringify(payload.ma || {}),
    ema_json: JSON.stringify(payload.ema || {}),
    rsi_json: JSON.stringify(payload.rsi || []),
    macd_json: JSON.stringify(payload.macd || {}),
  }]);
}

async function persistAccountSnapshot(payload: any) {
  await clickhouseStore.insertJsonEachRow('account_snapshots', [{
    ts: toDateTime64(payload.updatedAt),
    token: String(payload.token || ''),
    account_ready: payload.accountReady ? 1 : 0,
    account_error: String(payload.accountError || ''),
    spot_balances_json: JSON.stringify(payload.spotBalances || []),
    futures_balances_json: JSON.stringify(payload.futuresBalances || []),
    funding_balances_json: JSON.stringify(payload.fundingBalances || []),
    futures_positions_json: JSON.stringify(payload.futuresPositions || []),
    spot_open_orders_json: JSON.stringify(payload.spotOpenOrders || []),
    futures_open_orders_json: JSON.stringify(payload.futuresOpenOrders || []),
  }]);
}

async function persistProxyHealth(payload: any) {
  await clickhouseStore.insertJsonEachRow('proxy_health_events', [{
    ts: toDateTime64(payload.updatedAt),
    cache_json: JSON.stringify(payload.cache || {}),
    bus_json: JSON.stringify(payload.bus || {}),
  }]);
}

async function persistDeadLetter(payload: any) {
  await clickhouseStore.insertJsonEachRow('dead_letter_events', [{
    ts: toDateTime64(payload.failedAt),
    source: String(payload.source || ''),
    topic: String(payload.topic || ''),
    event_key: String(payload.key || ''),
    error: String(payload.error || ''),
    payload_json: JSON.stringify(payload.payload ?? null),
  }]);
}

async function routePersistence(topic: string, payload: any) {
  await runtimeMonitor.increment('messages_persisted');

  if (topic === topics.klineSnapshot) {
    await runtimeMonitor.increment('kline_snapshot_persisted');
    await persistKlineSnapshot(payload);
    return;
  }

  if (topic === topics.marketSnapshot) {
    await runtimeMonitor.increment('market_snapshot_persisted');
    await persistMarketSnapshot(payload);
    return;
  }

  if (topic === topics.orderbookProjection) {
    await runtimeMonitor.increment('orderbook_snapshot_persisted');
    await persistOrderbookSnapshot(payload);
    return;
  }

  if (topic === topics.indicatorSnapshot) {
    await runtimeMonitor.increment('indicator_snapshot_persisted');
    await persistIndicatorSnapshot(payload);
    return;
  }

  if (topic === topics.accountSnapshot) {
    await runtimeMonitor.increment('account_snapshot_persisted');
    await persistAccountSnapshot(payload);
    return;
  }

  if (topic === topics.proxyHealth) {
    await runtimeMonitor.increment('proxy_health_persisted');
    await persistProxyHealth(payload);
    return;
  }

  if (topic === topics.deadLetter) {
    await runtimeMonitor.increment('dead_letter_persisted');
    await persistDeadLetter(payload);
  }
}

async function main() {
  const { clientId, groupId, brokers } = getKafkaConfig();
  const kafka = new Kafka({ clientId, brokers });
  const consumer = kafka.consumer({ groupId });
  const topicList = [
    topics.klineSnapshot,
    topics.marketSnapshot,
    topics.orderbookProjection,
    topics.accountSnapshot,
    topics.indicatorSnapshot,
    topics.proxyHealth,
    topics.deadLetter,
  ];

  await consumer.connect();
  await Promise.all(topicList.map((topic) => consumer.subscribe({ topic, fromBeginning: false })));
  await runtimeMonitor.markLive({
    brokers,
    groupId,
    topics: topicList,
    clickhouse: await clickhouseStore.getStats(),
  });

  console.log(`[ClickHouseWorker] Connected to ${brokers.join(', ')} as ${clientId} / ${groupId}`);
  console.log(`[ClickHouseWorker] Subscribed topics: ${topicList.join(', ')}`);

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;

      try {
        const payload = JSON.parse(message.value.toString());
        await routePersistence(topic, payload);
        await runtimeMonitor.markLive({
          brokers,
          groupId,
          topic,
          clickhouse: await clickhouseStore.getStats(),
        });
      } catch (error) {
        console.warn(`[ClickHouseWorker] Failed to persist topic ${topic}`, error);
        await runtimeMonitor.increment('persistence_failures');
        if (topic !== topics.deadLetter) {
          let failedPayload: unknown;
          try {
            failedPayload = message.value ? JSON.parse(message.value.toString()) : undefined;
          } catch {
            failedPayload = message.value?.toString();
          }
          await publishDeadLetter(messageBus, {
            source: 'clickhouse-persistence-worker',
            topic,
            key: message.key?.toString(),
            error: error instanceof Error ? error.message : 'ClickHouse persistence failed',
            payload: failedPayload,
            failedAt: Date.now(),
          }).catch(() => undefined);
        }
        await runtimeMonitor.markDegraded(error instanceof Error ? error.message : 'ClickHouse persistence failed', {
          topic,
          clickhouse: await clickhouseStore.getStats(),
        });
      }
    },
  });
}

void main().catch((error) => {
  console.error('[ClickHouseWorker] Fatal error', error);
  void clickhouseStore.getStats().then((stats) =>
    runtimeMonitor.markError(error instanceof Error ? error.message : 'ClickHouse persistence worker fatal error', {
      clickhouse: stats,
    })
  );
  process.exitCode = 1;
});
