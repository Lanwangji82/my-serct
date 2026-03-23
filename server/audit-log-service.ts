import { appendAuditEvent, createId, listAuditEvents } from './platform-store';
import type { AuditEvent } from './platform-types';

export async function writeAuditEvent(input: Omit<AuditEvent, 'id' | 'createdAt'> & { createdAt?: number }) {
  const event: AuditEvent = {
    id: createId('audit'),
    createdAt: input.createdAt || Date.now(),
    actorUserId: input.actorUserId,
    type: input.type,
    payload: input.payload,
  };
  await appendAuditEvent(event);
  return event;
}

export async function getAuditTrail(userId?: string) {
  return listAuditEvents(userId);
}
