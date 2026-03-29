import './bootstrap-env';
import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const PLATFORM_HEALTH_URL = `http://127.0.0.1:${process.env.PY_PLATFORM_PORT || '8800'}/health`;
const PLATFORM_READY_TIMEOUT_MS = 20_000;
const SINGBOX_BASE_DIR = process.env.SINGBOX_BASE_DIR || 'D:\\Program Files\\sing-box-1.12.15-windows-amd64\\sing-box-1.12.15-windows-amd64';
const SINGBOX_START_SCRIPT = `${SINGBOX_BASE_DIR}\\start-sing-box.ps1`;
const SINGBOX_STOP_SCRIPT = `${SINGBOX_BASE_DIR}\\stop-sing-box.ps1`;
const SINGBOX_HEALTH_URL = 'http://127.0.0.1:9090/version';
const LOCAL_SERVICES = [
  { serviceName: 'MongoDB', label: 'MongoDB' },
  { serviceName: 'Memurai', label: 'Memurai (Redis-compatible)' },
] as const;
type LocalService = (typeof LOCAL_SERVICES)[number];
const CHILD_EXIT_TIMEOUT_MS = 8_000;

function runSpawn(command: string, args: string[], label: string) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const pipeStream = (stream: NodeJS.ReadableStream | null | undefined, writer: NodeJS.WriteStream) => {
    if (!stream) return;
    const lineReader = readline.createInterface({ input: stream });
    lineReader.on('line', (line) => {
      writer.write(`${line}\n`);
    });
    child.once('exit', () => {
      lineReader.close();
    });
  };

  pipeStream(child.stdout, process.stdout);
  pipeStream(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (!isShuttingDown && code && code !== 0) {
      console.error(`[dev-runner] ${label} exited with code ${code}`);
    }
  });

  return child;
}

function runViteDev() {
  const viteEntry = path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
  return runSpawn(process.execPath, [viteEntry, '--port=3000', '--host=0.0.0.0'], 'vite dev');
}

function runPythonPlatform() {
  return runSpawn('python', ['python_services/run_server.py'], 'python platform service');
}

function runPowerShellScript(scriptPath: string, label: string) {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ], {
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', (code) => {
    if (!isShuttingDown && code && code !== 0) {
      console.error(`[dev-runner] ${label} exited with code ${code}`);
    }
  });

  return child;
}

function runCommand(command: string, args: string[], timeoutMs = 15_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, {
      shell: false,
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

    const timeout = setTimeout(() => {
      stderr += `Command timed out after ${timeoutMs}ms`;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill errors
      }
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: stderr + String(error) });
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
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
  ], 10_000);
}

async function stopWindowsService(serviceName: string) {
  return runCommand('powershell', [
    '-NoProfile',
    '-Command',
    `Stop-Service -Name '${serviceName}' -ErrorAction Stop`,
  ], 8_000);
}

async function ensureLocalDependenciesReady() {
  if (process.platform !== 'win32') {
    return [] as LocalService[];
  }

  const startedServices: LocalService[] = [];
  for (const service of LOCAL_SERVICES) {
    const running = await isWindowsServiceRunning(service.serviceName);
    if (running) {
      console.info(`[dev-runner] reusing existing ${service.label} service`);
      continue;
    }

    const result = await startWindowsService(service.serviceName);
    if (result.code === 0) {
      console.info(`[dev-runner] started ${service.label} service`);
      startedServices.push(service);
      continue;
    }

    const detail = (result.stderr || result.stdout).trim();
    console.warn(`[dev-runner] failed to start ${service.label}: ${detail || 'unknown error'}`);
  }

  return startedServices;
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

async function waitForSingBoxReady(timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(SINGBOX_HEALTH_URL);
      if (response.ok) {
        return true;
      }
    } catch {
      // sing-box not ready yet
    }

    await delay(250);
  }

  return false;
}

const children: ChildProcess[] = [];
const watchers: FSWatcher[] = [];
const startedServices: LocalService[] = [];
let startedSingBox = false;
let isShuttingDown = false;
let platformService: ChildProcess | null = null;
let platformRestartTimer: NodeJS.Timeout | null = null;

