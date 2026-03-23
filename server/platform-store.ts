import crypto from 'node:crypto';
import { JsonFileDb } from './json-file-db';
import type {
  AuditEvent,
  BacktestRun,
  PaperAccount,
  PlatformDatabase,
  PlatformSession,
  PlatformUser,
  StoredExchangeCredential,
  StrategyDefinition,
} from './platform-types';

const db = new JsonFileDb<PlatformDatabase>('platform-db.json', {
  users: [],
  sessions: [],
  credentials: [],
  strategies: [],
  backtests: [],
  auditEvents: [],
  paperAccounts: [],
});

export function createId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export async function readPlatformDb() {
  return db.read();
}

export async function upsertUser(user: PlatformUser) {
  await db.update((state) => ({
    ...state,
    users: [...state.users.filter((item) => item.id !== user.id), user],
  }));
  return user;
}

export async function replaceSessions(sessions: PlatformSession[]) {
  await db.update((state) => ({ ...state, sessions }));
}

export async function listStrategies() {
  const state = await db.read();
  return state.strategies.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function upsertStrategy(strategy: StrategyDefinition) {
  await db.update((state) => ({
    ...state,
    strategies: [...state.strategies.filter((item) => item.id !== strategy.id), strategy],
  }));
  return strategy;
}

export async function getStrategy(strategyId: string) {
  const state = await db.read();
  return state.strategies.find((item) => item.id === strategyId) || null;
}

export async function saveCredential(credential: StoredExchangeCredential) {
  await db.update((state) => ({
    ...state,
    credentials: [
      ...state.credentials.filter((item) => item.id !== credential.id),
      credential,
    ],
  }));
  return credential;
}

export async function getCredential(userId: string, environment?: string) {
  const state = await db.read();
  const filtered = state.credentials.filter((item) => item.userId === userId);
  if (!environment) {
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }
  return filtered.find((item) => `${item.brokerId}:${item.brokerMode}` === environment) || null;
}

export async function listCredentials(userId: string) {
  const state = await db.read();
  return state.credentials
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function appendBacktest(run: BacktestRun) {
  await db.update((state) => ({
    ...state,
    backtests: [run, ...state.backtests].slice(0, 100),
  }));
  return run;
}

export async function listBacktests(strategyId?: string) {
  const state = await db.read();
  return state.backtests
    .filter((item) => !strategyId || item.strategyId === strategyId)
    .sort((a, b) => b.completedAt - a.completedAt);
}

export async function appendAuditEvent(event: AuditEvent) {
  await db.update((state) => ({
    ...state,
    auditEvents: [event, ...state.auditEvents].slice(0, 500),
  }));
  return event;
}

export async function listAuditEvents(userId?: string) {
  const state = await db.read();
  return state.auditEvents
    .filter((item) => !userId || item.actorUserId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function upsertPaperAccount(account: PaperAccount) {
  await db.update((state) => ({
    ...state,
    paperAccounts: [...state.paperAccounts.filter((item) => item.id !== account.id), account],
  }));
  return account;
}

export async function getPaperAccount(userId: string) {
  const state = await db.read();
  return state.paperAccounts.find((item) => item.userId === userId) || null;
}
