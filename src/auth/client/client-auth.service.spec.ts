import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = {
      client: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  describe('requestOtp', () => {
    it('delegates to OtpService with no email when none is given and no client exists yet', async () => {
      otpService.request.mockResolvedValue({});
      const result = await service.requestOtp('+2348000000000');
      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', undefined);
      expect(result.emailSent).toBe(false);
    });

    it('passes a brand-new email through after confirming it is not already taken', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.email ? null : null),
      );
      otpService.request.mockResolvedValue({});

      const result = await service.requestOtp('+2348000000000', 'new@example.com');

      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', 'new@example.com');
      expect(result.emailSent).toBe(true);
    });

    it('rejects when the supplied email already belongs to another client', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.email ? { id: 'other-client', email: where.email } : null),
      );

      await expect(service.requestOtp('+2348000000000', 'taken@example.com')).rejects.toThrow(ConflictException);
      expect(otpService.request).not.toHaveBeenCalled();
    });

    it('ignores a newly-supplied email and uses the existing saved one once a client already has one', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.phone ? { id: 'client-1', phone: where.phone, email: 'already-saved@example.com' } : null),
      );
      otpService.request.mockResolvedValue({});

      const result = await service.requestOtp('+2348000000000', 'different@example.com');

      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', 'already-saved@example.com');
      expect(result.emailSent).toBe(true);
    });
  });

  describe('verifyOtp', () => {
    it('rejects an invalid OTP', async () => {
      otpService.verify.mockResolvedValue({ valid: false });
      await expect(
        service.verifyOtp('+2348000000000', '000000'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('upserts the Client and issues tokens via SessionService on a valid OTP', async () => {
      otpService.verify.mockResolvedValue({ valid: true });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });

      const result = await service.verifyOtp('+2348000000000', '123456', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(sessionService.createSession).toHaveBeenCalledWith({
        principalType: 'CLIENT',
        principalId: 'client-1',
        userAgent: 'jest',
        ip: '127.0.0.1',
      });
      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });

    it('persists a pending email from the OTP onto a newly-created Client', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'new@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: 'new@example.com' });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { email: 'new@example.com' },
      });
    });

    it('does not touch the Client when the OTP carried no pending email', async () => {
      otpService.verify.mockResolvedValue({ valid: true });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('does not overwrite a Client that already has an email', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'new@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: 'already-saved@example.com' });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('swallows a P2002 race on the email update and still logs the client in', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'raced@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockRejectedValue({ code: 'P2002' });

      const result = await service.verifyOtp('+2348000000000', '123456');

      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });

    it('propagates a non-P2002 error from the email update', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'raced@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockRejectedValue(new Error('db down'));

      await expect(service.verifyOtp('+2348000000000', '123456')).rejects.toThrow('db down');
    });
  });
});
