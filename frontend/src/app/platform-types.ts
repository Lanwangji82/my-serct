import type { RuntimeConfig, RuntimeOperations } from "../lib/platform-client";

export type StrategySummary = {
  id: string;
  name: string;
  description: string;
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
};

export type BacktestRunSummary = {
  id: string;
  strategyId: string;
  source?: string;
  completedAt: number;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    trades: number;
    endingEquity: number;
  };
};

export type AuditEventSummary = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type ConnectivityBroker = {
  brokerTarget: string;
  ok: boolean;
  error?: string;
  remoteTime?: number;
  latencyMs?: number;
  checkedAt?: number;
};

export type Connectivity = {
  proxy?: {
    configured: boolean;
    mode?: string;
    source?: string;
    activeProxy?: string;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string;
  };
  brokers?: ConnectivityBroker[];
  checkedAt?: number;
};

export type AppTab =
  | "intelligence"
  | "portfolio"
  | "dataCenter"
  | "backtesting"
  | "strategies"
  | "settings";

export type PlatformSnapshot = {
  user: { email: string; roles?: string[] } | null;
  brokers: Array<{
    brokerId: string;
    label: string;
    supportsMarketData: boolean;
    supportsExecution: boolean;
    targets: Array<{
      target: `${string}:${"sandbox" | "production"}`;
      mode: "sandbox" | "production";
      label: string;
    }>;
  }>;
  strategies: StrategySummary[];
  backtests: BacktestRunSummary[];
  auditEvents: AuditEventSummary[];
  connectivity: Connectivity | null;
  runtimeConfig: RuntimeConfig | null;
  runtimeOperations: RuntimeOperations | null;
  status: string;
  reload: (tab?: AppTab) => Promise<void>;
  mergeConnectivityBroker: (broker: ConnectivityBroker) => void;
  saveNetworkClients: (payload: RuntimeConfig["networkClients"]) => Promise<RuntimeConfig>;
  refreshRuntimeConnectivity: (forceRefresh?: boolean) => Promise<Connectivity | null>;
  refreshRuntimeOperations: (forceRefresh?: boolean) => Promise<RuntimeOperations | null>;
};
