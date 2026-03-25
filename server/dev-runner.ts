import './bootstrap-env';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const PLATFORM_HEALTH_URL = `http://127.0.0.1:${process.env.PY_PLATFORM_PORT || '8800'}/health`;
const PLATFORM_READY_TIMEOUT_MS = 20_000;
const LOCAL_SERVICES = [
  { serviceName: 'MongoDB', label: 'MongoDB' },
  { serviceName: 'Memurai', label: 'Memurai (Redis-compatible)' },
] as const;

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

function runCommand(command: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: stderr + String(error) });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function isWindowsServiceRunning(serviceName: string) {
  const result = await runCommand('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status)`,
  ]);
  return result.code === 0 && result.stdout.trim().toLowerCase() === 'running';
}

async function startWindowsService(serviceName: string) {
  return runCommand('powershell', [
    '-NoProfile',
    '-Command',
    `Start-Service -Name '${serviceName}' -ErrorAction Stop`,
  ]);
}

async function ensureLocalDependenciesReady() {
  if (process.platform !== 'win32') {
    return;
  }

  for (const service of LOCAL_SERVICES) {
    const running = await isWindowsServiceRunning(service.serviceName);
    if (running) {
      console.info(`[dev-runner] reusing existing ${service.label} service`);
      continue;
    }

    const result = await startWindowsService(service.serviceName);
    if (result.code === 0) {
      console.info(`[dev-runner] started ${service.label} service`);
      continue;
    }

    const detail = (result.stderr || result.stdout).trim();
    console.warn(`[dev-runner] failed to start ${service.label}: ${detail || 'unknown error'}`);
  }
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
  await ensureLocalDependenciesReady();

  const alreadyReady = await waitForPlatformReady(1500);
  if (!alreadyReady) {
    const platformService = runScript('service:py-platform');
    children.push(platformService);
  } else {
    console.info('[dev-runner] reusing existing python platform service');
  }

  const platformReady = alreadyReady || (await waitForPlatformReady());
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
