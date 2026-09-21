import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';

describe('LoanRequestService', () => {
  let service: LoanRequestService;
  let prisma: {
    client: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
    loanRequest: { create: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    loanTermOption: { findUnique: jest.Mock };
  };
  let eligibilityService: { check: jest.Mock };
  let smsProvider: { send: jest.Mock };
  let expiryQueue: { add: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
      loanRequest: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
      loanTermOption: { findUnique: jest.fn() },
    };
    eligibilityService = { check: jest.fn() };
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
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
      await service.confirmByPhone('+2348000000000', '1');
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'CONFIRMED', confirmedAt: expect.any(Date) },
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
