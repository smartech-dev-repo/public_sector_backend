import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FaceMatchSettingsService } from './face-match-settings.service';
import { FaceVerificationProvider } from './face-verification-provider.interface';

describe('FaceMatchSettingsService', () => {
  let prisma: {
    faceMatchSettings: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let provider: { compare: jest.Mock; status: jest.Mock };
  let service: FaceMatchSettingsService;
  const stored = {
    id: 'settings-1',
    enabled: false,
    minimumScore: 40,
    updatedAt: new Date('2026-11-26T10:00:00Z'),
  };

  beforeEach(() => {
    prisma = {
      faceMatchSettings: {
        findFirst: jest.fn().mockResolvedValue(stored),
        create: jest.fn(),
        update: jest.fn((args: { data: object }) =>
          Promise.resolve({ ...stored, ...args.data }),
        ),
      },
    };
    provider = {
      compare: jest.fn(),
      status: jest
        .fn()
        .mockResolvedValue({ available: true, detail: 'OpenCV 4.12.0' }),
    };
    service = new FaceMatchSettingsService(
      prisma as unknown as PrismaService,
      provider as unknown as FaceVerificationProvider,
    );
  });

  it('creates the settings row, switched off, the first time', async () => {
    prisma.faceMatchSettings.findFirst.mockResolvedValue(null);
    prisma.faceMatchSettings.create.mockResolvedValue(stored);

    await expect(service.get()).resolves.toEqual(stored);
    expect(prisma.faceMatchSettings.create).toHaveBeenCalledWith({ data: {} });
  });

  it('reports the settings with the engine status', async () => {
    await expect(service.getWithEngine()).resolves.toEqual({
      enabled: false,
      minimumScore: 40,
      updatedAt: stored.updatedAt,
      engine: { available: true, detail: 'OpenCV 4.12.0' },
    });
  });

  it('switches on when the engine works', async () => {
    await expect(
      service.update({ enabled: true, minimumScore: 55 }),
    ).resolves.toMatchObject({
      enabled: true,
      minimumScore: 55,
    });
    expect(prisma.faceMatchSettings.update).toHaveBeenCalledWith({
      where: { id: 'settings-1' },
      data: { enabled: true, minimumScore: 55 },
    });
  });

  it("refuses to switch on when the engine isn't working, and changes nothing", async () => {
    provider.status.mockResolvedValue({
      available: false,
      detail: 'model file missing',
    });

    await expect(service.update({ enabled: true })).rejects.toThrow(
      UnprocessableEntityException,
    );
    await expect(service.update({ enabled: true })).rejects.toThrow(
      /model file missing/,
    );
    expect(prisma.faceMatchSettings.update).not.toHaveBeenCalled();
  });

  it("doesn't check the engine to change the score or switch off", async () => {
    prisma.faceMatchSettings.findFirst.mockResolvedValue({
      ...stored,
      enabled: true,
    });
    provider.status.mockResolvedValue({ available: false, detail: 'down' });

    await service.update({ minimumScore: 70 });
    await service.update({ enabled: false });

    expect(provider.status).not.toHaveBeenCalled();
    expect(prisma.faceMatchSettings.update).toHaveBeenCalledTimes(2);
  });
});
