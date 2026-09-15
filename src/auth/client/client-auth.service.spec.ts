import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = { client: { upsert: jest.fn() } };
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

  it('delegates OTP requests to OtpService', async () => {
    await service.requestOtp('+2348000000000');
    expect(otpService.request).toHaveBeenCalledWith('+2348000000000');
  });

  it('rejects an invalid OTP', async () => {
    otpService.verify.mockResolvedValue(false);
    await expect(
      service.verifyOtp('+2348000000000', '000000'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('upserts the Client and issues tokens via SessionService on a valid OTP', async () => {
    otpService.verify.mockResolvedValue(true);
    prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });

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
});
