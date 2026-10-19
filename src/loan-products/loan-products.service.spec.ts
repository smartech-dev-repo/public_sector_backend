import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { EligibilityService } from '../loan-request/eligibility/eligibility.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { ClientLoansService } from '../client-loans/client-loans.service';

describe('LoanProductsService', () => {
  let prisma: {
    loanProduct: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock };
    clientLoan: { findFirst: jest.Mock };
  };
  let loanSettingsService: { get: jest.Mock };
  let eligibilityService: { check: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };
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
      client: { findUniqueOrThrow: jest.fn() },
      clientLoan: { findFirst: jest.fn() },
    };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    eligibilityService = { check: jest.fn() };
    topupEligibilityService = { check: jest.fn() };
    clientLoansService = { hasAnyMatchedLoan: jest.fn().mockResolvedValue(false) };
    service = new LoanProductsService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
      eligibilityService as unknown as EligibilityService,
      topupEligibilityService as unknown as TopupEligibilityService,
      clientLoansService as unknown as ClientLoansService,
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

  describe('listEligibleForClient', () => {
    it('returns NEW_LOAN/ineligible when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.listEligibleForClient('c1');

      expect(result).toEqual({
        mode: 'NEW_LOAN',
        eligible: false,
        reason: 'Client has not completed onboarding',
        data: [],
        meta: { total: 0, page: 1, limit: 25, totalPages: 0 },
      });
      expect(prisma.loanProduct.findMany).not.toHaveBeenCalled();
    });

    it('resolves NEW_LOAN mode and returns matching products when the client has no lifetime loan and is eligible', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(eligibilityService.check).toHaveBeenCalledWith(
        { id: 'c1', status: 'VERIFIED' },
        { agency: 'NPF', dateOfBirth: null, hireDate: null },
        0,
      );
      expect(result.mode).toBe('NEW_LOAN');
      expect(result.eligible).toBe(true);
      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
    });

    it('returns NEW_LOAN/ineligible with the rule\'s reason and an empty product list when origination eligibility fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'PENDING' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Client must be VERIFIED (currently PENDING)' });

      const result = await service.listEligibleForClient('c1');

      expect(result.mode).toBe('NEW_LOAN');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Client must be VERIFIED (currently PENDING)');
      expect(result.data).toEqual([]);
      expect(prisma.loanProduct.findMany).not.toHaveBeenCalled();
    });

    it('resolves TOPUP mode when the client already has a ClientLoan row, and returns products when eligible', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(topupEligibilityService.check).toHaveBeenCalledWith(
        { id: 'c1', status: 'VERIFIED' },
        { agency: 'NPF', dateOfBirth: null, hireDate: null },
        0,
      );
      expect(eligibilityService.check).not.toHaveBeenCalled();
      expect(result.mode).toBe('TOPUP');
      expect(result.eligible).toBe(true);
    });

    it('returns TOPUP/ineligible with the rule\'s reason when renewal eligibility fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      topupEligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Existing loan still has an outstanding balance' });

      const result = await service.listEligibleForClient('c1');

      expect(result.mode).toBe('TOPUP');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Existing loan still has an outstanding balance');
      expect(result.data).toEqual([]);
    });

    it('narrows by the optional amount filter', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([]);

      await service.listEligibleForClient('c1', { amount: 50000 });

      expect(prisma.loanProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            minimumAmount: { lte: 50000 },
            maximumAmount: { gte: 50000 },
          }),
        }),
      );
    });

    it('only applies the service-length filter, still returning only matching products', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
        { id: 'p2', minimumServiceMonthsLeft: 999, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
      expect(result.meta.total).toBe(1);
    });
  });
});
