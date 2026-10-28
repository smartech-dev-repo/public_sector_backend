import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { SmsType } from '../sms/sms-type';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { hashPassword } from '../common/password-hash.util';

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    otpCode: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };
  let smsService: { send: jest.Mock };

  beforeEach(() => {
    prisma = {
      otpCode: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    smsService = { send: jest.fn().mockResolvedValue(undefined) };
  });

  it('generates a 4-digit code, stores its hash, and sends it via SmsService', async () => {
    service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);

    await service.request('+2348000000000');

    expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.otpCode.create.mock.calls[0][0];
    expect(createArgs.data.phone).toBe('+2348000000000');
    expect(createArgs.data.purpose).toBe('CLIENT_LOGIN');
    expect(typeof createArgs.data.codeHash).toBe('string');
    expect(smsService.send).toHaveBeenCalledWith({
      type: SmsType.OTP,
      phone: '+2348000000000',
      message: expect.stringMatching(/^\d{4}$/),
    });
  });

  it('respects PHONE_OTP_LENGTH when configured', async () => {
    const configService = {
      get: jest.fn((key: string) => (key === 'PHONE_OTP_LENGTH' ? '8' : undefined)),
    } as unknown as ConfigService;
    service = new OtpService(
      prisma as unknown as PrismaService,
      smsService as unknown as SmsService,
      configService,
    );

    await service.request('+2348000000000');

    expect(smsService.send).toHaveBeenCalledWith({
      type: SmsType.OTP,
      phone: '+2348000000000',
      message: expect.stringMatching(/^\d{8}$/),
    });
  });

  it('propagates the error when SmsService.send fails', async () => {
    smsService.send.mockRejectedValue(new Error('Termii send failed: vendor down'));
    service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);

    await expect(service.request('+2348000000000')).rejects.toThrow('Termii send failed: vendor down');
  });

  it('rejects verification when no matching unconsumed code exists', async () => {
    service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    const result = await service.verify('+2348000000000', '123456');
    expect(result.valid).toBe(false);
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      email: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toEqual({ valid: true, email: null });
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('returns the matched row\'s pending email on success', async () => {
    service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      email: 'client@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toEqual({ valid: true, email: 'client@example.com' });
  });

  describe('mock OTP support', () => {
    it('does not short-circuit verify() when ENABLE_MOCK_OTP is not configured', async () => {
      service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+2348000000000', '0000');

      expect(result.valid).toBe(false);
      expect(prisma.otpCode.findFirst).toHaveBeenCalled();
    });

    it('short-circuits verify() to true for the mock code without querying prisma when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '0000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        configService,
      );

      const result = await service.verify('+2348000000000', '0000');

      expect(result).toEqual({ valid: true });
      expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    });

    it('echoes the real generated code back as mockCode when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '0000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        configService,
      );

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toEqual(expect.stringMatching(/^\d{4}$/));
    });

    it('omits mockCode from request() when disabled', async () => {
      service = new OtpService(prisma as unknown as PrismaService, smsService as unknown as SmsService);

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toBeUndefined();
    });
  });

  describe('email CC', () => {
    let emailService: { send: jest.Mock };

    beforeEach(() => {
      emailService = { send: jest.fn().mockResolvedValue(undefined) };
    });

    it('stores the email on the OtpCode row when given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000', 'client@example.com');

      expect(prisma.otpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'client@example.com' }) }),
      );
    });

    it('sends an email copy of the code when an email is given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000', 'client@example.com');

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'client@example.com',
          html: expect.stringContaining('verification code'),
        }),
      );
    });

    it('does not call emailService when no email is given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000');

      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does not throw when the email copy fails -- the request still resolves', async () => {
      emailService.send.mockRejectedValue(new Error('smtp down'));
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        undefined,
        emailService as unknown as EmailService,
      );

      await expect(service.request('+2348000000000', 'client@example.com')).resolves.toBeDefined();
    });

    it('still throws when SmsService.send fails, even with an email given', async () => {
      smsService.send.mockRejectedValue(new Error('vendor down'));
      service = new OtpService(
        prisma as unknown as PrismaService,
        smsService as unknown as SmsService,
        undefined,
        emailService as unknown as EmailService,
      );

      await expect(service.request('+2348000000000', 'client@example.com')).rejects.toThrow('vendor down');
    });
  });
});
