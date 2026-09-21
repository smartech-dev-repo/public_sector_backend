export function toPeriodKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function generatePeriodRange(start: Date, end: Date): string[] {
  const periods: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endCursor = new Date(end.getFullYear(), end.getMonth(), 1);

  while (cursor <= endCursor) {
    periods.push(toPeriodKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return periods;
}
