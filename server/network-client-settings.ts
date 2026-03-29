import fs from 'node:fs';
import path from 'node:path';

export type NetworkClientId = 'auto' | 'jp' | 'sg' | 'us' | 'hk' | 'direct';
export type BrokerNetworkTarget = string;

export const NETWORK_CLIENT_CATALOG: Array<{ clientId: NetworkClientId; label: string; defaultPort: number; kind: string }> = [
  { clientId: 'auto', label: '自动分流', defaultPort: 7890, kind: 'smart' },
  { clientId: 'jp', label: '日本', defaultPort: 7891, kind: 'regional' },
  { clientId: 'sg', label: '新加坡', defaultPort: 7892, kind: 'regional' },
  { clientId: 'us', label: '美国', defaultPort: 7893, kind: 'regional' },
  { clientId: 'hk', label: '香港', defaultPort: 7894, kind: 'regional' },
  { clientId: 'direct', label: '直连', defaultPort: 7895, kind: 'direct' },
];

type NetworkClientSettingsFile = {
  clients?: Partial<Record<NetworkClientId, { port?: number }>>;
  routes?: Record<string, NetworkClientId | undefined>;
  updatedAt?: number;
};

const NETWORK_CLIENT_SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'network-clients.json');

export const DEFAULT_CLIENT_PORTS: Record<NetworkClientId, number> = {
  auto: 7890,
  jp: 7891,
  sg: 7892,
  us: 7893,
  hk: 7894,
  direct: 7895,
};

export const DEFAULT_CLIENT_ROUTES: Record<BrokerNetworkTarget, NetworkClientId> = {
  default: 'auto',
  binance: 'jp',
  okx: 'auto',
};

export function readNetworkClientSettingsFile(): NetworkClientSettingsFile {
  try {
    if (!fs.existsSync(NETWORK_CLIENT_SETTINGS_PATH)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(NETWORK_CLIENT_SETTINGS_PATH, 'utf-8')) as NetworkClientSettingsFile;
  } catch {
    return {};
  }
}

export function getConfiguredClientPort(clientId: NetworkClientId) {
  const file = readNetworkClientSettingsFile();
  const candidate = file.clients?.[clientId]?.port;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) {
    return candidate;
  }
  return DEFAULT_CLIENT_PORTS[clientId];
}

export function getDefaultClientUrl(clientId: NetworkClientId) {
  return `http://127.0.0.1:${getConfiguredClientPort(clientId)}`;
}

export function getSavedRoute(brokerId: BrokerNetworkTarget) {
  const route = readNetworkClientSettingsFile().routes?.[brokerId];
  if (route === 'auto' || route === 'jp' || route === 'sg' || route === 'us' || route === 'hk' || route === 'direct') {
    return route;
  }
  return undefined;
}

export function getConfiguredRouteIds() {
  const routes = readNetworkClientSettingsFile().routes || {};
  return Object.keys(routes);
}
