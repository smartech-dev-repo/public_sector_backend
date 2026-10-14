import { BadRequestException } from '@nestjs/common';
import { InterestTier } from './interest-tier.interface';

export function validateInterestTiers(
  tiers: InterestTier[],
  minimumTenorMonths: number,
  maximumTenorMonths: number,
): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new BadRequestException('interestTiers must be a non-empty array');
  }

  const sorted = [...tiers].sort((a, b) => a.minTenorMonths - b.minTenorMonths);

  for (const tier of sorted) {
    if (
      typeof tier.minTenorMonths !== 'number' ||
      typeof tier.maxTenorMonths !== 'number' ||
      typeof tier.interestRatePercent !== 'number' ||
      tier.minTenorMonths > tier.maxTenorMonths
    ) {
      throw new BadRequestException(
        'Each interest tier must have minTenorMonths <= maxTenorMonths and a numeric interestRatePercent',
      );
    }
    if (tier.minTenorMonths < minimumTenorMonths || tier.maxTenorMonths > maximumTenorMonths) {
      throw new BadRequestException(
        `Interest tier [${tier.minTenorMonths}-${tier.maxTenorMonths}] must fall within the product's tenor range [${minimumTenorMonths}-${maximumTenorMonths}]`,
      );
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minTenorMonths <= sorted[i - 1].maxTenorMonths) {
      throw new BadRequestException(
        `Interest tiers overlap: [${sorted[i - 1].minTenorMonths}-${sorted[i - 1].maxTenorMonths}] and [${sorted[i].minTenorMonths}-${sorted[i].maxTenorMonths}]`,
      );
    }
  }
}
