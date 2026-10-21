import { Client, IppisRecord } from '../generated/prisma/client';
import { ClientLoanSummaryService } from './client-loan-summary.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';

describe('ClientLoanSummaryService', () => {
  let service: ClientLoanSummaryService;
  let prisma: {
    clientLoan: { findFirst: jest.Mock };
    clientLoanRepaymentVariance: { findFirst: jest.Mock };
    repaymentVariance: { findFirst: jest.Mock };
  };
  let loanRequestService: { getMyLoan: jest.Mock };
  let clientLoansService: { getLatestMatchedLoan: jest.Mock; getRepaymentPlan: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientLoan: { findFirst: jest.fn() },
      clientLoanRepaymentVariance: { findFirst: jest.fn() },
      repaymentVariance: { findFirst: jest.fn() },
    };
    loanRequestService = { getMyLoan: jest.fn() };
    clientLoansService = { getLatestMatchedLoan: jest.fn(), getRepaymentPlan: jest.fn() };
    topupEligibilityService = { check: jest.fn() };

    service = new ClientLoanSummaryService(
      prisma as unknown as PrismaService,
      loanRequestService as unknown as LoanRequestService,
      clientLoansService as unknown as ClientLoansService,
      topupEligibilityService as unknown as TopupEligibilityService,
    );
  });

  describe('getSummary', () => {
    it('returns the no-loan shape when the client has neither an app-native nor an ingested loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result).toEqual({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      });
    });

    it('prefers the app-native ClientLoan when both sources exist', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(clientLoansService.getLatestMatchedLoan).not.toHaveBeenCalled();
      expect(result).toEqual({
        hasLoan: true,
        source: 'APP',
        status: 'ACTIVE',
        principal: 90000,
        balance: 60000,
        monthlyRepayment: 18000,
        nextPaymentDate: '2026-01-01',
      });
    });

    it('falls back to the latest matched ingested loan when there is no ClientLoan row', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue({
        id: 'loan-1',
        loanAmount: 100000,
        principalBalance: 50000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 4, 1),
        status: 'ACTIVE',
      });
      prisma.repaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result).toEqual({
        hasLoan: true,
        source: 'INGESTED',
        status: 'ACTIVE',
        principal: 100000,
        balance: 50000,
        monthlyRepayment: 25000,
        nextPaymentDate: '2026-01-01',
      });
    });

    it('treats "outstanding" and "balance" as the same field (principalBalance)', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 30000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result.balance).toBe(30000);
    });

    it('does not query for a next payment date once the app loan is CLOSED', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 0,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'CLOSED',
      });

      const result = await service.getSummary('c1');

      expect(prisma.clientLoanRepaymentVariance.findFirst).not.toHaveBeenCalled();
      expect(result.nextPaymentDate).toBeNull();
    });

    it('advances nextPaymentDate past an already-reconciled period', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ period: '2026-02' });

      const result = await service.getSummary('c1');

      expect(prisma.clientLoanRepaymentVariance.findFirst).toHaveBeenCalledWith({
        where: { clientLoanId: 'cl1' },
        orderBy: { period: 'desc' },
      });
      expect(result.nextPaymentDate).toBe('2026-03-01');
    });
  });

  describe('getSchedule', () => {
    it('delegates to LoanRequestService.getMyLoan for an app-native loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      loanRequestService.getMyLoan.mockResolvedValue({ id: 'cl1', schedule: [{ period: '2026-01' }] });

      const result = await service.getSchedule('c1');

      expect(loanRequestService.getMyLoan).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ period: '2026-01' }]);
    });

    it('delegates to ClientLoansService.getRepaymentPlan for an ingested-only loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue({ id: 'loan-1' });
      clientLoansService.getRepaymentPlan.mockResolvedValue({ loanId: 'loan-1', schedule: [{ period: '2026-02' }] });

      const result = await service.getSchedule('c1');

      expect(clientLoansService.getRepaymentPlan).toHaveBeenCalledWith('c1', 'loan-1');
      expect(result).toEqual([{ period: '2026-02' }]);
    });

    it('returns null when the client has no loan at all', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);

      expect(await service.getSchedule('c1')).toBeNull();
    });
  });

  describe('getTopupEligibility', () => {
    it('short-circuits to ineligible when the client has no onboarding record', async () => {
      const result = await service.getTopupEligibility({ id: 'c1' } as unknown as Client, null);

      expect(topupEligibilityService.check).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: false, reason: 'Client has not completed onboarding' });
    });

    it('delegates to TopupEligibilityService when onboarding exists', async () => {
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      const client = { id: 'c1' } as unknown as Client;
      const onboarding = { ippisRecord: { agency: 'NPF', staffId: 'S1' } as IppisRecord };

      const result = await service.getTopupEligibility(client, onboarding);

      expect(topupEligibilityService.check).toHaveBeenCalledWith(client, onboarding.ippisRecord, 0);
      expect(result).toEqual({ eligible: true });
    });
  });
});
