import './bootstrap-env';
import {
  DEFAULT_CLIENT_ROUTES,
  type BrokerNetworkTarget,
  getConfiguredRouteIds,
  getDefaultClientUrl,
  getSavedRoute,
  type NetworkClientId,
} from './network-client-settings';

type CcxtProxyOptions = {
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  wsProxy?: string;
  wssProxy?: string;
};

type ProxyConfigOptions = {
  clientId?: NetworkClientId;
  brokerId?: BrokerNetworkTarget;
};

type NetworkClientConfig = {
  id: NetworkClientId;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  wsProxy?: string;
  wssProxy?: string;
};

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getNetworkClientConfig(clientId: NetworkClientId): NetworkClientConfig {
  const clientUrl = firstNonEmpty(
    process.env[`PLATFORM_CLIENT_${clientId.toUpperCase()}_URL` as keyof NodeJS.ProcessEnv] as string | undefined,
    getDefaultClientUrl(clientId),
  );

  if (clientId === 'direct') {
    return { id: clientId };
  }

  const wsProxy = firstNonEmpty(
    process.env[`PLATFORM_CLIENT_${clientId.toUpperCase()}_WS_URL` as keyof NodeJS.ProcessEnv] as string | undefined,
    clientUrl,
  );
  const wssProxy = firstNonEmpty(
    process.env[`PLATFORM_CLIENT_${clientId.toUpperCase()}_WSS_URL` as keyof NodeJS.ProcessEnv] as string | undefined,
    clientUrl,
  );

  return {
    id: clientId,
    httpProxy: clientUrl,
    httpsProxy: clientUrl,
    socksProxy: clientUrl,
    wsProxy,
    wssProxy,
  };
}

export function getPreferredNetworkClientId(brokerId: BrokerNetworkTarget = 'default'): NetworkClientId {
  const savedRoute = getSavedRoute(brokerId);
  if (savedRoute) {
    return savedRoute;
  }

  const configured = (process.env[`PLATFORM_CLIENT_ROUTE_${brokerId.toUpperCase()}` as keyof NodeJS.ProcessEnv] as string | undefined)?.trim().toLowerCase();
  if (configured === 'auto' || configured === 'jp' || configured === 'sg' || configured === 'us' || configured === 'hk' || configured === 'direct') {
    return configured;
  }

  return DEFAULT_CLIENT_ROUTES[brokerId] || DEFAULT_CLIENT_ROUTES.default;
}

function getLegacyProxyOptions(): NetworkClientConfig {
  const httpProxy = firstNonEmpty(process.env.PLATFORM_HTTP_PROXY, process.env.CCXT_HTTP_PROXY, process.env.HTTP_PROXY);
  const httpsProxy = firstNonEmpty(process.env.PLATFORM_HTTPS_PROXY, process.env.CCXT_HTTPS_PROXY, process.env.HTTPS_PROXY, httpProxy);
  const socksProxy = firstNonEmpty(process.env.PLATFORM_SOCKS_PROXY, process.env.CCXT_SOCKS_PROXY, process.env.ALL_PROXY);
  const wsProxy = firstNonEmpty(process.env.PLATFORM_WS_PROXY, process.env.CCXT_WS_PROXY, httpProxy, socksProxy);
  const wssProxy = firstNonEmpty(process.env.PLATFORM_WSS_PROXY, process.env.CCXT_WSS_PROXY, httpsProxy, socksProxy, wsProxy);

  return {
    id: 'auto',
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(socksProxy ? { socksProxy } : {}),
    ...(wsProxy ? { wsProxy } : {}),
    ...(wssProxy ? { wssProxy } : {}),
  };
}

export function getCcxtProxyOptions(options: ProxyConfigOptions = {}): CcxtProxyOptions {
  const preferredClientId = options.clientId || getPreferredNetworkClientId(options.brokerId || 'default');
  const clientConfig = getNetworkClientConfig(preferredClientId);
  const legacyConfig = getLegacyProxyOptions();

  const httpProxy = firstNonEmpty(clientConfig.httpProxy, legacyConfig.httpProxy);
  const httpsProxy = firstNonEmpty(clientConfig.httpsProxy, legacyConfig.httpsProxy, httpProxy);
  const socksProxy = firstNonEmpty(clientConfig.socksProxy, legacyConfig.socksProxy);
  const wsProxy = firstNonEmpty(clientConfig.wsProxy, legacyConfig.wsProxy, httpProxy, socksProxy);
  const wssProxy = firstNonEmpty(clientConfig.wssProxy, legacyConfig.wssProxy, httpsProxy, socksProxy, wsProxy);

  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(socksProxy ? { socksProxy } : {}),
    ...(wsProxy ? { wsProxy } : {}),
    ...(wssProxy ? { wssProxy } : {}),
  };
}

export function getResolvedNetworkClientSummary(brokerId: BrokerNetworkTarget = 'default') {
  const clientId = getPreferredNetworkClientId(brokerId);
  const config = getNetworkClientConfig(clientId);
  return {
    brokerId,
    clientId,
    httpProxy: config.httpProxy || null,
    httpsProxy: config.httpsProxy || null,
    socksProxy: config.socksProxy || null,
    wsProxy: config.wsProxy || null,
    wssProxy: config.wssProxy || null,
  };
}

export function getResolvedNetworkClientSummaries() {
  const routeIds = Array.from(new Set(['default', ...Object.keys(DEFAULT_CLIENT_ROUTES), ...getConfiguredRouteIds()]));
  return routeIds.map((brokerId) => getResolvedNetworkClientSummary(brokerId));
}
