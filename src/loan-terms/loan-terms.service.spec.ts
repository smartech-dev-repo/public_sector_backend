import { NotFoundException } from '@nestjs/common';
import { LoanTermOptionService } from './loan-terms.service';
import { PrismaService } from '../prisma/prisma.service';
import { ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

describe('LoanTermOptionService', () => {
  let service: LoanTermOptionService;
  let prisma: {
    loanTermOption: { create: jest.Mock; findMany: jest.Mock; update: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loanTermOption: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
    };
    service = new LoanTermOptionService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('creates a term option with the given fields', async () => {
      prisma.loanTermOption.create.mockResolvedValue({ id: 'term-1' });

      await service.create({
        agency: 'NPF',
        tenorMonths: 6,
        interestRatePercent: 5,
        managementChargeType: ManagementChargeType.PERCENTAGE,
        managementChargeValue: 2,
        managementChargeApplication: ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT,
      });

      expect(prisma.loanTermOption.create).toHaveBeenCalledWith({
        data: {
          agency: 'NPF',
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: ManagementChargeType.PERCENTAGE,
          managementChargeValue: 2,
          managementChargeApplication: ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT,
        },
      });
    });
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: undefined, isActive: undefined }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency and isActive when provided', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(0);

      await service.list({ agency: 'NPF', isActive: true });

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF', isActive: true } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(5);

      const result = await service.list({}, { page: 1, limit: 2 });

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2 }));
      expect(result.meta).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the option does not exist', async () => {
      prisma.loanTermOption.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { isActive: false })).rejects.toThrow(NotFoundException);
    });

    it('updates the given fields', async () => {
      prisma.loanTermOption.findUnique.mockResolvedValue({ id: 'term-1' });
      prisma.loanTermOption.update.mockResolvedValue({ id: 'term-1', isActive: false });

      await service.update('term-1', { isActive: false });

      expect(prisma.loanTermOption.update).toHaveBeenCalledWith({
        where: { id: 'term-1' },
        data: { isActive: false },
      });
    });
  });

  describe('listActiveForClient', () => {
    it('returns an empty array when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      const result = await service.listActiveForClient('client-1');
      expect(result).toEqual([]);
      expect(prisma.loanTermOption.findMany).not.toHaveBeenCalled();
    });

    it('lists active options for the client\'s own agency', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      prisma.loanTermOption.findMany.mockResolvedValue([{ id: 'term-1' }]);

      const result = await service.listActiveForClient('client-1');

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: 'NPF', isActive: true } });
      expect(result).toEqual([{ id: 'term-1' }]);
    });
  });
});
