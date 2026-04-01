export const PLATFORM_API_BASE = "/api/platform";
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

export type NetworkClientId = "auto" | "jp" | "sg" | "us" | "hk" | "direct";

export type NetworkClientCatalogEntry = {
  clientId: NetworkClientId;
  label: string;
  defaultPort: number;
  kind: string;
};

export type NetworkRouteCatalogEntry = {
  routeId: string;
  label: string;
  kind: string;
};

export type RuntimeProxySummary = {
  configured: boolean;
  mode?: string;
  source?: string;
  activeProxy?: string;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
};

export type RuntimeConfig = {
  appPort: number;
  localMode: boolean;
  databasePath: string;
  strategyStoreRoot: string;
  networkClients: {
    clients: Record<NetworkClientId, { port: number }>;
    routes: Record<string, NetworkClientId>;
    clientCatalog?: NetworkClientCatalogEntry[];
    routeCatalog?: NetworkRouteCatalogEntry[];
    updatedAt: number;
  };
  networkClientCatalog?: NetworkClientCatalogEntry[];
  networkRouteCatalog?: NetworkRouteCatalogEntry[];
  networkAdapters?: Array<{
    adapterId: string;
    label: string;
    kind: string;
    configurable: boolean;
    description: string;
  }>;
  brokerLatencyProviders?: Array<{
    providerId: string;
    label: string;
    supportedTargets: string[];
  }>;
  brokerTargets?: Array<{
    target: string;
    brokerId: string;
    mode: string;
    label: string;
    supportsMarketData: boolean;
    supportsExecution: boolean;
  }>;
  dataProviders?: {
    tushare?: {
      enabled: boolean;
      configured: boolean;
      baseUrl: string;
      tokenMasked: string;
      status?: {
        ok: boolean;
        message: string;
        checkedAt: number;
      };
    };
    llm?: {
      enabled: boolean;
      configured: boolean;
      provider: string;
      baseUrl: string;
      model: string;
      apiKeyMasked: string;
      mode: "system" | "llm";
      status?: {
        ok: boolean;
        message: string;
        checkedAt: number;
      };
    };
  };
  semanticRetrieval?: {
    mode: "local" | "milvus";
    label: string;
    milvusEnabled: boolean;
    uriConfigured: boolean;
    remoteReady: boolean;
    collection?: string | null;
    checkedAt: number;
  };
  storage?: {
    requestedBackend: string;
    activeBackend: string;
    fallbackActive: boolean;
    modeLabel: string;
    databasePath: string;
    redis: {
      configured: boolean;
      enabled: boolean;
      label: string;
    };
  };
  proxy: RuntimeProxySummary;
  checkedAt: number;
};

export type RuntimeOperations = {
  checkedAt: number;
  proxy: RuntimeProxySummary;
  connectivity: {
    proxy?: RuntimeProxySummary;
    brokers?: Array<{
      brokerTarget: string;
      ok: boolean;
      error?: string;
      remoteTime?: number;
      latencyMs?: number;
      checkedAt?: number;
    }>;
    checkedAt?: number;
  };
  providerChecks: Array<{
    providerId: string;
    label: string;
    ok: boolean;
    configured: boolean;
    enabled: boolean;
    message: string;
    checkedAt: number;
  }>;
  semanticRetrieval?: RuntimeConfig["semanticRetrieval"];
  storage?: RuntimeConfig["storage"];
  eventSourceChecks: Array<{
    sourceId: string;
    label: string;
    ok: boolean;
    detail: string;
    updatedAt: number;
  }>;
  snapshotStatus?: {
    marketSnapshots?: Record<string, number>;
    intelligenceSnapshots?: Record<string, number>;
  };
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
  if (path.includes("/runtime/operations")) return 10_000;
  if (path.includes("/intelligence/overview")) return 10_000;
  if (path.includes("/market/catalog")) return 60_000;
  if (path.includes("/market/regime")) return 30_000;
  if (path.includes("/market/series")) return 15_000;
  if (path.includes("/portfolio/positions")) return 1_000;
  if (path.includes("/portfolio/accounts")) return 5_000;
  if (path.includes("/backtests/")) return 1_000;
  if (path.includes("/strategies") || path.includes("/me")) return 2_000;
  if (path.includes("/runtime/config")) return 10_000;
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
