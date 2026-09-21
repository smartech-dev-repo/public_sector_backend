import { NotFoundException } from '@nestjs/common';
import { LoanTermOptionService } from './loan-terms.service';
import { PrismaService } from '../prisma/prisma.service';
import { ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

describe('LoanTermOptionService', () => {
  let service: LoanTermOptionService;
  let prisma: {
    loanTermOption: { create: jest.Mock; findMany: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loanTermOption: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
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
    it('filters by agency when provided', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      await service.list('NPF');
      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: 'NPF' } });
    });

    it('lists everything when no agency is given', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: undefined } });
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
