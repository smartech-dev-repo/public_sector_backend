import { AsyncLocalStorage } from 'async_hooks';

export interface AuditRequestContext {
  ip?: string;
  userAgent?: string;
}

/** Holds the current request's origin so explicit audit events record it without each caller passing it. */
export const auditRequestContext = new AsyncLocalStorage<AuditRequestContext>();
