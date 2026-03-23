import './bootstrap-env';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PLATFORM_HEALTH_URL = `http://127.0.0.1:${process.env.PY_PLATFORM_PORT || '8800'}/health`;
const PLATFORM_READY_TIMEOUT_MS = 20_000;

function runScript(name: string) {
  const child = spawn('npm', ['run', name], {
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev-runner] script "${name}" exited with code ${code}`);
    }
  });

  return child;
}

async function waitForPlatformReady(timeoutMs = PLATFORM_READY_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(PLATFORM_HEALTH_URL);
      if (response.ok) {
        return true;
      }
    } catch {
      // proxy not ready yet
    }

    await delay(250);
  }

  return false;
}

const children: ChildProcess[] = [];

async function main() {
  const platformService = runScript('service:py-platform');
  children.push(platformService);

  const platformReady = await waitForPlatformReady();
  if (!platformReady) {
    console.warn('[dev-runner] python platform service did not report ready within 20s, starting Vite anyway');
  }

  const dev = runScript('dev');
  children.push(dev);
}

function shutdown(signal: NodeJS.Signals) {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void main();
