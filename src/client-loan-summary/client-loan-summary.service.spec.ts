import { Client, IppisRecord } from '../generated/prisma/client';
import { ClientLoanSummaryService } from './client-loan-summary.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { EligibilityService } from '../loan-request/eligibility/eligibility.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';

describe('ClientLoanSummaryService', () => {
  let service: ClientLoanSummaryService;
  let prisma: {
    clientLoan: { findFirst: jest.Mock };
    clientLoanRepaymentVariance: { findFirst: jest.Mock };
    repaymentVariance: { findFirst: jest.Mock };
    loanRequest: { findFirst: jest.Mock };
  };
  let loanRequestService: { getMyLoan: jest.Mock };
  let clientLoansService: { getLatestMatchedLoan: jest.Mock; getRepaymentPlan: jest.Mock };
  let eligibilityService: { check: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientLoan: { findFirst: jest.fn() },
      clientLoanRepaymentVariance: { findFirst: jest.fn() },
      repaymentVariance: { findFirst: jest.fn() },
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    loanRequestService = { getMyLoan: jest.fn() };
    clientLoansService = { getLatestMatchedLoan: jest.fn(), getRepaymentPlan: jest.fn() };
    eligibilityService = { check: jest.fn() };
    topupEligibilityService = { check: jest.fn() };

    service = new ClientLoanSummaryService(
      prisma as unknown as PrismaService,
      loanRequestService as unknown as LoanRequestService,
      clientLoansService as unknown as ClientLoansService,
      eligibilityService as unknown as EligibilityService,
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
        tenorMonths: null,
        interestRatePercent: null,
      });
    });

    it('reflects a PENDING loan request when there is no ClientLoan or ingested loan yet', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);
      prisma.loanRequest.findFirst.mockResolvedValue({
        id: 'lr1',
        status: 'PENDING',
        amount: 50000,
        tenorMonths: 6,
        interestRatePercent: 5,
      });

      const result = await service.getSummary('c1');

      expect(prisma.loanRequest.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', status: { in: ['PENDING', 'CONFIRMED', 'APPROVED'] } },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual({
        hasLoan: false,
        source: 'REQUEST',
        status: 'PENDING',
        principal: 50000,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
        tenorMonths: 6,
        interestRatePercent: 5,
      });
    });

    it('reflects an APPROVED (not yet disbursed) loan request the same way', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);
      prisma.loanRequest.findFirst.mockResolvedValue({
        id: 'lr2',
        status: 'APPROVED',
        amount: 75000,
        tenorMonths: 12,
        interestRatePercent: 6,
      });

      const result = await service.getSummary('c1');

      expect(result.status).toBe('APPROVED');
      expect(result.hasLoan).toBe(false);
    });

    it('falls back to the no-loan shape when the only loan request is REJECTED/FAILED (terminal)', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);
      prisma.loanRequest.findFirst.mockResolvedValue(null); // the where clause already excludes terminal statuses

      const result = await service.getSummary('c1');

      expect(result.hasLoan).toBe(false);
      expect(result.source).toBeNull();
      expect(result.status).toBeNull();
    });

    it('prefers the app-native ClientLoan when both sources exist', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        tenorMonths: 6,
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
        tenorMonths: 6,
        interestRatePercent: 0,
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
        tenorMonths: 4,
        interestRatePercent: 0,
      });
    });

    it('derives tenorMonths for an ingested loan from disbursementDate/maturationDate (no stored tenor column)', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue({
        id: 'loan-2',
        loanAmount: 60000,
        principalBalance: 60000,
        interestRatePercent: 5,
        disbursementDate: new Date(2025, 10, 1),
        maturationDate: new Date(2026, 1, 1),
        status: 'ACTIVE',
      });
      prisma.repaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result.tenorMonths).toBe(3);
      expect(result.interestRatePercent).toBe(5);
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
      prisma.loanRequest.findFirst.mockResolvedValue(null);

      expect(await service.getSchedule('c1')).toBeNull();
    });

    it('returns a projected schedule for a non-terminal loan request when there is no real loan yet', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);
      prisma.loanRequest.findFirst.mockResolvedValue({
        id: 'lr1',
        status: 'PENDING',
        amount: 90000,
        tenorMonths: 3,
        interestRatePercent: 5,
      });

      const result = await service.getSchedule('c1');

      expect(prisma.loanRequest.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', status: { in: ['PENDING', 'CONFIRMED', 'APPROVED'] } },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(4);
      expect(result![0]).toEqual(expect.objectContaining({ actualAmount: null, variance: null, status: 'UPCOMING' }));
    });
  });

  describe('getLoanEligibility', () => {
    it('short-circuits to ineligible when the client has no onboarding record', async () => {
      const result = await service.getLoanEligibility({ id: 'c1' } as unknown as Client, null, false);

      expect(eligibilityService.check).not.toHaveBeenCalled();
      expect(topupEligibilityService.check).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: false, reason: 'Client has not completed onboarding' });
    });

    it('delegates to EligibilityService (new-loan check) when the client has no loan yet', async () => {
      eligibilityService.check.mockResolvedValue({ eligible: true });
      const client = { id: 'c1' } as unknown as Client;
      const onboarding = { ippisRecord: { agency: 'NPF', staffId: 'S1' } as IppisRecord };

      const result = await service.getLoanEligibility(client, onboarding, false);

      expect(eligibilityService.check).toHaveBeenCalledWith(client, onboarding.ippisRecord, 0);
      expect(topupEligibilityService.check).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: true });
    });

    it('delegates to TopupEligibilityService (renewal check) when the client already has a loan', async () => {
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      const client = { id: 'c1' } as unknown as Client;
      const onboarding = { ippisRecord: { agency: 'NPF', staffId: 'S1' } as IppisRecord };

      const result = await service.getLoanEligibility(client, onboarding, true);

      expect(topupEligibilityService.check).toHaveBeenCalledWith(client, onboarding.ippisRecord, 0);
      expect(eligibilityService.check).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: true });
    });
  });
});
