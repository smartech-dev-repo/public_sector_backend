import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let prisma: {
    loan: { findMany: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    repaymentVariance: { upsert: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loan: { findMany: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
      repaymentVariance: { upsert: jest.fn().mockResolvedValue(undefined), findMany: jest.fn() },
    };
    service = new ReconciliationService(prisma as unknown as PrismaService);
  });

  describe('reconcileAll', () => {
    const baseLoan = {
      id: 'loan-1',
      agency: 'NPF',
      ippisNumber: 'NPF-001',
      loanAmount: 100000,
      interestRatePercent: 12,
      disbursementDate: new Date('2025-01-01'),
      maturationDate: new Date('2025-02-01'),
    };

    it('skips a loan with no agency', async () => {
      prisma.loan.findMany.mockResolvedValue([{ ...baseLoan, agency: null }]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).not.toHaveBeenCalled();
    });

    it('marks MATCHED when the actual amount is within the ₦1 tolerance of the expected installment', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 101000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { loanId_period: { loanId: 'loan-1', period: '2025-01' } },
          create: expect.objectContaining({
            status: VarianceStatus.MATCHED,
            expectedAmount: 101000,
            actualAmount: 101000,
            variance: 0,
          }),
        }),
      );
    });

    it('marks UNDER_PAID when the actual amount falls short beyond tolerance', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 50000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: VarianceStatus.UNDER_PAID }) }),
      );
    });

    it('marks OVER_PAID when the actual amount exceeds the expected installment beyond tolerance', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 150000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: VarianceStatus.OVER_PAID }) }),
      );
    });

    it('marks NO_DEDUCTION_FOUND for a period within the loan term that has no matching repayment rows', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'OTHER_AGENCY', staffId: 'X', period: '2025-01', amount: 999 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { loanId_period: { loanId: 'loan-1', period: '2025-01' } },
          create: expect.objectContaining({ status: VarianceStatus.NO_DEDUCTION_FOUND, actualAmount: 0 }),
        }),
      );
    });

    it("excludes periods outside the loan's disbursement-to-maturation range", async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2024-06', amount: 101000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('applies agency, status, and period filters', async () => {
      prisma.repaymentVariance.findMany.mockResolvedValue([]);

      await service.list({ agency: 'NPF', status: VarianceStatus.UNDER_PAID, period: '2025-01' });

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: VarianceStatus.UNDER_PAID, period: '2025-01', loan: { agency: 'NPF' } },
        }),
      );
    });
  });
});
