import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LoanSettingsService } from '../../loan-settings/loan-settings.service';
import { IppisRecord, LoanProduct } from '../../generated/prisma/client';
import { computeServiceWindow } from './compute-service-window.util';
import { isServiceLengthEligible } from './service-length-eligible.util';
import { InterestTier } from '../../loan-products/interest-tier.interface';

export interface LoanProductMatch {
  product: LoanProduct;
  tier: InterestTier;
}

@Injectable()
export class LoanProductResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
  ) {}

  /**
   * Every product the client could take for this tenor, whatever the amount, each with its
   * interest band for the tenor. Used to find the largest amount their salary allows.
   */
  async candidatesForTenor(ippisRecord: IppisRecord, tenorMonths: number): Promise<LoanProductMatch[]> {
    const products = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: ippisRecord.agency },
        minimumTenorMonths: { lte: tenorMonths },
        maximumTenorMonths: { gte: tenorMonths },
      },
    });
    if (products.length === 0) return [];

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      ippisRecord.dateOfBirth,
      ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    return products
      .filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed))
      .map((product) => {
        const tiers = product.interestTiers as unknown as InterestTier[];
        const tier = tiers.find((t) => tenorMonths >= t.minTenorMonths && tenorMonths <= t.maxTenorMonths);
        return tier ? { product, tier } : null;
      })
      .filter((match): match is LoanProductMatch => match !== null);
  }

  async resolve(ippisRecord: IppisRecord, amount: number, tenorMonths: number): Promise<LoanProductMatch> {
    const structuralMatches = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: ippisRecord.agency },
        minimumAmount: { lte: amount },
        maximumAmount: { gte: amount },
        minimumTenorMonths: { lte: tenorMonths },
        maximumTenorMonths: { gte: tenorMonths },
      },
    });
    if (structuralMatches.length === 0) {
      throw new UnprocessableEntityException('No loan product matches this amount/tenor for your agency');
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      ippisRecord.dateOfBirth,
      ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const eligibleMatches = structuralMatches.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));
    if (eligibleMatches.length === 0) {
      throw new UnprocessableEntityException('Not eligible for any matching loan product based on service length');
    }
    if (eligibleMatches.length > 1) {
      throw new UnprocessableEntityException(
        'Multiple loan products match this request — ambiguous configuration, contact an admin',
      );
    }

    const product = eligibleMatches[0];
    const tiers = product.interestTiers as unknown as InterestTier[];
    const tier = tiers.find((t) => tenorMonths >= t.minTenorMonths && tenorMonths <= t.maxTenorMonths);
    if (!tier) {
      throw new UnprocessableEntityException(`No interest rate configured for ${tenorMonths} months under this product`);
    }

    return { product, tier };
  }
}
