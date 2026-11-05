import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DeviceBindingService } from './device-binding.service';
import { DeviceNotRecognisedException } from './device-not-recognised.exception';
import { deviceInfoFromHeaders } from './device-info.util';

describe('DeviceBindingService', () => {
  let prisma: any;
  let config: { get: jest.Mock; getOrThrow: jest.Mock };
  let email: { send: jest.Mock };
  let sms: { send: jest.Mock };
  let push: { sendToDevice: jest.Mock };
  let audit: { recordSafely: jest.Mock };
  let service: DeviceBindingService;

  const phone = { fingerprint: 'new-phone', brand: 'Samsung', model: 'A15' };
  const bound = {
    id: 'd1',
    fingerprint: 'old-phone',
    brand: 'Tecno',
    model: 'Spark',
    pushToken: 'tok',
    principalType: 'AGENT',
    principalId: 'a1',
  };

  beforeEach(() => {
    prisma = {
      device: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      agent: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            email: 'agent@example.test',
            fullName: 'Ada Agent',
          }),
      },
      client: {
        findUnique: jest.fn().mockResolvedValue({ phone: '+2348031234567' }),
      },
    };
    config = {
      get: jest.fn(),
      getOrThrow: jest.fn().mockReturnValue('pending-secret'),
    };
    email = { send: jest.fn() };
    sms = { send: jest.fn() };
    push = { sendToDevice: jest.fn() };
    audit = { recordSafely: jest.fn() };
    service = new DeviceBindingService(
      prisma,
      config as never,
      new JwtService({}),
      audit as never,
      email as never,
      sms as never,
      push as never,
    );
  });

  it('binds the first device an account signs in on', async () => {
    prisma.device.findFirst.mockResolvedValue(null);
    prisma.device.create.mockResolvedValue({ id: 'd2', ...phone });
    await expect(
      service.assertSignInDevice('AGENT', 'a1', phone),
    ).resolves.toMatchObject({ id: 'd2' });
    expect(prisma.device.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        principalType: 'AGENT',
        principalId: 'a1',
        fingerprint: 'new-phone',
      }),
    });
  });

  it('lets the bound device in and refreshes what it reports', async () => {
    prisma.device.findFirst.mockResolvedValue({
      ...bound,
      fingerprint: 'new-phone',
    });
    prisma.device.update.mockResolvedValue({ id: 'd1' });
    await service.assertSignInDevice('AGENT', 'a1', {
      ...phone,
      pushToken: 'fresh',
    });
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ pushToken: 'fresh' }),
    });
  });

  it('refuses another device with a release token, emails the agent and pushes to the bound phone', async () => {
    prisma.device.findFirst.mockResolvedValue(bound);
    const error = await service
      .assertSignInDevice('AGENT', 'a1', phone)
      .catch((e) => e);
    expect(error).toBeInstanceOf(DeviceNotRecognisedException);
    const body = error.getResponse();
    expect(body).toMatchObject({
      code: 'DEVICE_NOT_RECOGNISED',
      linkedDevice: 'Tecno Spark',
    });
    expect(service.verifyReleaseToken(body.releaseToken)).toMatchObject({
      principalType: 'AGENT',
      principalId: 'a1',
      device: { fingerprint: 'new-phone' },
    });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'agent@example.test',
        subject: 'Sign-in blocked on an unrecognised device',
      }),
    );
    expect(push.sendToDevice).toHaveBeenCalledWith(
      'd1',
      'tok',
      expect.objectContaining({ title: 'Sign-in blocked' }),
    );
  });

  it('texts a client instead of emailing', async () => {
    prisma.device.findFirst.mockResolvedValue({
      ...bound,
      principalType: 'CLIENT',
      pushToken: null,
    });
    await expect(
      service.assertSignInDevice('CLIENT', 'c1', phone),
    ).rejects.toBeInstanceOf(DeviceNotRecognisedException);
    expect(sms.send).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+2348031234567' }),
    );
    expect(sms.send.mock.calls[0][0].message.length).toBeLessThanOrEqual(160);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('alerts once an hour per refused device, but always refuses', async () => {
    prisma.device.findFirst.mockResolvedValue(bound);
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'recent' });
    await expect(
      service.assertSignInDevice('AGENT', 'a1', phone),
    ).rejects.toBeInstanceOf(DeviceNotRecognisedException);
    expect(email.send).not.toHaveBeenCalled();
    expect(push.sendToDevice).not.toHaveBeenCalled();
  });

  it('allows sign-in without device headers until DEVICE_BINDING_REQUIRED is on', async () => {
    await expect(
      service.assertSignInDevice('AGENT', 'a1', undefined),
    ).resolves.toBeNull();
    config.get.mockImplementation((key: string) =>
      key === 'DEVICE_BINDING_REQUIRED' ? 'true' : undefined,
    );
    await expect(
      service.assertSignInDevice('AGENT', 'a1', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a release token is not signed with the two-factor key', () => {
    const token = service.signReleaseToken({
      principalType: 'AGENT',
      principalId: 'a1',
      device: phone,
    });
    expect(() =>
      new JwtService({}).verify(token, { secret: 'pending-secret' }),
    ).toThrow();
  });
});

describe('deviceInfoFromHeaders', () => {
  it('reads the X-Device headers and ignores a request without X-Device-Id', () => {
    expect(deviceInfoFromHeaders({})).toBeUndefined();
    expect(
      deviceInfoFromHeaders({
        'x-device-id': ' abc ',
        'x-device-brand': 'Samsung',
        'x-device-platform': 'Android',
        'x-push-token': 't',
      }),
    ).toEqual(
      expect.objectContaining({
        fingerprint: 'abc',
        brand: 'Samsung',
        platform: 'android',
        pushToken: 't',
      }),
    );
  });

  it('caps lengths and strips control characters', () => {
    const info = deviceInfoFromHeaders({
      'x-device-id': 'id',
      'x-device-name': `bad\u0000name${'x'.repeat(500)}`,
    })!;
    expect(info.deviceName!.startsWith('badname')).toBe(true);
    expect(info.deviceName!.length).toBe(120);
  });
});
