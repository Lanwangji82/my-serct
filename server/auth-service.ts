import crypto from 'node:crypto';
import { createId, readPlatformDb, replaceSessions, upsertUser } from './platform-store';
import type { PlatformRole, PlatformSession, PlatformUser } from './platform-types';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function hashPassword(password: string) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function ensureBootstrapUser() {
  const state = await readPlatformDb();
  if (state.users.length > 0) {
    return state.users[0];
  }

  const email = (process.env.AUTH_BOOTSTRAP_EMAIL || 'admin@quantx.local').trim().toLowerCase();
  const password = process.env.AUTH_BOOTSTRAP_PASSWORD || 'quantx-admin';
  const user: PlatformUser = {
    id: createId('user'),
    email,
    passwordHash: hashPassword(password),
    roles: ['admin', 'trader'],
    createdAt: Date.now(),
  };
  await upsertUser(user);
  return user;
}

export async function login(email: string, password: string) {
  await ensureBootstrapUser();
  const state = await readPlatformDb();
  const user = state.users.find((item) => item.email === email.trim().toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    throw new Error('Invalid email or password');
  }

  const nextSessions = state.sessions.filter((item) => item.expiresAt > Date.now());
  const session: PlatformSession = {
    token: createId('sess'),
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  nextSessions.push(session);
  await replaceSessions(nextSessions);
  return { session, user: sanitizeUser(user) };
}

export async function requireUser(token: string | undefined) {
  await ensureBootstrapUser();
  if (!token) {
    throw new Error('Missing session token');
  }
  const state = await readPlatformDb();
  const session = state.sessions.find((item) => item.token === token && item.expiresAt > Date.now());
  if (!session) {
    throw new Error('Session expired or invalid');
  }
  const user = state.users.find((item) => item.id === session.userId);
  if (!user) {
    throw new Error('User not found');
  }
  return sanitizeUser(user);
}

export function sanitizeUser(user: PlatformUser) {
  return {
    id: user.id,
    email: user.email,
    roles: user.roles,
    createdAt: user.createdAt,
  };
}

export function hasRole(user: { roles: PlatformRole[] }, role: PlatformRole) {
  return user.roles.includes(role) || user.roles.includes('admin');
}
