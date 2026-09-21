import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditActorType, VarianceStatus } from '../generated/prisma/client';

describe('ClientLoanReconciliationService', () => {
  let service: ClientLoanReconciliationService;
  let prisma: {
    clientLoan: { findMany: jest.Mock; update: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    clientLoanRepaymentVariance: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
  };
  let walletService: { credit: jest.Mock };

  // Date-relative (not hardcoded) so this fixture never drifts into the past — computeClientLoanStatus
  // marks a loan DEFAULT once maturationDate has passed, so a fixed calendar date would eventually make
  // every "should be ACTIVE" test below wrongly expect DEFAULT once real time caught up to it.
  const now = new Date();
  const disbursementDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const maturationDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const period = `${disbursementDate.getFullYear()}-${String(disbursementDate.getMonth() + 1).padStart(2, '0')}`;

  const baseLoan = {
    id: 'cl-1',
    clientId: 'client-1',
    agency: 'NPF',
    staffId: 'NPF-001',
    principalAmount: 90000,
    interestRatePercent: 0,
    principalBalance: 90000,
    disbursementDate,
    maturationDate,
  };

  beforeEach(() => {
    prisma = {
      clientLoan: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn().mockResolvedValue([]) },
      clientLoanRepaymentVariance: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    walletService = { credit: jest.fn().mockResolvedValue(undefined) };
    service = new ClientLoanReconciliationService(
      prisma as unknown as PrismaService,
      walletService as unknown as WalletService,
    );
  });

  it('does nothing for a loan with no matching repayment data in its date range', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).not.toHaveBeenCalled();
  });

  it('skips a period that already has a ClientLoanRepaymentVariance row (write-once)', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 30000 },
    ]);
    prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue({ id: 'existing-row' });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).not.toHaveBeenCalled();
  });

  it('reduces the balance by the actual amount and does not credit the wallet on a MATCHED period', async () => {
    // baseLoan is a 2-month term (1 month ago -> 1 month from now, computed relative to whenever the
    // test runs) with a flat 90000 principal at 0% interest, so computeExpectedInstallment resolves to
    // 90000 / 2 = 45000 per period — the mocked repayment amount below must equal that for this to be
    // a true MATCHED case.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 45000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.MATCHED });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientLoanId: 'cl-1',
        period,
        expectedAmount: 45000,
        actualAmount: 45000,
        variance: 0,
        status: VarianceStatus.MATCHED,
      }),
    });
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 45000, status: 'ACTIVE' },
    });
  });

  it('reduces the balance by only the partial amount received on an UNDER_PAID period, with no wallet credit', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 10000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.UNDER_PAID });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actualAmount: 10000, status: VarianceStatus.UNDER_PAID }),
    });
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 80000, status: 'DEFAULT' },
    });
  });

  it('reduces the balance by only the expected amount and credits the excess to the wallet on an OVER_PAID period', async () => {
    // Expected installment is 45000 (see the MATCHED test above) — 50000 actual gives a 5000 excess.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 50000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.OVER_PAID });

    await service.reconcileAll();

    expect(walletService.credit).toHaveBeenCalledWith(
      'client-1',
      5000,
      expect.stringContaining('NPF'),
      { actorType: AuditActorType.SYSTEM },
    );
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 45000, status: 'ACTIVE' },
    });
  });

  it('leaves the balance unchanged on a NO_DEDUCTION_FOUND period', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);
    prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
    // No repayment record at all for this period is the normal "no deduction" case, but the loop only
    // ever considers periods that appear in loanRepaymentRecord — so exercise it via a period that does
    // appear, with amount 0 (a real-world "deduction attempted, zero collected" row).
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 0 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.NO_DEDUCTION_FOUND });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actualAmount: 0, status: VarianceStatus.NO_DEDUCTION_FOUND }),
    });
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 90000, status: 'DEFAULT' },
    });
  });

  it('derives status from the TRUE most recent variance row across all time, not just periods touched in this run', async () => {
    // Simulates a late-arriving upload for an OLD period, while a NEWER period was already
    // reconciled (and is UNDER_PAID) in a prior run.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 30000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.UNDER_PAID });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.findFirst).toHaveBeenCalledWith({
      where: { clientLoanId: 'cl-1' },
      orderBy: { period: 'desc' },
    });
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 60000, status: 'DEFAULT' },
    });
  });
});
