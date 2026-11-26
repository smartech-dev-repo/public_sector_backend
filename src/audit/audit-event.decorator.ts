import { SetMetadata } from '@nestjs/common';

export const AUDIT_EVENT_KEY = 'auditEvent';

export interface AuditEventOptions {
  action: string;
  targetType?: string;
  /** Where the record's id comes from: a route param, the response, or the signed-in user. */
  targetId?: { param: string } | { result: string } | 'self';
  /** Allow-lists, so sensitive values such as a BVN can never reach the log by accident. */
  /** Skip repeats by the same person on the same record within this time, for automatic reloads. */
  repeatAfterMinutes?: number;
  params?: string[];
  body?: string[];
  result?: string[];
}

/** Records a named audit event when the route succeeds, and `<action>.failed` when a change is refused. */
export const AuditEvent = (options: AuditEventOptions) => SetMetadata(AUDIT_EVENT_KEY, options);
