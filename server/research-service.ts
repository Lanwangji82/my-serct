import { createServiceRuntime } from './service-runtime';
import { requirePlatformUser } from './platform/services/auth-domain';
import { listPlatformBacktests } from './platform/services/simulation-domain';
import { getPlatformModuleCatalog } from './platform/services/module-catalog';
import { listPlatformStrategies, savePlatformStrategy } from './platform/services/strategy-domain';

function getBearerToken(header?: string) {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

const runtime = createServiceRuntime('research-service', Number(process.env.RESEARCH_SERVICE_PORT || 8797), {
  role: 'research-service',
});

runtime.app.get('/research/modules', async (_req, res) => {
  res.json(getPlatformModuleCatalog().filter((item) => ['research', 'simulation'].includes(item.id)));
});

runtime.app.get('/research/strategies', async (req, res) => {
  try {
    await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await listPlatformStrategies());
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
  }
});

runtime.app.post('/research/strategies', async (req, res) => {
  try {
    await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await savePlatformStrategy(req.body));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to save strategy' });
  }
});

runtime.app.get('/research/backtests', async (req, res) => {
  try {
    await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await listPlatformBacktests(typeof req.query.strategyId === 'string' ? req.query.strategyId : undefined));
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
  }
});

void runtime.listen().catch((error) => {
  console.error('[research-service] fatal error', error);
  process.exitCode = 1;
});
