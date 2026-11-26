import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FaceMatchService } from './face-match.service';
import { FaceMatchSettingsService } from './face-match-settings.service';
import {
  FaceEngineUnavailableError,
  FaceVerificationProvider,
} from './face-verification-provider.interface';

describe('FaceMatchService', () => {
  let settings: { get: jest.Mock };
  let provider: { compare: jest.Mock; status: jest.Mock };
  let service: FaceMatchService;
  const idPhotos = { bvn: Buffer.from('bvn'), nin: Buffer.from('nin') };
  const loadIdPhotos = jest.fn();

  beforeEach(() => {
    settings = {
      get: jest.fn().mockResolvedValue({ enabled: true, minimumScore: 40 }),
    };
    provider = { compare: jest.fn(), status: jest.fn() };
    loadIdPhotos.mockReset().mockResolvedValue(idPhotos);
    service = new FaceMatchService(
      settings as unknown as FaceMatchSettingsService,
      provider as unknown as FaceVerificationProvider,
    );
  });

  it("doesn't compare, or load the ID photos, when switched off", async () => {
    settings.get.mockResolvedValue({ enabled: false, minimumScore: 40 });

    await expect(
      service.verify(Buffer.from('photo'), loadIdPhotos),
    ).resolves.toEqual({ checked: false });
    expect(loadIdPhotos).not.toHaveBeenCalled();
    expect(provider.compare).not.toHaveBeenCalled();
  });

  it('passes when both ID photos reach the minimum score', async () => {
    provider.compare.mockResolvedValue({
      results: { bvn: { score: 0.62 }, nin: { score: 0.4 } },
    });

    await expect(
      service.verify(Buffer.from('photo'), loadIdPhotos),
    ).resolves.toEqual({
      checked: true,
      minimumScore: 40,
      scores: { bvn: 0.62, nin: 0.4 },
      passed: true,
      problems: {},
    });
    expect(provider.compare).toHaveBeenCalledWith(
      Buffer.from('photo'),
      idPhotos,
    );
  });

  it('compares whole percentages, as the back office shows them', async () => {
    provider.compare.mockResolvedValue({
      results: { bvn: { score: 0.395 }, nin: { score: 0.394 } },
    });

    const outcome = await service.verify(Buffer.from('photo'), loadIdPhotos);

    expect(outcome).toMatchObject({
      passed: false,
      problems: { nin: 'BELOW_MINIMUM' },
    });
    expect(outcome).not.toHaveProperty('problems.bvn');
  });

  it('fails, naming the photo, when one is below the minimum or has no face', async () => {
    settings.get.mockResolvedValue({ enabled: true, minimumScore: 60 });
    provider.compare.mockResolvedValue({
      results: { bvn: { score: 0.55 }, nin: { error: 'NO_FACE' } },
    });

    await expect(
      service.verify(Buffer.from('photo'), loadIdPhotos),
    ).resolves.toEqual({
      checked: true,
      minimumScore: 60,
      scores: { bvn: 0.55, nin: null },
      passed: false,
      problems: { bvn: 'BELOW_MINIMUM', nin: 'NO_FACE' },
    });
  });

  it.each([
    ['NO_FACE_IN_CANDIDATE', /No face was found/],
    ['MULTIPLE_FACES_IN_CANDIDATE', /More than one face/],
    ['UNREADABLE_CANDIDATE', /could not be read/],
  ])('refuses the photo with 422 for %s', async (error, message) => {
    provider.compare.mockResolvedValue({ error });

    const attempt = service.verify(Buffer.from('photo'), loadIdPhotos);
    await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(attempt).rejects.toThrow(message);
  });

  it('answers 503 when the engine cannot run', async () => {
    provider.compare.mockRejectedValue(
      new FaceEngineUnavailableError('timed out'),
    );

    await expect(
      service.verify(Buffer.from('photo'), loadIdPhotos),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
