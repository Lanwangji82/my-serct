type ExchangeName = 'binance' | 'okx';

interface ClashProxyMapEntry {
  type?: string;
  all?: string[];
  now?: string;
}

interface ClashProxiesResponse {
  proxies?: Record<string, ClashProxyMapEntry>;
}

export interface ClashProxyDelayResult {
  name: string;
  delay: number;
}

function getControllerUrl() {
  return process.env.CLASH_CONTROLLER_URL || 'http://127.0.0.1:9090';
}

function getHeaders() {
  const secret = process.env.CLASH_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

function getSelectorGroup() {
  return process.env.CLASH_SELECTOR_GROUP || '🚀节点选择';
}

function getTestUrl(exchange: ExchangeName) {
  if (exchange === 'okx') {
    return process.env.CLASH_OKX_TEST_URL || 'https://www.okx.com/api/v5/public/time';
  }
  return process.env.CLASH_BINANCE_TEST_URL || 'https://api.binance.com/api/v3/ping';
}

function getTimeoutMs() {
  const value = Number(process.env.CLASH_DELAY_TIMEOUT_MS || 4000);
  return Number.isFinite(value) ? value : 4000;
}

async function clashFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${getControllerUrl()}${path}`, {
    ...init,
    headers: {
      ...getHeaders(),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Clash controller request failed (${response.status}): ${text || path}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json() as Promise<T>;
}

async function getProxyMap() {
  const response = await clashFetch<ClashProxiesResponse>('/proxies');
  return response.proxies || {};
}

export async function getClashSelectorSnapshot() {
  const selectorName = getSelectorGroup();
  const proxies = await getProxyMap();
  const selector = proxies[selectorName];
  if (!selector) {
    throw new Error(`Clash selector group not found: ${selectorName}`);
  }

  return {
    selectorName,
    now: selector.now || null,
    all: selector.all || [],
  };
}

async function testProxyDelay(name: string, exchange: ExchangeName) {
  const timeout = getTimeoutMs();
  const url = encodeURIComponent(getTestUrl(exchange));
  const path = `/proxies/${encodeURIComponent(name)}/delay?url=${url}&timeout=${timeout}`;

  try {
    const response = await clashFetch<{ delay?: number }>(path);
    const delay = Number(response?.delay);
    if (Number.isFinite(delay) && delay > 0) {
      return { name, delay };
    }
  } catch {
    return null;
  }

  return null;
}

export async function benchmarkClashSelector(exchange: ExchangeName) {
  const selector = await getClashSelectorSnapshot();
  const candidates = selector.all.filter((name) => !['DIRECT', 'REJECT', 'REJECT-DROP'].includes(name));
  const results = await Promise.all(candidates.map((name) => testProxyDelay(name, exchange)));
  return results
    .filter((item): item is ClashProxyDelayResult => item !== null)
    .sort((a, b) => a.delay - b.delay);
}

export async function switchClashSelector(name: string) {
  const selectorName = getSelectorGroup();
  await clashFetch(`/proxies/${encodeURIComponent(selectorName)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  return {
    selectorName,
    selected: name,
  };
}

export async function optimizeClashSelector(exchange: ExchangeName) {
  const ranked = await benchmarkClashSelector(exchange);
  const best = ranked[0] || null;
  if (!best) {
    throw new Error(`No available Clash proxy candidates for ${exchange}`);
  }
  const switched = await switchClashSelector(best.name);
  return {
    exchange,
    best,
    ranked,
    ...switched,
    testedUrl: getTestUrl(exchange),
    updatedAt: Date.now(),
  };
}

export async function autoOptimizeClashSelectors() {
  if (process.env.CLASH_AUTO_OPTIMIZE !== '1') {
    return null;
  }

  const exchanges = (process.env.CLASH_AUTO_OPTIMIZE_EXCHANGES || 'binance,okx')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is ExchangeName => item === 'binance' || item === 'okx');

  const results = [];
  for (const exchange of exchanges) {
    try {
      results.push(await optimizeClashSelector(exchange));
    } catch (error) {
      results.push({
        exchange,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      });
    }
  }
  return results;
}
