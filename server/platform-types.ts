export type PlatformRole = 'admin' | 'trader' | 'viewer';
export type StrategyRuntime = 'backtest-only' | 'paper' | 'sandbox' | 'production';
export type ExchangeMarketType = 'spot' | 'futures';
export type BrokerId = 'paper' | 'binance' | 'okx' | 'bybit' | 'ibkr';
export type BrokerMode = 'paper' | 'sandbox' | 'production';
export type ActiveBrokerId = Exclude<BrokerId, 'paper'>;
export type ActiveBrokerTarget = `${ActiveBrokerId}:${Exclude<BrokerMode, 'paper'>}`;
export type BrokerTarget = 'paper' | ActiveBrokerTarget;

export interface PlatformUser {
  id: string;
  email: string;
  passwordHash: string;
  roles: PlatformRole[];
  createdAt: number;
}

export interface PlatformSession {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

export interface StoredExchangeCredential {
  id: string;
  userId: string;
  label: string;
  brokerId: ActiveBrokerId;
  brokerMode: Exclude<BrokerMode, 'paper'>;
  encryptedApiKey: string;
  encryptedApiSecret: string;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  marketType: ExchangeMarketType;
  symbol: string;
  interval: string;
  runtime: StrategyRuntime;
  template: 'smaCross' | 'breakout';
  parameters: Record<string, number>;
  risk: {
    maxNotional: number;
    maxLeverage: number;
    maxDailyLoss: number;
    allowedSymbols: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface BacktestTrade {
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  fee: number;
  pnl: number;
  reason: string;
}

export interface BacktestRun {
  id: string;
  strategyId: string;
  symbol: string;
  interval: string;
  marketType: ExchangeMarketType;
  startedAt: number;
  completedAt: number;
  source: string;
  params: {
    lookback: number;
    initialCapital: number;
    feeBps: number;
    slippageBps: number;
  };
  metrics: {
    totalReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    winRatePct: number;
    trades: number;
    endingEquity: number;
  };
  equityCurve: Array<{ time: number; equity: number }>;
  trades: BacktestTrade[];
}

export interface AuditEvent {
  id: string;
  type: 'auth.login' | 'secret.saved' | 'backtest.run' | 'execution.accepted' | 'execution.rejected' | 'execution.sent';
  actorUserId: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface PaperPosition {
  symbol: string;
  marketType: ExchangeMarketType;
  quantity: number;
  avgEntryPrice: number;
  updatedAt: number;
}

export interface PaperAccount {
  id: string;
  userId: string;
  balanceUsd: number;
  realizedPnl: number;
  positions: PaperPosition[];
  updatedAt: number;
}

export interface PlatformDatabase {
  users: PlatformUser[];
  sessions: PlatformSession[];
  credentials: StoredExchangeCredential[];
  strategies: StrategyDefinition[];
  backtests: BacktestRun[];
  auditEvents: AuditEvent[];
  paperAccounts: PaperAccount[];
}
