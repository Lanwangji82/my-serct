import type { Express, Request, Response } from 'express';
import { listBrokerRegistrySummaries } from './adapters/broker-registry';
import { getPlatformModuleCatalog } from './services/module-catalog';
import { appendPlatformAuditEvent, listPlatformAuditTrail, listPlatformCredentialSummaries, savePlatformCredential } from './services/governance-domain';
import { loginPlatformUser, requirePlatformUser } from './services/auth-domain';
import { runPlatformBacktest, listPlatformBacktests } from './services/simulation-domain';
import { submitPlatformExecution } from './services/execution-domain';
import { getPlatformPortfolioAccount } from './services/portfolio-domain';
import { listPlatformStrategies, savePlatformStrategy } from './services/strategy-domain';

function getBearerToken(req: Request) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

function registerGet(app: Express, paths: string[], handler: (req: Request, res: Response) => void | Promise<void>) {
  paths.forEach((path) => app.get(path, handler));
}

function registerPost(app: Express, paths: string[], handler: (req: Request, res: Response) => void | Promise<void>) {
  paths.forEach((path) => app.post(path, handler));
}

export function registerQuantPlatformApi(app: Express) {
  const basePaths = ['/api/platform', '/api/binance/platform'];

  registerGet(app, [`${basePaths[0]}/modules`, `${basePaths[1]}/modules`], async (_req, res) => {
    res.json(getPlatformModuleCatalog());
  });

  registerGet(app, [`${basePaths[0]}/brokers`, `${basePaths[1]}/brokers`], async (_req, res) => {
    res.json(listBrokerRegistrySummaries());
  });

  registerPost(app, basePaths.map((base) => `${base}/auth/login`), async (req, res) => {
    try {
      const result = await loginPlatformUser(String(req.body?.email || ''), String(req.body?.password || ''));
      await appendPlatformAuditEvent({
        actorUserId: result.user.id,
        type: 'auth.login',
        payload: { email: result.user.email },
      });
      res.json(result);
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Login failed' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/me`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json({ user });
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/strategies`), async (req, res) => {
    try {
      await requirePlatformUser(getBearerToken(req));
      res.json(await listPlatformStrategies());
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  registerPost(app, basePaths.map((base) => `${base}/strategies`), async (req, res) => {
    try {
      await requirePlatformUser(getBearerToken(req));
      res.json(await savePlatformStrategy(req.body));
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to save strategy' });
    }
  });

  registerPost(app, basePaths.map((base) => `${base}/backtests`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json(await runPlatformBacktest({
        actorUserId: user.id,
        strategyId: String(req.body?.strategyId || ''),
        lookback: Number(req.body?.lookback || 500),
        initialCapital: Number(req.body?.initialCapital || 10000),
        feeBps: Number(req.body?.feeBps || 4),
        slippageBps: Number(req.body?.slippageBps || 2),
      }));
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to execute backtest' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/backtests`), async (req, res) => {
    try {
      await requirePlatformUser(getBearerToken(req));
      res.json(await listPlatformBacktests(typeof req.query.strategyId === 'string' ? req.query.strategyId : undefined));
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  registerPost(app, basePaths.map((base) => `${base}/credentials`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      await savePlatformCredential({
        userId: user.id,
        brokerTarget: req.body?.brokerTarget,
        label: String(req.body?.label || 'Broker credential'),
        apiKey: String(req.body?.apiKey || ''),
        apiSecret: String(req.body?.apiSecret || ''),
      });
      await appendPlatformAuditEvent({
        actorUserId: user.id,
        type: 'secret.saved',
        payload: { brokerTarget: req.body?.brokerTarget, label: req.body?.label },
      });
      res.json(await listPlatformCredentialSummaries(user.id));
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to save credential' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/credentials`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json(await listPlatformCredentialSummaries(user.id));
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  registerPost(app, basePaths.map((base) => `${base}/execution`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json(await submitPlatformExecution({
        actorUserId: user.id,
        strategyId: String(req.body?.strategyId || ''),
        brokerTarget: req.body?.brokerTarget,
        side: req.body?.side === 'SELL' ? 'SELL' : 'BUY',
        quantity: Number(req.body?.quantity || 0) || undefined,
        leverage: Number(req.body?.leverage || 1),
      }));
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to submit execution' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/paper-account`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json(await getPlatformPortfolioAccount(user.id));
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  registerGet(app, basePaths.map((base) => `${base}/audit`), async (req, res) => {
    try {
      const user = await requirePlatformUser(getBearerToken(req));
      res.json(await listPlatformAuditTrail(user.id));
    } catch (error) {
      res.status(401).json({ message: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });
}
