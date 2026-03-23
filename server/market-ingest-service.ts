import { getKafkaTopicMap, getMessageBus } from './message-bus';
import { createServiceRuntime } from './service-runtime';

const runtime = createServiceRuntime('market-ingest-service', Number(process.env.MARKET_INGEST_PORT || 8788), {
  role: 'exchange-ingest',
  busDriver: process.env.MESSAGE_BUS_DRIVER || 'none',
});

runtime.app.get('/config', (_req, res) => {
  const topics = getKafkaTopicMap();
  res.json({
    service: 'market-ingest-service',
    topics: {
      tickerRaw: topics.marketTickerRaw,
      depthRaw: topics.marketDepthRaw,
      klineRaw: topics.marketKlineRaw,
      exchangeHealth: topics.exchangeHealth,
    },
  });
});

runtime.app.post('/emit/health', async (req, res) => {
  const bus = getMessageBus();
  const topics = getKafkaTopicMap();
  const payload = {
    source: 'market-ingest-service',
    status: req.body?.status || 'live',
    updatedAt: Date.now(),
    meta: req.body?.meta || {},
  };
  await bus.publish(topics.exchangeHealth, 'market-ingest-service', payload);
  res.json({ ok: true, payload });
});

void runtime.listen().catch((error) => {
  console.error('[market-ingest-service] fatal error', error);
  process.exitCode = 1;
});

