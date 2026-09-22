import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpProvider } from './otp-provider.interface';
import { hashPassword } from '../common/password-hash.util';

function fakeProvider(name: string, send: jest.Mock): OtpProvider {
  return { name, send };
}

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    otpCode: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      otpCode: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
  });

  it('generates a 6-digit code, stores its hash, and sends it via the first provider', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.otpCode.create.mock.calls[0][0];
    expect(createArgs.data.phone).toBe('+2348000000000');
    expect(createArgs.data.purpose).toBe('CLIENT_LOGIN');
    expect(typeof createArgs.data.codeHash).toBe('string');
    expect(primarySend).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(secondarySend).not.toHaveBeenCalled();
  });

  it('falls back to the next provider when the first one fails', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor down'));
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(secondarySend).toHaveBeenCalledTimes(1);
  });

  it('throws once every provider has failed', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor A down'));
    const secondarySend = jest.fn().mockRejectedValue(new Error('vendor B down'));
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await expect(service.request('+2348000000000')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('rejects verification when no matching unconsumed code exists', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    const result = await service.verify('+2348000000000', '123456');
    expect(result).toBe(false);
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toBe(true);
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  describe('mock OTP support', () => {
    it('does not short-circuit verify() when ENABLE_MOCK_OTP is not configured', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn()),
      ]);
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+2348000000000', '000000');

      expect(result).toBe(false);
      expect(prisma.otpCode.findFirst).toHaveBeenCalled();
    });

    it('short-circuits verify() to true for the mock code without querying prisma when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '000000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn())],
        configService,
      );

      const result = await service.verify('+2348000000000', '000000');

      expect(result).toBe(true);
      expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    });

    it('echoes the real generated code back as mockCode when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '000000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        configService,
      );

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toEqual(expect.stringMatching(/^\d{6}$/));
    });

    it('omits mockCode from request() when disabled', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn().mockResolvedValue(undefined)),
      ]);

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toBeUndefined();
    });
  });
});
