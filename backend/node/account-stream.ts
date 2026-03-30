import crypto from 'node:crypto';
import { getCacheStore } from './cache-store';
import { getKafkaTopicMap, getMessageBus } from './message-bus';
import {
  fetchFundingBalancesCcxt,
  fetchFuturesBalancesCcxt,
  fetchFuturesPositionsCcxt,
  fetchOpenOrdersCcxt,
  fetchSpotAccountCcxt,
} from './ccxt-private-api';

type BinanceCredentials = {
  apiKey: string;
  apiSecret: string;
};

type AccountStreamPayload = {
  spotBalances: any[];
  futuresBalances: any[];
  fundingBalances: any[];
  futuresPositions: any[];
  spotOpenOrders: any[];
  futuresOpenOrders: any[];
  accountReady: boolean;
  accountError: string | null;
  updatedAt: number;
};

type Listener = (payload: AccountStreamPayload) => void;

class AccountStreamSession {
  private listeners = new Map<number, Listener>();
  private nextListenerId = 1;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cacheStore = getCacheStore();
  private readonly messageBus = getMessageBus();
  private latest: AccountStreamPayload = {
    spotBalances: [],
    futuresBalances: [],
    fundingBalances: [],
    futuresPositions: [],
    spotOpenOrders: [],
    futuresOpenOrders: [],
    accountReady: false,
    accountError: null,
    updatedAt: 0,
  };

  constructor(
    readonly token: string,
    private readonly credentials: BinanceCredentials,
  ) {}

  private getCacheKey() {
    return `account:${this.token}:snapshot`;
  }

  private async restoreCachedSnapshot() {
    const cached = await this.cacheStore.get<AccountStreamPayload>(this.getCacheKey());
    if (cached) {
      this.latest = cached;
    }
  }

  private emit(payload: AccountStreamPayload) {
    this.latest = payload;
    void this.cacheStore.set(this.getCacheKey(), payload, 60_000);
    const topics = getKafkaTopicMap();
    void this.messageBus.publish(topics.accountSnapshot, this.token, {
      token: this.token,
      ...payload,
    });
    this.listeners.forEach((listener) => listener(payload));
  }

  private async refresh() {
    const results = await Promise.allSettled([
      fetchSpotAccountCcxt(this.credentials),
      fetchFuturesBalancesCcxt(this.credentials),
      fetchFundingBalancesCcxt(this.credentials),
      fetchFuturesPositionsCcxt(this.credentials),
      fetchOpenOrdersCcxt('spot', this.credentials),
      fetchOpenOrdersCcxt('futures', this.credentials),
    ]);

    const [
      spotResult,
      futuresBalResult,
      fundingBalResult,
      futuresPosResult,
      spotOrdersResult,
      futuresOrdersResult,
    ] = results;

    const errorMessages = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : 'Failed to fetch')
      .filter(Boolean);

    this.emit({
      spotBalances: spotResult.status === 'fulfilled' ? spotResult.value : [],
      futuresBalances: futuresBalResult.status === 'fulfilled' ? futuresBalResult.value : [],
      fundingBalances: fundingBalResult.status === 'fulfilled' ? fundingBalResult.value : [],
      futuresPositions: futuresPosResult.status === 'fulfilled' ? futuresPosResult.value : [],
      spotOpenOrders: spotOrdersResult.status === 'fulfilled' ? spotOrdersResult.value : [],
      futuresOpenOrders: futuresOrdersResult.status === 'fulfilled' ? futuresOrdersResult.value : [],
      accountReady: results.some((result) => result.status === 'fulfilled'),
      accountError: errorMessages.length > 0 ? errorMessages[0] : null,
      updatedAt: Date.now(),
    });
  }

  ensureStarted() {
    void this.restoreCachedSnapshot();
    void this.refresh();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.refresh();
      }, 15000);
    }
  }

  subscribe(listener: Listener) {
    this.ensureStarted();
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    listener(this.latest);
    return () => {
      this.listeners.delete(id);
    };
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}

const sessions = new Map<string, AccountStreamSession>();

export function createAccountStreamSession(credentials: BinanceCredentials) {
  const token = crypto.randomUUID();
  const session = new AccountStreamSession(token, credentials);
  sessions.set(token, session);
  return token;
}

export function getAccountStreamSession(token: string) {
  return sessions.get(token) || null;
}

export function closeAccountStreamSession(token: string) {
  const session = sessions.get(token);
  if (!session) return;
  session.stop();
  sessions.delete(token);
}
