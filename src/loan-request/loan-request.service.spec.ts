import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../email/email.service';
import { LoanRequestType } from '../generated/prisma/client';
import { hashToken } from '../common/opaque-token.util';

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
      count: jest.Mock;
    };
    clientLoan: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      findFirstOrThrow: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    clientLoanRepaymentVariance: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
  };
  let eligibilityService: { check: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };
  let loanProductResolverService: { resolve: jest.Mock };
  let walletService: { debit: jest.Mock };
  let smsProvider: { send: jest.Mock };
  let emailService: { send: jest.Mock };
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
        count: jest.fn(),
      },
      clientLoan: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        findFirstOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      clientLoanRepaymentVariance: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    };
    eligibilityService = { check: jest.fn() };
    topupEligibilityService = { check: jest.fn() };
    loanProductResolverService = { resolve: jest.fn() };
    walletService = { debit: jest.fn() };
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
      loanProductResolverService as unknown as LoanProductResolverService,
      undefined,
      emailService as unknown as EmailService,
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
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
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
          confirmationCodeHash: expect.any(String),
          confirmationCodeExpiresAt: expect.any(Date),
        }),
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });

    it('also emails a confirmation copy when the client has an email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('5000') }),
      );
    });

    it('does not email when the client has no email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: null,
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('still creates the loan request when the email copy fails', async () => {
      emailService.send.mockRejectedValue(new Error('smtp down'));
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await expect(service.create('c1', 5000, 6)).resolves.toEqual({ id: 'lr1' });
    });

    it('rejects when the loan product resolver throws (no matching product for the requested tenor)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockRejectedValue(
        new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'),
      );

      await expect(service.create('c1', 5000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('includes a confirmation code hash/expiry on the created request and emails it when the client has an email', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          confirmationCodeHash: expect.any(String),
          confirmationCodeExpiresAt: expect.any(Date),
        }),
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', subject: 'Confirm your loan request' }),
      );
    });

    it('still creates the loan request, with devCode undefined, when the confirmation-code email fails', async () => {
      emailService.send.mockRejectedValue(new Error('smtp down'));
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await expect(service.create('c1', 5000, 6)).resolves.toEqual({ id: 'lr1' });
    });

    it('returns the real code as devCode when EMAIL_CODE_DEV_ECHO is enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => (key === 'EMAIL_CODE_DEV_ECHO' ? 'true' : undefined)),
      } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
        configService,
        emailService as unknown as EmailService,
      );
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      const result = await service.create('c1', 5000, 6);

      expect(result.devCode).toEqual(expect.stringMatching(/^\d{6}$/));
    });

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { salary: 1000000, agency: 'NPF', phone: '+2348099999999' },
      });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('5000'));
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
        data: {
          confirmationSmsSentAt: expect.any(Date),
          confirmationCodeHash: expect.any(String),
          confirmationCodeExpiresAt: expect.any(Date),
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
    });

    it('also emails a confirmation copy on resend when the client has an email on file', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', email: 'client@example.com' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('5000') }),
      );
    });

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '',
        onboarding: { ippisRecord: { phone: '+2348099999999' } },
      });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('5000'));
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
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
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
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
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

  describe('confirmByCode', () => {
    it('throws NotFoundException when the loan request does not belong to the calling client', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'other-client', status: 'PENDING' });
      await expect(service.confirmByCode('c1', 'lr1', '123456')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the loan request is not PENDING', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'CONFIRMED' });
      await expect(service.confirmByCode('c1', 'lr1', '123456')).rejects.toThrow(ConflictException);
    });

    it('throws UnauthorizedException when the code does not match the stored hash', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        status: 'PENDING',
        confirmationCodeHash: hashToken('654321'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
      await expect(service.confirmByCode('c1', 'lr1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when the code has expired', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        status: 'PENDING',
        confirmationCodeHash: hashToken('123456'),
        confirmationCodeExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.confirmByCode('c1', 'lr1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('confirms and auto-disburses under the configured threshold on a correct, unexpired code', async () => {
      const configService = { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
        configService,
      );
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        status: 'PENDING',
        confirmationCodeHash: hashToken('123456'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
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

      await service.confirmByCode('c1', 'lr1', '123456');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', approvedAt: expect.any(Date), disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientId: 'c1', loanRequestId: 'lr1' }) }),
      );
    });
  });

  describe('adminConfirmByCode', () => {
    it('throws NotFoundException when the loan request does not exist', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the loan request is not PENDING', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'CONFIRMED' });
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(ConflictException);
    });

    it('throws UnauthorizedException when the code does not match the stored hash', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        status: 'PENDING',
        confirmationCodeHash: hashToken('654321'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
      await expect(service.adminConfirmByCode('lr1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('confirms and auto-disburses under the configured threshold on a correct, unexpired code, with no client-ownership check', async () => {
      const configService = { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        walletService as unknown as WalletService,
        loanProductResolverService as unknown as LoanProductResolverService,
        configService,
      );
      prisma.loanRequest.findUnique.mockResolvedValue({
        id: 'lr1',
        clientId: 'some-other-client',
        status: 'PENDING',
        confirmationCodeHash: hashToken('123456'),
        confirmationCodeExpiresAt: new Date(Date.now() + 60000),
      });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'some-other-client',
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

      await service.adminConfirmByCode('lr1', '123456');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', approvedAt: expect.any(Date), disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientId: 'some-other-client', loanRequestId: 'lr1' }) }),
      );
    });
  });

  describe('approve', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.approve('lr1')).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when disbursedAt is in the future, without writing anything', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await expect(service.approve('lr1', future)).rejects.toThrow(BadRequestException);
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('moves a CONFIRMED request straight through to DISBURSED and creates a ClientLoan', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
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

      await service.approve('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
      });
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
        include: {
          client: {
            select: {
              id: true,
              phone: true,
              email: true,
              status: true,
              onboarding: {
                select: {
                  employeeName: true,
                  agency: true,
                  onboardedByAgentId: true,
                  ippisRecord: {
                    select: {
                      agency: true,
                      staffId: true,
                      employeeName: true,
                      employeeStatus: true,
                      hireDate: true,
                      department: true,
                      grade: true,
                      bankName: true,
                      accountNumber: true,
                    },
                  },
                },
              },
            },
          },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
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

    it('uses a supplied disbursedAt for both LoanRequest.disbursedAt and the ClientLoan disbursementDate/maturationDate', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
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
      const backdated = new Date(2026, 0, 1);

      await service.approve('lr1', backdated);

      expect(prisma.loanRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ disbursedAt: backdated }) }),
      );
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          disbursementDate: backdated,
          maturationDate: new Date(2026, 6, 1),
        }),
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
        include: {
          client: {
            select: {
              id: true,
              phone: true,
              email: true,
              status: true,
              onboarding: {
                select: {
                  employeeName: true,
                  agency: true,
                  onboardedByAgentId: true,
                  ippisRecord: {
                    select: {
                      agency: true,
                      staffId: true,
                      employeeName: true,
                      employeeStatus: true,
                      hireDate: true,
                      department: true,
                      grade: true,
                      bankName: true,
                      accountNumber: true,
                    },
                  },
                },
              },
            },
          },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
    });
  });

  describe('disburse', () => {
    it('throws ConflictException when the request is not APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await expect(service.disburse('lr1')).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when disbursedAt is in the future, without writing anything', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await expect(service.disburse('lr1', future)).rejects.toThrow(BadRequestException);
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
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
        include: {
          client: {
            select: {
              id: true,
              phone: true,
              email: true,
              status: true,
              onboarding: {
                select: {
                  employeeName: true,
                  agency: true,
                  onboardedByAgentId: true,
                  ippisRecord: {
                    select: {
                      agency: true,
                      staffId: true,
                      employeeName: true,
                      employeeStatus: true,
                      hireDate: true,
                      department: true,
                      grade: true,
                      bankName: true,
                      accountNumber: true,
                    },
                  },
                },
              },
            },
          },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });

  describe('listAll', () => {
    it('filters by status when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ status: 'CONFIRMED' as never });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'CONFIRMED' }) }),
      );
    });

    it('includes client and topupTarget on every row, with availableActions computed per row', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([{ id: 'lr1', status: 'CONFIRMED' }]);
      prisma.loanRequest.count.mockResolvedValue(1);

      const result = await service.listAll();

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            client: {
              select: {
                id: true,
                phone: true,
                email: true,
                status: true,
                onboarding: {
                  select: {
                    employeeName: true,
                    agency: true,
                    onboardedByAgentId: true,
                    ippisRecord: {
                      select: {
                        agency: true,
                        staffId: true,
                        employeeName: true,
                        employeeStatus: true,
                        hireDate: true,
                        department: true,
                        grade: true,
                        bankName: true,
                        accountNumber: true,
                      },
                    },
                  },
                },
              },
            },
            topupTarget: { select: { id: true, status: true, agency: true } },
          },
          omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
        }),
      );
      expect(result.data[0]).toEqual(expect.objectContaining({ id: 'lr1', availableActions: ['approve', 'reject'] }));
    });
  });

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the enriched row with availableActions for its status', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });

      const result = await service.findById('lr1');

      expect(prisma.loanRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        include: expect.objectContaining({ topupTarget: { select: { id: true, status: true, agency: true } } }),
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(result).toEqual({ id: 'lr1', status: 'PENDING', availableActions: ['confirmCode'] });
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

    it('rejects when the loan product resolver throws (no matching product for the requested tenor)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockRejectedValue(
        new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'),
      );

      await expect(service.createTopup('c1', 2000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the existing ClientLoan', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        orderBy: { disbursementDate: 'desc' },
      });
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
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr2' }, { delay: 24 * 60 * 60 * 1000 });
    });

    it('creates a TOPUP LoanRequest with no topupTargetId when the client has no ClientLoan row yet (ingested-only lifetime loan)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ topupTargetId: undefined }),
        omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
      });
    });

    it('also emails a top-up confirmation copy when the client has an email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', email: 'client@example.com' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirstOrThrow.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('top-up') }),
      );
    });

    it('falls back to the IppisRecord phone when the client has no phone on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', phone: '+2348099999999' },
      });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('top-up'));
    });
  });

  describe('disburse with a TOPUP request', () => {
    it('resets the existing ClientLoan row in place with the new terms, flipping status back to ACTIVE', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        clientId: 'c1',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 7000,
        tenorMonths: 6,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeAmount: 140,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 7000,
          principalBalance: 7000,
          disbursedAmount: 6860,
          tenorMonths: 6,
          interestRatePercent: 6,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeAmount: 140,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          status: 'ACTIVE',
        }),
      });
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });

    it('creates the client\'s first ClientLoan row when no topupTargetId is set (renewal of an ingested-only lifetime loan)', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        clientId: 'c1',
        type: 'TOPUP',
        topupTargetId: null,
        amount: 7000,
        tenorMonths: 6,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeAmount: 140,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl-new' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          loanRequestId: 'lr2',
          agency: 'NPF',
          staffId: 'NPF-001',
          principalAmount: 7000,
          principalBalance: 7000,
          disbursedAmount: 6860,
          status: 'ACTIVE',
        }),
      });
      expect(prisma.clientLoan.update).not.toHaveBeenCalled();
    });
  });

  describe('listAll with a type filter', () => {
    it('filters by type when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ type: 'TOPUP' as never });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: undefined, type: 'TOPUP' }) }),
      );
    });

    it('filters by clientId when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ clientId: 'client-1' });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: undefined, type: undefined, clientId: 'client-1' }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(7);
      const result = await service.listAll({}, { page: 2, limit: 5 });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 7, page: 2, limit: 5, totalPages: 2 });
    });
  });

  describe('list (client-facing)', () => {
    it('scopes to the given clientId, defaulting to page 1/limit 25', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);

      const result = await service.list('client-1');

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'client-1', status: undefined },
          skip: 0,
          take: 25,
          omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);

      await service.list('client-1', { status: 'CONFIRMED' as never });

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'client-1', status: 'CONFIRMED' } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(3);

      const result = await service.list('client-1', {}, { page: 2, limit: 2 });

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }));
      expect(result.meta).toEqual({ total: 3, page: 2, limit: 2, totalPages: 2 });
    });
  });

  describe('listByClient', () => {
    it('lists a client\'s ClientLoan rows ordered by disbursementDate descending, defaulting to page 1/limit 25', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([{ id: 'cl1' }]);
      prisma.clientLoan.count.mockResolvedValue(1);

      const result = await service.listByClient('client-1');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'client-1', status: undefined, agency: undefined, disbursementDate: undefined },
          orderBy: { disbursementDate: 'desc' },
          skip: 0,
          take: 25,
        }),
      );
      expect(result).toEqual({ data: [{ id: 'cl1' }], meta: { total: 1, page: 1, limit: 25, totalPages: 1 } });
    });

    it('filters by status and agency', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);

      await service.listByClient('client-1', { status: 'ACTIVE' as never, agency: 'NPF' });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE', agency: 'NPF' }) }),
      );
    });

    it('applies a disbursementDate range', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);
      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');

      await service.listByClient('client-1', { disbursedFrom, disbursedTo });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ disbursementDate: { gte: disbursedFrom, lte: disbursedTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(4);

      const result = await service.listByClient('client-1', {}, { page: 2, limit: 3 });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.meta).toEqual({ total: 4, page: 2, limit: 3, totalPages: 2 });
    });

    it('includes loanRequest and client on every row', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);

      await service.listByClient('client-1');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            loanRequest: { select: { id: true, type: true, status: true } },
            client: { select: { id: true, phone: true } },
          },
        }),
      );
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

  describe('getMyLoan', () => {
    it('returns null when the client has no ClientLoan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      const result = await service.getMyLoan('c1');
      expect(result).toBeNull();
    });

    it('returns the most recent ClientLoan with its schedule', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 1, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([
        { period: '2026-01', actualAmount: 45000, variance: 0, status: 'MATCHED' },
      ]);

      const result = await service.getMyLoan('c1');

      expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        orderBy: { disbursementDate: 'desc' },
      });
      expect(result!.id).toBe('cl1');
      expect(result!.schedule).toEqual([
        { period: '2026-01', expectedAmount: 90000, actualAmount: 45000, variance: 0, status: 'MATCHED' },
        { period: '2026-02', expectedAmount: 90000, actualAmount: null, variance: null, status: 'UPCOMING' },
      ]);
    });
  });

  describe('getRepaymentPlanById', () => {
    it('throws NotFoundException when the loan does not exist', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue(null);
      await expect(service.getRepaymentPlanById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the loan with its schedule', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 0, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([]);

      const result = await service.getRepaymentPlanById('cl1');

      expect(result.schedule).toEqual([
        { period: '2026-01', expectedAmount: 90000, actualAmount: null, variance: null, status: 'UPCOMING' },
      ]);
    });

    it('includes loanRequest and client when fetching the loan', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 0, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([]);

      await service.getRepaymentPlanById('cl1');

      expect(prisma.clientLoan.findUnique).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        include: {
          loanRequest: { select: { id: true, type: true, status: true } },
          client: { select: { id: true, phone: true } },
        },
      });
    });
  });

  describe('applyWalletToLoan', () => {
    // Date-relative (not hardcoded) so this fixture never drifts into the past — see the identical
    // reasoning in client-loan-reconciliation.service.spec.ts's baseLoan fixture.
    const now = new Date();
    const disbursementDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const maturationDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    it('throws UnprocessableEntityException when the client has no outstanding loan balance', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      await expect(service.applyWalletToLoan('c1', 5000)).rejects.toThrow(UnprocessableEntityException);
      expect(walletService.debit).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the current period already has a variance row, without touching the wallet', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue({ id: 'existing-row' });

      await expect(service.applyWalletToLoan('c1', 5000)).rejects.toThrow(ConflictException);
      expect(walletService.debit).not.toHaveBeenCalled();
      expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    });

    it('caps the applied amount at principalBalance, fully pays off the loan, and records an OVER_PAID row', async () => {
      // expectedAmount = 90000 / 2 months = 45000. Requesting 100000 against a 60000 balance caps at
      // 60000 — which exceeds the period's own expected installment (45000), so this period's row is
      // OVER_PAID even though nothing is credited back to the wallet (per the design: the full applied
      // amount pays down principal, with no separate excess-to-wallet step for a client-initiated payment).
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1', status: 'CLOSED' });

      const result = await service.applyWalletToLoan('c1', 100000);

      expect(walletService.debit).toHaveBeenCalledWith(
        'c1',
        60000,
        expect.stringContaining('cl1'),
        { actorType: 'CLIENT', actorId: 'c1' },
      );
      expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientLoanId: 'cl1',
          expectedAmount: 45000,
          actualAmount: 60000,
          variance: 15000,
          status: 'OVER_PAID',
          source: 'WALLET_APPLICATION',
        }),
      });
      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: { principalBalance: 0, status: 'CLOSED' },
      });
      expect(result).toEqual({ appliedAmount: 60000, remainingBalance: 0, status: 'CLOSED' });
    });

    it('applies a partial amount without capping, reducing the balance by the full amount regardless of the expected installment', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1', status: 'DEFAULT' });

      const result = await service.applyWalletToLoan('c1', 20000);

      expect(walletService.debit).toHaveBeenCalledWith('c1', 20000, expect.any(String), {
        actorType: 'CLIENT',
        actorId: 'c1',
      });
      expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ actualAmount: 20000, status: 'UNDER_PAID' }),
      });
      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: { principalBalance: 40000, status: 'DEFAULT' },
      });
      expect(result).toEqual({ appliedAmount: 20000, remainingBalance: 40000, status: 'DEFAULT' });
    });

    it('propagates WalletService.debit\'s own insufficient-balance error without creating a variance row', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      walletService.debit.mockRejectedValue(new UnprocessableEntityException('Insufficient wallet balance'));

      await expect(service.applyWalletToLoan('c1', 20000)).rejects.toThrow('Insufficient wallet balance');
      expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    });
  });
});
