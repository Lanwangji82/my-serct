type CcxtScope = 'public' | 'private';
type CcxtStatus = 'ok' | 'error';

export interface CcxtTelemetryEvent {
  scope: CcxtScope;
  operation: string;
  exchange: string;
  marketType: string;
  status: CcxtStatus;
  durationMs: number;
  timestamp: number;
  endpointLabel: string;
  proxyLabel: string;
  message?: string;
}

const MAX_EVENTS = 200;
const events: CcxtTelemetryEvent[] = [];

function getProxyLabel() {
  const explicit = process.env.CCXT_HTTP_PROXY
    || process.env.CCXT_HTTPS_PROXY
    || process.env.CCXT_SOCKS_PROXY
    || process.env.CCXT_WS_PROXY
    || process.env.CCXT_WSS_PROXY;
  const inherited = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
  return explicit || inherited || 'direct';
}

function sanitizeMessage(message?: string) {
  if (!message) return undefined;
  return message.slice(0, 180);
}

export function recordCcxtTelemetry(event: Omit<CcxtTelemetryEvent, 'timestamp' | 'proxyLabel'> & { timestamp?: number; proxyLabel?: string }) {
  events.unshift({
    ...event,
    timestamp: event.timestamp ?? Date.now(),
    proxyLabel: event.proxyLabel ?? getProxyLabel(),
    message: sanitizeMessage(event.message),
  });

  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
}

function summarize(scope: CcxtScope) {
  const scoped = events.filter((event) => event.scope === scope);
  const recent = scoped.slice(0, 12);
  const successes = scoped.filter((event) => event.status === 'ok');
  const failures = scoped.filter((event) => event.status === 'error');
  const avgDurationMs = successes.length
    ? Math.round(successes.reduce((sum, event) => sum + event.durationMs, 0) / successes.length)
    : null;

  return {
    total: scoped.length,
    successCount: successes.length,
    errorCount: failures.length,
    avgDurationMs,
    latestOkAt: successes[0]?.timestamp ?? null,
    latestErrorAt: failures[0]?.timestamp ?? null,
    recent,
  };
}

export function getCcxtTelemetrySnapshot() {
  return {
    proxy: {
      active: getProxyLabel(),
      noProxy: process.env.NO_PROXY || null,
      nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY || null,
    },
    public: summarize('public'),
    private: summarize('private'),
    updatedAt: Date.now(),
  };
}
