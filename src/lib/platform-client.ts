export const PLATFORM_API_BASE = "/api/platform";
export const RESEARCH_API_BASE = "/research";
export const PORTFOLIO_API_BASE = "/portfolio";
export const GOVERNANCE_API_BASE = "/governance";

const inflightGetRequests = new Map<string, Promise<unknown>>();
const cachedGetResponses = new Map<string, { expiresAt: number; value: unknown }>();

export type BrokerTarget = "paper" | `${string}:${"sandbox" | "production"}`;

export type BrokerRegistrySummary = {
  brokerId: string;
  label: string;
  supportsMarketData: boolean;
  supportsExecution: boolean;
  targets: Array<{
    target: `${string}:${"sandbox" | "production"}`;
    mode: "sandbox" | "production";
    label: string;
  }>;
};

export function formatDateTime(value: number) {
  return new Date(value).toLocaleString("zh-CN");
}

export function formatMoney(value: number | null | undefined, digits = 2) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value ?? 0);
}

function getCacheTtl(path: string) {
  if (path.includes("/runtime/connectivity")) return 5_000;
  if (path.includes("/backtests/")) return 1_000;
  if (path.includes("/strategies") || path.includes("/me")) return 2_000;
  return 0;
}

export async function authorizedFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const isCacheableGet = method === "GET" && !init?.body;
  const cacheKey = isCacheableGet ? `${token}::${path}` : "";
  const ttl = isCacheableGet ? getCacheTtl(path) : 0;
  const now = Date.now();

  if (isCacheableGet && ttl > 0) {
    const cached = cachedGetResponses.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }
    const inflight = inflightGetRequests.get(cacheKey);
    if (inflight) {
      return inflight as Promise<T>;
    }
  }

  const request = fetch(path, {
    ...init,
    headers,
  }).then(async (response) => {
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.detail || json?.message || "平台请求失败");
    }
    if (isCacheableGet && ttl > 0) {
      cachedGetResponses.set(cacheKey, { expiresAt: Date.now() + ttl, value: json });
    }
    if (!isCacheableGet) {
      cachedGetResponses.clear();
      inflightGetRequests.clear();
    }
    return json as T;
  });

  if (isCacheableGet && ttl > 0) {
    inflightGetRequests.set(cacheKey, request as Promise<unknown>);
  }

  try {
    return await request;
  } finally {
    if (isCacheableGet && ttl > 0) {
      inflightGetRequests.delete(cacheKey);
    }
  }
}
