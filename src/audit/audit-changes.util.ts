export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

// Decimals and Dates compare and store by value; everything else is already JSON.
const comparable = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as object).toString === 'function') {
    const text = (value as object).toString();
    if (text !== '[object Object]') return text;
  }
  return value;
};

/** Lists the given fields whose value differs between two versions of a record. */
export function auditChanges<T extends object>(before: T, after: T, fields: (keyof T & string)[]): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of fields) {
    const from = comparable(before[field]);
    const to = comparable(after[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[field] = { from, to };
    }
  }
  return changes;
}
