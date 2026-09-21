import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { LoanRequestType } from '../generated/prisma/client';

describe('LoanRequestService', () => {
  let service: LoanRequestService;
  let prisma: {
    client: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    loanRequest: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    loanTermOption: { findUnique: jest.Mock };
    clientLoan: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
  };
  let eligibilityService: { check: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };
  let smsProvider: { send: jest.Mock };
  let expiryQueue: { add: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
      clientOnboarding: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      loanRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      loanTermOption: { findUnique: jest.fn() },
      clientLoan: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
    };
    eligibilityService = { check: jest.fn() };
    topupEligibilityService = { check: jest.fn() };
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
    );
  });

  describe('create', () => {
    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.create('c1', 1000, 6)).rejects.toThrow(ConflictException);
    });

    it('rejects when eligibility fails, without sending any SMS', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000 } });
      eligibilityService.check.mockResolvedValue({ eligible: false, reason: 'too much' });
      await expect(service.create('c1', 1000000, 6)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('sends the SMS, creates the request, and enqueues the expiry job on success', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 5000,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          managementChargeAmount: 100,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });

    it('rejects when there is no active loan term for the requested tenor', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue(null);

      await expect(service.create('c1', 5000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });
  });

  describe('resend', () => {
    it('rejects when the loan request does not belong to the calling client', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'other-client', status: 'PENDING' });
      await expect(service.resend('c1', 'lr1')).rejects.toThrow(NotFoundException);
    });

    it('rejects when the loan request is not PENDING', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'CONFIRMED' });
      await expect(service.resend('c1', 'lr1')).rejects.toThrow(ConflictException);
    });

    it('re-sends the SMS and updates confirmationSmsSentAt without touching expiresAt', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { confirmationSmsSentAt: expect.any(Date) },
      });
    });
  });

  describe('confirmByPhone', () => {
    it('ignores a reply that is not YES/1', async () => {
      await service.confirmByPhone('+2348000000000', 'maybe later');
      expect(prisma.client.findUnique).not.toHaveBeenCalled();
    });

    it('ignores when no client matches the phone', async () => {
      prisma.client.findUnique.mockResolvedValue(null);
      await service.confirmByPhone('+2348000000000', 'YES');
      expect(prisma.loanRequest.findFirst).not.toHaveBeenCalled();
    });

    it('ignores when the client has no PENDING loan request', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue(null);
      await service.confirmByPhone('+2348000000000', 'yes');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('confirms the most recent PENDING request for a matching YES reply', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', amount: 5000 });
      await service.confirmByPhone('+2348000000000', '1');
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'CONFIRMED', confirmedAt: expect.any(Date) },
      });
    });
  });

  describe('confirmByPhone with auto-approval', () => {
    it('auto-approves and auto-disburses when the amount is below the configured threshold', async () => {
      const configService = { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        configService,
      );
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.confirmByPhone('+2348000000000', 'YES');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', approvedAt: expect.any(Date), disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          loanRequestId: 'lr1',
          agency: 'NPF',
          staffId: 'NPF-001',
          principalAmount: 5000,
          disbursedAmount: 4900,
          principalBalance: 5000,
        }),
      });
    });

    it('leaves the request CONFIRMED when the amount is at or above the threshold', async () => {
      const configService = { get: jest.fn().mockReturnValue('1000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        configService,
      );
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });

      await service.confirmByPhone('+2348000000000', 'YES');

      expect(prisma.loanRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'CONFIRMED', confirmedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.approve('lr1')).rejects.toThrow(ConflictException);
    });

    it('moves a CONFIRMED request to APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });

      await service.approve('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
      });
    });
  });

  describe('reject', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.reject('lr1', 'not eligible')).rejects.toThrow(ConflictException);
    });

    it('moves a CONFIRMED request to REJECTED with a reason', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'REJECTED' });

      await service.reject('lr1', 'not eligible');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'REJECTED', rejectionReason: 'not eligible' },
      });
    });
  });

  describe('disburse', () => {
    it('throws ConflictException when the request is not APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await expect(service.disburse('lr1')).rejects.toThrow(ConflictException);
    });

    it('moves an APPROVED request to DISBURSED and creates a ClientLoan', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });

  describe('listAll', () => {
    it('filters by status when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      await service.listAll('CONFIRMED' as never);
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith({
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('exportDisbursementSummaryCsv', () => {
    it('throws BadRequestException for a malformed month', async () => {
      await expect(service.exportDisbursementSummaryCsv('not-a-month')).rejects.toThrow(BadRequestException);
    });

    it('builds a CSV with one row per ClientLoan disbursed in that month', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([
        {
          agency: 'NPF',
          principalAmount: 5000,
          disbursedAmount: 4900,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeAmount: 100,
          disbursementDate: new Date('2026-09-15T00:00:00.000Z'),
          client: { phone: '+2348000000000', onboarding: { employeeName: 'Jane Doe' } },
        },
      ]);

      const csv = await service.exportDisbursementSummaryCsv('2026-09');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith({
        where: { disbursementDate: { gte: new Date(2026, 8, 1), lt: new Date(2026, 9, 1) } },
        include: { client: { include: { onboarding: true } } },
        orderBy: { disbursementDate: 'asc' },
      });
      expect(csv).toContain('clientPhone,clientName,agency,principalAmount,disbursedAmount,tenorMonths,interestRatePercent,managementChargeAmount,disbursementDate');
      expect(csv).toContain('+2348000000000,Jane Doe,NPF,5000,4900,6,5,100,2026-09-15T00:00:00.000Z');
    });
  });

  describe('createTopup', () => {
    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.createTopup('c1', 2000, 12)).rejects.toThrow(ConflictException);
    });

    it('rejects when topup eligibility fails, without sending any SMS', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Client has no active loan to top up' });

      await expect(service.createTopup('c1', 2000, 12)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('rejects when there is no active loan term for the requested tenor', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue(null);

      await expect(service.createTopup('c1', 2000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the active loan', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.clientLoan.findFirstOrThrow.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('top-up'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 2000,
          tenorMonths: 12,
          type: 'TOPUP',
          topupTargetId: 'cl1',
          managementChargeAmount: 40,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr2' }, { delay: 24 * 60 * 60 * 1000 });
    });
  });

  describe('disburse with a TOPUP request', () => {
    it('updates the existing ClientLoan and extends maturity when the topup tenor pushes it further out', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 2000,
        tenorMonths: 12,
        managementChargeAmount: 40,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      const nearFutureMaturity = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      prisma.clientLoan.findUniqueOrThrow.mockResolvedValue({
        id: 'cl1',
        principalAmount: 5000,
        principalBalance: 4000,
        disbursedAmount: 4900,
        maturationDate: nearFutureMaturity,
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 7000,
          principalBalance: 6000,
          disbursedAmount: 6860,
        }),
      });
      const call = (prisma.clientLoan.update.mock.calls[0] as [{ data: { maturationDate: Date } }])[0];
      expect(call.data.maturationDate.getTime()).toBeGreaterThan(nearFutureMaturity.getTime());
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });

    it('keeps the existing maturationDate when the topup tenor does not extend beyond it', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 1000,
        tenorMonths: 1,
        managementChargeAmount: 20,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      });
      const veryFarFutureMaturity = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5);
      prisma.clientLoan.findUniqueOrThrow.mockResolvedValue({
        id: 'cl1',
        principalAmount: 5000,
        principalBalance: 4000,
        disbursedAmount: 5000,
        maturationDate: veryFarFutureMaturity,
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 6000,
          principalBalance: 5000,
          disbursedAmount: 6000,
          maturationDate: veryFarFutureMaturity,
        }),
      });
    });
  });

  describe('listAll with a type filter', () => {
    it('filters by type when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      await service.listAll(undefined, 'TOPUP' as never);
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith({
        where: { status: undefined, type: 'TOPUP' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('expire', () => {
    it('does nothing if the loan request no longer exists', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await service.expire('lr1');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('does nothing if the loan request already resolved (the confirm-vs-expiry race)', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await service.expire('lr1');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('marks a still-PENDING request FAILED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await service.expire('lr1');
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'FAILED' },
      });
    });
  });
});
