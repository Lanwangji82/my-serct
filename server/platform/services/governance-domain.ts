import { getAuditTrail, writeAuditEvent } from '../../audit-log-service';
import { listExchangeCredentialSummaries, saveExchangeCredential } from '../../secret-store';

export async function appendPlatformAuditEvent(event: Parameters<typeof writeAuditEvent>[0]) {
  return writeAuditEvent(event);
}

export async function listPlatformAuditTrail(userId: string) {
  return getAuditTrail(userId);
}

export async function savePlatformCredential(params: {
  userId: string;
  brokerTarget: any;
  label: string;
  apiKey: string;
  apiSecret: string;
}) {
  return saveExchangeCredential(params);
}

export async function listPlatformCredentialSummaries(userId: string) {
  return listExchangeCredentialSummaries(userId);
}
