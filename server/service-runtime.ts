import express from 'express';
import { createServer } from 'node:http';
import { createRuntimeMonitor } from './runtime-monitor';

export interface ServiceRuntime {
  app: express.Express;
  monitor: ReturnType<typeof createRuntimeMonitor>;
  listen: () => Promise<void>;
}

export function createServiceRuntime(
  serviceName: string,
  port: number,
  meta?: Record<string, unknown>,
): ServiceRuntime {
  const app = express();
  const monitor = createRuntimeMonitor(serviceName);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await monitor.markLive(meta);
    res.json(monitor.snapshot());
  });

  return {
    app,
    monitor,
    async listen() {
      const server = createServer(app);
      await new Promise<void>((resolve) => {
        server.listen(port, () => resolve());
      });
      await monitor.markLive({
        port,
        ...meta,
      });
      console.log(`[${serviceName}] listening on http://127.0.0.1:${port}`);
    },
  };
}

