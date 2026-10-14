import { BadRequestException } from '@nestjs/common';
import { validateInterestTiers } from './validate-interest-tiers.util';

describe('validateInterestTiers', () => {
  it('passes for non-overlapping tiers within range, gaps allowed', () => {
    expect(() =>
      validateInterestTiers(
        [
          { minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 },
          { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
          { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
        ],
        0,
        18,
      ),
    ).not.toThrow();
  });

  it('rejects an empty tiers array', () => {
    expect(() => validateInterestTiers([], 0, 18)).toThrow(BadRequestException);
  });

  it('rejects a tier that falls outside the product tenor range', () => {
    expect(() =>
      validateInterestTiers([{ minTenorMonths: 0, maxTenorMonths: 24, interestRatePercent: 3 }], 0, 18),
    ).toThrow(BadRequestException);
  });

  it('rejects overlapping tiers', () => {
    expect(() =>
      validateInterestTiers(
        [
          { minTenorMonths: 0, maxTenorMonths: 6, interestRatePercent: 3 },
          { minTenorMonths: 4, maxTenorMonths: 12, interestRatePercent: 5 },
        ],
        0,
        12,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a tier with minTenorMonths greater than maxTenorMonths', () => {
    expect(() =>
      validateInterestTiers([{ minTenorMonths: 10, maxTenorMonths: 5, interestRatePercent: 3 }], 0, 18),
    ).toThrow(BadRequestException);
  });
});
