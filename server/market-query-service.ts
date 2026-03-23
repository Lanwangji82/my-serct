import { getCacheStore } from './cache-store';
import { getClickHouseStore } from './clickhouse-store';
import { createServiceRuntime } from './service-runtime';
import { marketTopSymbolsCacheKey } from './cache-keys';

const runtime = createServiceRuntime('market-query-service', Number(process.env.MARKET_QUERY_PORT || 8789), {
  role: 'query-service',
  cacheDriver: process.env.CACHE_DRIVER || 'memory',
  historicalDriver: process.env.HISTORICAL_STORE_DRIVER || 'none',
});

const cacheStore = getCacheStore();
const clickhouseStore = getClickHouseStore();

runtime.app.get('/market/:type/top-symbols', async (req, res) => {
  const type = req.params.type === 'futures' ? 'futures' : 'spot';
  const payload = await cacheStore.get(marketTopSymbolsCacheKey(type));
  res.json({
    source: payload ? 'cache' : 'empty',
    data: payload,
  });
});

runtime.app.get('/storage/stats', async (_req, res) => {
  res.json({
    cache: await cacheStore.getStats(),
    clickhouse: await clickhouseStore.getStats(),
  });
});

void runtime.listen().catch((error) => {
  console.error('[market-query-service] fatal error', error);
  process.exitCode = 1;
});

