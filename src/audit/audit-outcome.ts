import { Prisma } from '../generated/prisma/client';

export type AuditOutcome = 'success' | 'failed' | 'blocked';

const BLOCKED_STATUSES = [401, 403, 429];
const FAILED_STATUSES = [400, 404, 405, 409, 410, 413, 415, 422, 500, 502, 503, 504];

const REASON_LABELS: Record<string, string> = {
  wrong_password: 'Wrong password',
  unknown_account: 'No account with this email',
  inactive_account: 'Account is deactivated',
  wrong_2fa_code: 'Wrong two-factor code',
  wrong_code: 'Wrong or expired code',
};

const STATUS_LABELS: Record<number, string> = {
  400: 'The request was not valid',
  401: 'Not signed in',
  403: 'Did not have permission',
  404: 'Record not found',
  409: 'Conflicted with existing data',
  422: 'Could not be processed',
  429: 'Too many attempts',
};

const endsWith = (suffix: string): Prisma.AuditLogWhereInput => ({ action: { endsWith: suffix } });

const BLOCKED_WHERE: Prisma.AuditLogWhereInput[] = [
  endsWith('.denied'),
  endsWith('.reuse_detected'),
  ...BLOCKED_STATUSES.map((status) => endsWith(` (${status})`)),
];
const FAILED_WHERE: Prisma.AuditLogWhereInput[] = [
  endsWith('.failed'),
  endsWith('_failed'),
  ...FAILED_STATUSES.map((status) => endsWith(` (${status})`)),
];

export function outcomeWhere(outcome: AuditOutcome): Prisma.AuditLogWhereInput {
  if (outcome === 'blocked') return { OR: BLOCKED_WHERE };
  if (outcome === 'failed') return { OR: FAILED_WHERE };
  return { NOT: { OR: [...BLOCKED_WHERE, ...FAILED_WHERE] } };
}

/** Works out how an entry ended, and why, from what was recorded, so older rows get a status too. */
export function describeOutcome(action: string, metadata: unknown): { outcome: AuditOutcome; reason: string | null } {
  const details = (metadata ?? {}) as { reason?: string; error?: string; status?: number };
  const requestStatus = Number(action.match(/\((\d{3})\)$/)?.[1]);

  let outcome: AuditOutcome = 'success';
  if (BLOCKED_STATUSES.includes(requestStatus) || /\.(denied|reuse_detected)$/.test(action)) {
    outcome = 'blocked';
  } else if (requestStatus >= 400 || /[._]failed$/.test(action)) {
    outcome = 'failed';
  }
  if (outcome === 'success') {
    return { outcome, reason: null };
  }

  const status = requestStatus || details.status;
  const reason =
    details.error ??
    (details.reason ? (REASON_LABELS[details.reason] ?? details.reason) : undefined) ??
    (action.endsWith('.client_access.denied') ? "Client belongs to another agent" : undefined) ??
    (action.endsWith('.reuse_detected') ? 'An old sign-in token was reused' : undefined) ??
    (action.endsWith('.change_failed') ? 'Wrong current password' : undefined) ??
    (status ? (STATUS_LABELS[status] ?? (status >= 500 ? 'Server error' : `Error ${status}`)) : null);
  return { outcome, reason };
}

/** The safe, readable part of a thrown error. Server errors stay generic, since their text may hold internals. */
export function errorReason(error: unknown): string | undefined {
  const failure = (error ?? {}) as { status?: number; response?: { message?: string | string[] }; message?: string };
  if (!failure.status || failure.status >= 500) return undefined;
  const message = failure.response?.message ?? failure.message;
  return Array.isArray(message) ? message.join('; ') : message;
}
