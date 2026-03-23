import crypto from 'node:crypto';
import { createId, getCredential, listCredentials, saveCredential } from './platform-store';
import type { BrokerTarget, StoredExchangeCredential } from './platform-types';
import { parseBrokerTarget } from './platform/broker-model';

const IV_LENGTH = 16;

function getKey() {
  const raw = process.env.SECRET_STORE_KEY || 'quantx-secret-store-key-32-bytes!';
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(value: string) {
  const [ivHex, payloadHex] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payloadHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export async function saveExchangeCredential(params: {
  userId: string;
  brokerTarget: Exclude<BrokerTarget, 'paper'>;
  label: string;
  apiKey: string;
  apiSecret: string;
}) {
  const target = parseBrokerTarget(params.brokerTarget);
  if (target.brokerId === 'paper' || target.brokerMode === 'paper') {
    throw new Error('Paper target does not support stored broker credentials');
  }
  const existing = await getCredential(params.userId, params.brokerTarget);
  const now = Date.now();
  const credential: StoredExchangeCredential = {
    id: existing?.id || createId('cred'),
    userId: params.userId,
    label: params.label,
    brokerId: target.brokerId,
    brokerMode: target.brokerMode,
    encryptedApiKey: encrypt(params.apiKey.trim()),
    encryptedApiSecret: encrypt(params.apiSecret.trim()),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await saveCredential(credential);
  return credential;
}

export async function resolveBrokerCredential(userId: string, brokerTarget: BrokerTarget) {
  const credential = await getCredential(userId, brokerTarget);
  if (!credential) {
    return null;
  }
  return {
    id: credential.id,
    label: credential.label,
    brokerTarget,
    apiKey: decrypt(credential.encryptedApiKey),
    apiSecret: decrypt(credential.encryptedApiSecret),
    updatedAt: credential.updatedAt,
  };
}

export async function listExchangeCredentialSummaries(userId: string) {
  const credentials = await listCredentials(userId);
  return credentials.map((item) => ({
    id: item.id,
    label: item.label,
    brokerTarget: `${item.brokerId}:${item.brokerMode}`,
    updatedAt: item.updatedAt,
  }));
}
