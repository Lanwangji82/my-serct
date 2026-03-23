import express from 'express';
import { createServer } from 'node:http';
import { getCacheStore } from './cache-store';

export interface RuntimeMonitorSnapshot {
  service: string;
  status: 'starting' | 'live' | 'degraded' | 'error';
  pid: number;
  updatedAt: number;
  startedAt: number;
  counters: Record<string, number>;
  meta?: Record<string, unknown>;
  lastError?: string | null;
}

export interface RuntimeMonitor {
  markLive(meta?: Record<string, unknown>): Promise<void>;
  markDegraded(lastError: string, meta?: Record<string, unknown>): Promise<void>;
  markError(lastError: string, meta?: Record<string, unknown>): Promise<void>;
  increment(counter: string, delta?: number): Promise<void>;
  snapshot(): RuntimeMonitorSnapshot;
}

const cacheStore = getCacheStore();

export function getRuntimeHealthKey(service: string) {
  return `runtime:${service}:health`;
}

export async function getRuntimeHealthSnapshot(service: string) {
  return cacheStore.get<RuntimeMonitorSnapshot>(getRuntimeHealthKey(service));
}

export function createRuntimeMonitor(service: string, options?: { port?: number }) : RuntimeMonitor {
  const startedAt = Date.now();
  const counters: Record<string, number> = {};
  let status: RuntimeMonitorSnapshot['status'] = 'starting';
  let meta: Record<string, unknown> | undefined;
  let lastError: string | null = null;

  const writeSnapshot = async () => {
    const payload: RuntimeMonitorSnapshot = {
      service,
      status,
      pid: process.pid,
      updatedAt: Date.now(),
      startedAt,
      counters: { ...counters },
      meta,
      lastError,
    };
    await cacheStore.set(getRuntimeHealthKey(service), payload, 30_000);
    return payload;
  };

  const app = express();
  app.get('/health', async (_req, res) => {
    res.json(await writeSnapshot());
  });
  app.get('/metrics', async (_req, res) => {
    res.json(await writeSnapshot());
  });

  if (options?.port) {
    const server = createServer(app);
    server.listen(options.port, () => {
      console.log(`[RuntimeMonitor] ${service} health endpoint on http://127.0.0.1:${options.port}/health`);
    });
  }

  void writeSnapshot();

  return {
    async markLive(nextMeta) {
      status = 'live';
      lastError = null;
      meta = nextMeta ?? meta;
      await writeSnapshot();
    },
    async markDegraded(errorMessage, nextMeta) {
      status = 'degraded';
      lastError = errorMessage;
      meta = nextMeta ?? meta;
      await writeSnapshot();
    },
    async markError(errorMessage, nextMeta) {
      status = 'error';
      lastError = errorMessage;
      meta = nextMeta ?? meta;
      await writeSnapshot();
    },
    async increment(counter, delta = 1) {
      counters[counter] = (counters[counter] || 0) + delta;
      await writeSnapshot();
    },
    snapshot() {
      return {
        service,
        status,
        pid: process.pid,
        updatedAt: Date.now(),
        startedAt,
        counters: { ...counters },
        meta,
        lastError,
      };
    },
  };
}
