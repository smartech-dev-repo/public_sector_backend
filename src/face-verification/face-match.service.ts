import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CandidateProblem,
  FACE_VERIFICATION_PROVIDER,
  FaceEngineUnavailableError,
  FaceVerificationProvider,
  ReferenceProblem,
} from './face-verification-provider.interface';
import { FaceMatchSettingsService } from './face-match-settings.service';

export type IdentityPhoto = 'bvn' | 'nin';

/** Why one ID photo didn't pass. */
export type FaceMatchProblem = 'BELOW_MINIMUM' | ReferenceProblem;

export type FaceMatchOutcome =
  /** Comparison is switched off; the photo isn't judged. */
  | { checked: false }
  | {
      checked: true;
      minimumScore: number;
      /** 0..1 per ID photo; null when that photo couldn't be compared. */
      scores: Record<IdentityPhoto, number | null>;
      passed: boolean;
      /** ID photos that didn't pass, and why. Empty when passed. */
      problems: Partial<Record<IdentityPhoto, FaceMatchProblem>>;
    };

const CANDIDATE_MESSAGES: Record<CandidateProblem, string> = {
  NO_FACE_IN_CANDIDATE:
    'No face was found in the photo. Take it facing the camera, in good light.',
  MULTIPLE_FACES_IN_CANDIDATE:
    'More than one face is in the photo. Only the client should be in it.',
  UNREADABLE_CANDIDATE: 'The photo could not be read. Use a JPEG or PNG image.',
};

/**
 * Decides whether a client's photo (live selfie, or the passport photo an agent or admin
 * uploaded) matches their BVN and NIN photos, using the back office's face match settings.
 */
@Injectable()
export class FaceMatchService {
  constructor(
    private readonly settings: FaceMatchSettingsService,
    @Inject(FACE_VERIFICATION_PROVIDER)
    private readonly provider: FaceVerificationProvider,
  ) {}

  /**
   * The ID photos are only loaded when comparison is switched on.
   *
   * Throws 422 when the photo itself is unusable (no face, several faces, not an image), so it
   * can be retaken, and 503 when the comparison couldn't run at all. A face that doesn't match,
   * or an ID photo that can't be compared, is an outcome (passed: false), not an error.
   */
  async verify(
    photo: Buffer,
    loadIdPhotos: () => Promise<Record<IdentityPhoto, Buffer>>,
  ): Promise<FaceMatchOutcome> {
    const { enabled, minimumScore } = await this.settings.get();
    if (!enabled) {
      return { checked: false };
    }

    const idPhotos = await loadIdPhotos();
    let comparison;
    try {
      comparison = await this.provider.compare(photo, idPhotos);
    } catch (error) {
      if (error instanceof FaceEngineUnavailableError) {
        throw new ServiceUnavailableException(
          'Face comparison is temporarily unavailable. Try again shortly.',
        );
      }
      throw error;
    }
    if ('error' in comparison) {
      throw new UnprocessableEntityException(
        CANDIDATE_MESSAGES[comparison.error],
      );
    }

    const scores: Record<IdentityPhoto, number | null> = {
      bvn: null,
      nin: null,
    };
    const problems: Partial<Record<IdentityPhoto, FaceMatchProblem>> = {};
    for (const name of ['bvn', 'nin'] as const) {
      const result = comparison.results[name];
      if ('error' in result) {
        problems[name] = result.error;
        continue;
      }
      scores[name] = result.score;
      // Compared as a whole percentage, the way the back office shows the score.
      if (Math.round(result.score * 100) < minimumScore) {
        problems[name] = 'BELOW_MINIMUM';
      }
    }
    return {
      checked: true,
      minimumScore,
      scores,
      passed: Object.keys(problems).length === 0,
      problems,
    };
  }
}
