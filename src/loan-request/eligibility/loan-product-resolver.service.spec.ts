import { UnprocessableEntityException } from '@nestjs/common';
import { LoanProductResolverService } from './loan-product-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoanSettingsService } from '../../loan-settings/loan-settings.service';
import { IppisRecord } from '../../generated/prisma/client';

describe('LoanProductResolverService', () => {
  let prisma: { loanProduct: { findMany: jest.Mock } };
  let loanSettingsService: { get: jest.Mock };
  let service: LoanProductResolverService;

  beforeEach(() => {
    prisma = { loanProduct: { findMany: jest.fn() } };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    service = new LoanProductResolverService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
    );
  });

  const ippisRecord = (overrides: Partial<IppisRecord> = {}): IppisRecord =>
    ({ agency: 'NPF', dateOfBirth: null, hireDate: null, ...overrides }) as IppisRecord;

  it('throws when there are zero structural matches', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([]);
    await expect(service.resolve(ippisRecord(), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('throws when a structural match is excluded by service-length eligibility', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: 24,
        maximumMonthsInService: null,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      },
    ]);
    const now = new Date();
    const dateOfBirth = new Date(now.getFullYear() - 59, now.getMonth(), now.getDate());
    await expect(service.resolve(ippisRecord({ dateOfBirth }), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('resolves the single eligible match and its matching tier', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: null,
        maximumMonthsInService: null,
        interestTiers: [
          { minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 },
          { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
        ],
      },
    ]);

    const result = await service.resolve(ippisRecord(), 5000, 6);

    expect(result.tier).toEqual({ minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 });
  });

  it('throws an ambiguous-configuration error when more than one product is eligible', async () => {
    const product = {
      minimumServiceMonthsLeft: null,
      maximumMonthsInService: null,
      interestTiers: [{ minTenorMonths: 0, maxTenorMonths: 12, interestRatePercent: 5 }],
    };
    prisma.loanProduct.findMany.mockResolvedValue([product, { ...product }]);
    await expect(service.resolve(ippisRecord(), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('throws when the eligible product has no tier covering the requested tenor (a tier gap)', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: null,
        maximumMonthsInService: null,
        interestTiers: [{ minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 }],
      },
    ]);
    await expect(service.resolve(ippisRecord(), 5000, 5)).rejects.toThrow(UnprocessableEntityException);
  });
});
