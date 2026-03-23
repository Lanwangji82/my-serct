import { getCacheStore } from './cache-store';
import { createServiceRuntime } from './service-runtime';
import { accountSnapshotCacheKey } from './cache-keys';

const runtime = createServiceRuntime('account-gateway-service', Number(process.env.ACCOUNT_GATEWAY_PORT || 8794), {
  role: 'account-gateway',
  cacheDriver: process.env.CACHE_DRIVER || 'memory',
});

const cacheStore = getCacheStore();

runtime.app.get('/account/:token/snapshot', async (req, res) => {
  const payload = await cacheStore.get(accountSnapshotCacheKey(req.params.token));
  res.json({
    found: Boolean(payload),
    data: payload,
  });
});

void runtime.listen().catch((error) => {
  console.error('[account-gateway-service] fatal error', error);
  process.exitCode = 1;
});

