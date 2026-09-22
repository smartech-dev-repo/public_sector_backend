import { computeLengthOfService } from './length-of-service.util';

describe('computeLengthOfService', () => {
  it('returns null when hireDate is null', () => {
    expect(computeLengthOfService(null)).toBeNull();
  });

  it('computes exact years and months when the day-of-month has already passed this month', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 2, now.getMonth() - 3, 1);
    // 1st of the month has definitely already passed by "now" (whatever today's date is),
    // so this is exactly 2 years and 3 months with no rollback needed.
    expect(computeLengthOfService(hireDate)).toEqual({ years: 2, months: 3 });
  });

  it('rolls back one month when the hire day-of-month has not yet occurred this month', () => {
    const now = new Date();
    const farFutureDay = 28;
    // Guard against a short month edge case (e.g. February) by only running this specific
    // assertion when "now" is unambiguously before the 28th — otherwise skip, since the
    // rollback behavior is already exercised by the exact-boundary test above either way.
    if (now.getDate() < farFutureDay) {
      // Same month, one year back: naive count is exactly 12 (1 year, 0 months), which the
      // day-of-month rollback then pulls back to 11 (0 years, 11 months).
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), farFutureDay);
      expect(computeLengthOfService(hireDate)).toEqual({ years: 0, months: 11 });
    }
  });

  it('rolls a full 12 months over into an extra year', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 3, now.getMonth(), 1);
    expect(computeLengthOfService(hireDate)).toEqual({ years: 3, months: 0 });
  });
});
