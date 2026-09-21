import { toPeriodKey, generatePeriodRange } from './period.util';

describe('toPeriodKey', () => {
  it('formats a date as YYYY-MM, zero-padding single-digit months', () => {
    expect(toPeriodKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(toPeriodKey(new Date(2026, 10, 3))).toBe('2026-11');
  });
});

describe('generatePeriodRange', () => {
  it('returns a single period when start and end fall in the same month', () => {
    expect(generatePeriodRange(new Date(2026, 2, 1), new Date(2026, 2, 28))).toEqual(['2026-03']);
  });

  it('returns every month inclusive, spanning a year boundary', () => {
    expect(generatePeriodRange(new Date(2025, 10, 15), new Date(2026, 1, 1))).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('returns an empty array when end is before start', () => {
    expect(generatePeriodRange(new Date(2026, 5, 1), new Date(2026, 2, 1))).toEqual([]);
  });
});
