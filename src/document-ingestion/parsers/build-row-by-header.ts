export function buildRowByHeader(headerValues: unknown[], rowValues: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  headerValues.forEach((header, index) => {
    if (typeof header !== 'string' || !header.trim()) return;
    result[header.trim().toLowerCase()] = rowValues[index];
  });
  return result;
}
