// src/loan-request/eligibility/compute-service-window.util.ts
export interface ServiceWindow {
  monthsLeft: number | null;
  monthsServed: number | null;
}

export function computeServiceWindow(
  dateOfBirth: Date | null,
  hireDate: Date | null,
  retirementAgeYears: number,
  maxServiceYears: number,
): ServiceWindow {
  const now = new Date();
  const byAge = dateOfBirth ? addYears(dateOfBirth, retirementAgeYears) : null;
  const byService = hireDate ? addYears(hireDate, maxServiceYears) : null;
  const candidates = [byAge, byService].filter((d): d is Date => d !== null);
  const retirementDate =
    candidates.length > 0 ? candidates.reduce((earliest, d) => (d < earliest ? d : earliest)) : null;

  return {
    monthsLeft: retirementDate ? monthsBetween(now, retirementDate) : null,
    monthsServed: hireDate ? monthsBetween(hireDate, now) : null,
  };
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
