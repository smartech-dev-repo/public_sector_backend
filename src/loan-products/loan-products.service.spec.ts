import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';

describe('LoanProductsService', () => {
  let prisma: {
    loanProduct: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
  };
  let loanSettingsService: { get: jest.Mock };
  let service: LoanProductsService;

  const validInput = {
    productName: 'Standard Loan',
    productCode: 'STD-001',
    sectors: ['NPF'],
    minimumAmount: 1000,
    maximumAmount: 500000,
    minimumTenorMonths: 1,
    maximumTenorMonths: 12,
    interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
    managementChargeType: 'PERCENTAGE' as const,
    managementChargeValue: 2,
    managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT' as const,
  };

  beforeEach(() => {
    prisma = {
      loanProduct: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
    };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    service = new LoanProductsService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
    );
  });

  describe('create', () => {
    it('creates a product when the tiers are valid', async () => {
      prisma.loanProduct.create.mockResolvedValue({ id: 'p1', ...validInput });
      const result = await service.create(validInput);
      expect(result.id).toBe('p1');
    });

    it('rejects invalid tiers before ever touching the database', async () => {
      await expect(
        service.create({
          ...validInput,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 5 }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.loanProduct.create).not.toHaveBeenCalled();
    });

    it('converts a duplicate productCode P2002 error into a 409', async () => {
      prisma.loanProduct.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(validInput)).rejects.toThrow(ConflictException);
    });
  });

  describe('list', () => {
    it('filters by sectors and isActive', async () => {
      prisma.loanProduct.findMany.mockResolvedValue([]);
      prisma.loanProduct.count.mockResolvedValue(0);
      await service.list({ sectors: 'NPF', isActive: true }, { page: 1, limit: 25 });
      expect(prisma.loanProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sectors: { has: 'NPF' }, isActive: true } }),
      );
    });
  });

  describe('update', () => {
    it('throws when the product does not exist', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { productName: 'New name' })).rejects.toThrow(NotFoundException);
    });

    it('revalidates interest tiers against the merged tenor range when only the range changes', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue({
        id: 'p1',
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      });
      await expect(service.update('p1', { maximumTenorMonths: 6 })).rejects.toThrow(BadRequestException);
    });

    it('persists a valid partial update', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue({
        id: 'p1',
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      });
      prisma.loanProduct.update.mockResolvedValue({ id: 'p1', isActive: false });
      const result = await service.update('p1', { isActive: false });
      expect(result.isActive).toBe(false);
    });
  });

  describe('listActiveForClient', () => {
    it('returns an empty page when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      const result = await service.listActiveForClient('c1');
      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('returns only products matching the agency and service-length eligibility', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
        { id: 'p2', minimumServiceMonthsLeft: 999, maximumMonthsInService: null },
      ]);
      const result = await service.listActiveForClient('c1');
      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
      expect(result.meta.total).toBe(1);
    });
  });
});
