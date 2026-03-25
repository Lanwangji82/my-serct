export type StrategyArtifactSummary = {
  rootDir: string;
  sourceFile: string;
  latestSourceFile: string;
  metadataFile: string;
  latestMetadataFile: string;
  version: number;
};

export type PlatformStrategy = {
  id?: string;
  name: string;
  description: string;
  createdAt?: number;
  updatedAt?: number;
  marketType: "spot" | "futures";
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
  parameters: Record<string, number>;
  risk: {
    maxNotional: number;
    maxLeverage: number;
    maxDailyLoss: number;
    allowedSymbols: string[];
  };
  sourceCode?: string | null;
  compiler?: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    checkedAt?: number;
  } | null;
  artifactSummary?: StrategyArtifactSummary | null;
};

export type MarketEvent = {
  id?: string;
  label: string;
  marker?: string;
  action?: string;
  symbol?: string;
  averagePrice?: number;
  price: number;
  quantity: number;
  fee?: number;
  pnl?: number;
  status?: string;
  time?: number;
  completedAt?: number;
  message?: string;
};

export type MarketRow = {
  time: number;
  lastPrice: number;
  equity: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  openInterest?: number;
  utilization?: number;
  longAmount?: number;
  longPrice?: number;
  longProfit?: number;
  shortAmount?: number;
  shortPrice?: number;
  shortProfit?: number;
  events?: MarketEvent[];
};

export type BacktestTrade = {
  id?: string;
  time: number;
  side: string;
  action?: string;
  eventCode?: string;
  label?: string;
  marker?: string;
  positionSide?: string;
  symbol?: string;
  message?: string;
  price: number;
  marketPrice?: number;
  quantity: number;
  fee?: number;
  pnl?: number;
  lastPrice?: number;
  equity?: number;
  beforePosition?: { longAmount?: number; shortAmount?: number };
  afterPosition?: { longAmount?: number; shortAmount?: number };
};

export type BacktestLog = {
  time: number;
  level: string;
  message: string;
  progressPct?: number;
};

export type AssetRow = {
  name: string;
  asset: string;
  balance: number;
  frozen: number;
  fees: number;
  equity: number;
  realizedPnl: number;
  positionPnl: number;
  margin: number;
  estimatedProfit: number;
};

export type BacktestRun = {
  id: string;
  strategyId: string;
  source?: string;
  status?: "queued" | "running" | "completed" | "failed";
  progressPct?: number;
  queuedAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number | null;
  errorMessage?: string | null;
  params?: Record<string, unknown>;
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    winRatePct?: number;
    trades: number;
    endingEquity?: number;
  };
  equityCurve?: Array<{ time: number; equity: number }>;
  trades?: BacktestTrade[];
  marketRows?: MarketRow[];
  logs?: BacktestLog[];
  assetRows?: AssetRow[];
  summary?: {
    barCount?: number;
    orderCount?: number;
    dataSource?: string;
    startedAtText?: string;
    endedAtText?: string;
    durationMs?: number;
  };
  statusInfo?: {
    backtestStatus?: number;
    finished?: boolean;
    progress?: number;
    logsCount?: number;
    loadBytes?: number;
    loadElapsed?: number;
    elapsed?: number;
    lastPrice?: number;
    equity?: number;
    utilization?: number;
    longAmount?: number;
    shortAmount?: number;
    estimatedProfit?: number;
    tradeCount?: number;
  };
};

export type AuditEvent = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type ConnectivityStatus =
  | {
      proxy?: {
        configured: boolean;
        httpProxy?: string;
        httpsProxy?: string;
        socksProxy?: string;
        mode?: string;
        source?: string;
      };
      brokers?: Array<{
        brokerTarget: string;
        ok: boolean;
        latencyMs?: number;
        error?: string;
      }>;
    }
  | null;
