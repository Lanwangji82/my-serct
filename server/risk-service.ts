import { getKafkaTopicMap } from './message-bus';
import { createServiceRuntime } from './service-runtime';

const runtime = createServiceRuntime('risk-service', Number(process.env.RISK_SERVICE_PORT || 8795), {
  role: 'risk-evaluator',
});

runtime.app.get('/config', (_req, res) => {
  const topics = getKafkaTopicMap();
  res.json({
    consumes: [topics.accountSnapshot, topics.orderbookProjection, topics.marketSnapshot],
    plannedOutputs: ['risk.limit.breach', 'risk.margin.warning'],
  });
});

runtime.app.post('/evaluate', async (req, res) => {
  const notional = Number(req.body?.notional || 0);
  const maxNotional = Number(req.body?.maxNotional || 0);
  const leverage = Number(req.body?.leverage || 0);
  const maxLeverage = Number(req.body?.maxLeverage || 0);
  const breaches = [];

  if (maxNotional > 0 && notional > maxNotional) breaches.push('notional_limit');
  if (maxLeverage > 0 && leverage > maxLeverage) breaches.push('leverage_limit');

  res.json({
    allow: breaches.length === 0,
    breaches,
  });
});

void runtime.listen().catch((error) => {
  console.error('[risk-service] fatal error', error);
  process.exitCode = 1;
});