function removeChild(child: ChildProcess | null) {
  if (!child) return;
  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

async function stopPlatformService() {
  if (!platformService || platformService.killed) {
    platformService = null;
    return;
  }

  const child = platformService;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      void killChildProcess(child).finally(resolve);
    }, 3000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    void killChildProcess(child);
  });

  removeChild(child);
  platformService = null;
}

async function killChildProcess(child: ChildProcess | null) {
  if (!child || !child.pid || child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/PID', String(child.pid), '/T', '/F'], 8_000);
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore termination errors
  }
}

async function waitForChildExit(child: ChildProcess | null, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  if (!child || !child.pid || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function terminateChildProcess(child: ChildProcess | null) {
  if (!child) {
    return;
  }

  await killChildProcess(child);
  await waitForChildExit(child);
}

async function startPlatformService({ forceRestart = false } = {}) {
  if (forceRestart) {
    await stopPlatformService();
  } else if (platformService && !platformService.killed) {
    return;
  }

  platformService = runPythonPlatform();
  children.push(platformService);
}

function schedulePlatformRestart(reason: string) {
  if (isShuttingDown) return;
  if (platformRestartTimer) {
    clearTimeout(platformRestartTimer);
  }
  platformRestartTimer = setTimeout(() => {
    platformRestartTimer = null;
    console.info(`[dev-runner] restarting python platform service (${reason})`);
    void startPlatformService({ forceRestart: true });
  }, 350);
}

function watchPythonPlatformSources() {
  const roots = [
    path.resolve(process.cwd(), 'python_services'),
  ];

  for (const root of roots) {
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const changed = String(filename || '').replaceAll('\\', '/');
        if (!changed) return;
        if (!changed.endsWith('.py') && !changed.endsWith('.json')) return;
        if (changed.includes('__pycache__')) return;
        schedulePlatformRestart(changed);
      });
      watchers.push(watcher);
    } catch (error) {
      console.warn(`[dev-runner] failed to watch python sources: ${String(error)}`);
    }
  }
}

async function main() {
  startedServices.push(...(await ensureLocalDependenciesReady()));

  const singBoxReady = await waitForSingBoxReady(1000);
  if (!singBoxReady) {
    console.info('[dev-runner] starting sing-box proxy');
    const singBox = runPowerShellScript(SINGBOX_START_SCRIPT, 'sing-box proxy');
    children.push(singBox);
    startedSingBox = true;
  } else {
    console.info('[dev-runner] reusing existing sing-box proxy');
  }

  const proxyReady = singBoxReady || (await waitForSingBoxReady());
  if (!proxyReady) {
    console.warn('[dev-runner] sing-box proxy did not report ready within 10s, continuing startup');
  }

  const alreadyReady = await waitForPlatformReady(1500);
  if (!alreadyReady) {
    await startPlatformService();
  } else {
    console.info('[dev-runner] reusing existing python platform service');
  }

  const platformReady = alreadyReady || (await waitForPlatformReady());
  if (!platformReady) {
    console.warn('[dev-runner] python platform service did not report ready within 20s, starting Vite anyway');
  }

  const dev = runViteDev();
  children.push(dev);
  watchPythonPlatformSources();
}

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.info(`[dev-runner] shutting down (${signal})`);

  for (const child of children) {
    await terminateChildProcess(child);
  }

  if (platformRestartTimer) {
    clearTimeout(platformRestartTimer);
    platformRestartTimer = null;
  }

  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore watcher shutdown errors
    }
  }

  if (startedSingBox) {
    console.info('[dev-runner] stopping sing-box proxy');
    const result = await runCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SINGBOX_STOP_SCRIPT,
    ], 8_000);
    if (result.code === 0) {
      console.info('[dev-runner] stopped sing-box proxy');
    } else {
      const detail = (result.stderr || result.stdout).trim();
      console.warn(`[dev-runner] failed to stop sing-box proxy: ${detail || 'unknown error'}`);
    }
  }

  for (const service of startedServices.slice().reverse()) {
    console.info(`[dev-runner] stopping ${service.label}`);
    const result = await stopWindowsService(service.serviceName);
    if (result.code === 0) {
      console.info(`[dev-runner] stopped ${service.label}`);
    } else {
      const detail = (result.stderr || result.stdout).trim();
      console.warn(`[dev-runner] failed to stop ${service.label}: ${detail || 'unknown error'}`);
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

void main();
