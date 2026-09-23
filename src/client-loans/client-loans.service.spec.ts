import { NotFoundException } from '@nestjs/common';
import { ClientLoansService } from './client-loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';

describe('ClientLoansService', () => {
  let service: ClientLoansService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock };
    loan: { findMany: jest.Mock; findFirst: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    repaymentVariance: { findMany: jest.Mock };
  };

  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn() },
      loan: { findMany: jest.fn(), findFirst: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
      repaymentVariance: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ClientLoansService(prisma as unknown as PrismaService);
  });

  describe('getDashboard', () => {
    it('returns empty lists when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getDashboard('c1');

      expect(result).toEqual({
        loans: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } },
        repayments: [],
      });
      expect(prisma.loan.findMany).not.toHaveBeenCalled();
      expect(prisma.loanRepaymentRecord.findMany).not.toHaveBeenCalled();
    });

    it('matches loans and repayments by the linked IppisRecord agency+staffId, tagging each loan with a status', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([{ id: 'rep-1' }]);

      const result = await service.getDashboard('c1');

      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: 'NPF', ippisNumber: 'NPF-001' }) }),
      );
      expect(prisma.loanRepaymentRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF', staffId: 'NPF-001' } }),
      );
      expect(result.loans.data).toEqual([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future, status: 'ACTIVE' },
      ]);
      expect(result.loans.meta).toEqual({ total: 1, page: 1, limit: 25, totalPages: 1 });
      expect(result.repayments).toEqual([{ id: 'rep-1' }]);
    });

    it('applies the bvn cross-check when the client has a verified bvn on file', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: '11111111111',
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-no-bvn', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-match', bvn: '11111111111', principalBalance: 5000, maturationDate: future },
        { id: 'loan-mismatch', bvn: '99999999999', principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual(['loan-no-bvn', 'loan-match']);
    });

    it('skips the bvn cross-check entirely when the client has no verified bvn on file', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: '22222222222', principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual(['loan-1']);
    });

    it('pushes product and disbursement date range filters into the loan query', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');
      await service.getDashboard('c1', { product: 'Salary Advance', disbursedFrom, disbursedTo });

      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            product: 'Salary Advance',
            disbursementDate: { gte: disbursedFrom, lte: disbursedTo },
          }),
        }),
      );
    });

    it('filters the computed status in memory using the most recent variance per loan', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-active', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-default', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);
      prisma.repaymentVariance.findMany.mockResolvedValue([
        { loanId: 'loan-default', period: '2026-02', status: VarianceStatus.UNDER_PAID },
        { loanId: 'loan-default', period: '2026-01', status: VarianceStatus.MATCHED },
      ]);

      const result = await service.getDashboard('c1', { status: 'DEFAULT' });

      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual(['loan-default']);
    });

    it('paginates the filtered loans array and reports the filtered total, not the raw findMany count', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-2', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-3', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1', {}, { page: 2, limit: 1 });

      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual(['loan-2']);
      expect(result.loans.meta).toEqual({ total: 3, page: 2, limit: 1, totalPages: 3 });
    });

    it('defaults to page 1, limit 25 when no pagination is passed', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.meta).toEqual({ total: 1, page: 1, limit: 25, totalPages: 1 });
    });
  });

  describe('getRepaymentPlan', () => {
    it('throws NotFoundException when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the loan does not match the client agency+staffId', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue(null);

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
      expect(prisma.loan.findFirst).toHaveBeenCalledWith({
        where: { id: 'loan-1', agency: 'NPF', ippisNumber: 'NPF-001' },
      });
    });

    it('throws NotFoundException when the loan fails the bvn cross-check', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: '11111111111',
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue({ id: 'loan-1', bvn: '99999999999' });

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
    });

    it('builds the full period range, overlaying actual variance data and marking unreconciled periods UPCOMING', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue({
        id: 'loan-1',
        bvn: null,
        loanAmount: 100000,
        interestRatePercent: 12,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 2, 1),
      });
      prisma.repaymentVariance.findMany.mockResolvedValue([
        { period: '2026-01', actualAmount: 34000, variance: 0, status: VarianceStatus.MATCHED },
      ]);

      const result = await service.getRepaymentPlan('c1', 'loan-1');

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith({ where: { loanId: 'loan-1' } });
      expect(result.loanId).toBe('loan-1');
      expect(result.schedule.map((row: { period: string }) => row.period)).toEqual(['2026-01', '2026-02', '2026-03']);
      expect(result.schedule[0]).toEqual(
        expect.objectContaining({ period: '2026-01', actualAmount: 34000, variance: 0, status: VarianceStatus.MATCHED }),
      );
      expect(result.schedule[1]).toEqual(
        expect.objectContaining({ period: '2026-02', actualAmount: null, variance: null, status: 'UPCOMING' }),
      );
      expect(result.schedule.every((row: { expectedAmount: number }) => row.expectedAmount === result.schedule[0].expectedAmount)).toBe(true);
    });
  });
});
