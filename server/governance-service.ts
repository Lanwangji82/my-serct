import { createServiceRuntime } from './service-runtime';
import { listBrokerRegistrySummaries } from './platform/adapters/broker-registry';
import { requirePlatformUser } from './platform/services/auth-domain';
import { getPlatformModuleCatalog } from './platform/services/module-catalog';
import { listPlatformAuditTrail, listPlatformCredentialSummaries, savePlatformCredential } from './platform/services/governance-domain';

function getBearerToken(header?: string) {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

const runtime = createServiceRuntime('governance-service', Number(process.env.GOVERNANCE_SERVICE_PORT || 8799), {
  role: 'governance-service',
});

runtime.app.get('/governance/modules', async (_req, res) => {
  res.json(getPlatformModuleCatalog().filter((item) => item.id === 'governance'));
});

runtime.app.get('/governance/brokers', async (_req, res) => {
  res.json(listBrokerRegistrySummaries());
});

runtime.app.get('/governance/credentials', async (req, res) => {
  try {
    const user = await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await listPlatformCredentialSummaries(user.id));
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
  }
});

runtime.app.post('/governance/credentials', async (req, res) => {
  try {
    const user = await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await savePlatformCredential({
      userId: user.id,
      brokerTarget: req.body?.brokerTarget,
      label: String(req.body?.label || 'Broker credential'),
      apiKey: String(req.body?.apiKey || ''),
      apiSecret: String(req.body?.apiSecret || ''),
    }));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to save credential' });
  }
});

runtime.app.get('/governance/audit', async (req, res) => {
  try {
    const user = await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await listPlatformAuditTrail(user.id));
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
  }
});

void runtime.listen().catch((error) => {
  console.error('[governance-service] fatal error', error);
  process.exitCode = 1;
});
