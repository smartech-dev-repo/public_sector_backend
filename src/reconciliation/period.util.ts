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

export function nextPeriodDate(latestPeriod: string | null, disbursementDate: Date, maturationDate: Date): string | null {
  const next = latestPeriod
    ? addMonthsToPeriod(latestPeriod, 1)
    : new Date(disbursementDate.getFullYear(), disbursementDate.getMonth(), 1);
  if (next > maturationDate) {
    return null;
  }
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function addMonthsToPeriod(period: string, months: number): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(year, month - 1 + months, 1);
}
