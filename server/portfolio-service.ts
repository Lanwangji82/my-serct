import { createServiceRuntime } from './service-runtime';
import { requirePlatformUser } from './platform/services/auth-domain';
import { getPlatformModuleCatalog } from './platform/services/module-catalog';
import { getPlatformPortfolioAccount } from './platform/services/portfolio-domain';

function getBearerToken(header?: string) {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

const runtime = createServiceRuntime('portfolio-service', Number(process.env.PORTFOLIO_SERVICE_PORT || 8798), {
  role: 'portfolio-service',
});

runtime.app.get('/portfolio/modules', async (_req, res) => {
  res.json(getPlatformModuleCatalog().filter((item) => item.id === 'portfolio'));
});

runtime.app.get('/portfolio/account', async (req, res) => {
  try {
    const user = await requirePlatformUser(getBearerToken(req.headers.authorization));
    res.json(await getPlatformPortfolioAccount(user.id));
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
  }
});

void runtime.listen().catch((error) => {
  console.error('[portfolio-service] fatal error', error);
  process.exitCode = 1;
});
