// src/loan-request/eligibility/service-length-eligible.util.spec.ts
import { isServiceLengthEligible } from './service-length-eligible.util';

describe('isServiceLengthEligible', () => {
  it('is eligible when both bounds are null regardless of months', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: null }, null, null)).toBe(
      true,
    );
  });

  it('rejects when minimumServiceMonthsLeft is set but monthsLeft is unknown', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, null, 100)).toBe(
      false,
    );
  });

  it('rejects when monthsLeft is below the minimum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, 6, 100)).toBe(
      false,
    );
  });

  it('accepts when monthsLeft meets the minimum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, 12, 100)).toBe(
      true,
    );
  });

  it('rejects when monthsServed exceeds the maximum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: 100 }, 12, 101)).toBe(
      false,
    );
  });

  it('accepts when monthsServed is within the maximum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: 100 }, 12, 100)).toBe(
      true,
    );
  });
});
