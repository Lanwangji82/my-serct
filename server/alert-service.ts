import { getKafkaTopicMap } from './message-bus';
import { createServiceRuntime } from './service-runtime';

const runtime = createServiceRuntime('alert-service', Number(process.env.ALERT_SERVICE_PORT || 8796), {
  role: 'alerting',
});

runtime.app.get('/config', (_req, res) => {
  const topics = getKafkaTopicMap();
  res.json({
    consumes: [topics.marketSnapshot, topics.indicatorSnapshot, topics.exchangeHealth, topics.deadLetter],
    plannedOutputs: ['alert.market.volatility', 'alert.exchange.health', 'alert.pipeline.failure'],
  });
});

runtime.app.post('/preview', async (req, res) => {
  const threshold = Number(req.body?.threshold || 0);
  const value = Number(req.body?.value || 0);
  res.json({
    triggered: threshold > 0 ? Math.abs(value) >= threshold : false,
    threshold,
    value,
  });
});

void runtime.listen().catch((error) => {
  console.error('[alert-service] fatal error', error);
  process.exitCode = 1;
});

