import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock } };
  let tokenService: TokenService;

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = { client: { upsert: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      signRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    } as unknown as TokenService;
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
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

  it('upserts the Client and issues tokens on a valid OTP', async () => {
    otpService.verify.mockResolvedValue(true);
    prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });

    const result = await service.verifyOtp('+2348000000000', '123456');

    expect(prisma.client.upsert).toHaveBeenCalledWith({
      where: { phone: '+2348000000000' },
      update: {},
      create: { phone: '+2348000000000' },
    });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'client-1',
      type: 'client',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
