export const FACE_VERIFICATION_PROVIDER = Symbol('FACE_VERIFICATION_PROVIDER');

/** Why the photo being verified (selfie or passport photo) can't be used at all. */
export type CandidateProblem =
  | 'NO_FACE_IN_CANDIDATE'
  | 'MULTIPLE_FACES_IN_CANDIDATE'
  | 'UNREADABLE_CANDIDATE';

/** Why one reference photo (BVN or NIN) couldn't be compared. */
export type ReferenceProblem = 'NO_FACE' | 'UNREADABLE_IMAGE';

/** Similarity 0..1 to one reference photo, or why it couldn't be compared. */
export type ReferenceResult = { score: number } | { error: ReferenceProblem };

export type FaceComparison =
  { results: Record<string, ReferenceResult> } | { error: CandidateProblem };

export interface FaceEngineStatus {
  available: boolean;
  /** e.g. "OpenCV 4.12.0", or why the engine can't run. */
  detail: string;
}

/** The comparison couldn't run (engine missing, crashed or timed out); nothing was decided. */
export class FaceEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceEngineUnavailableError';
  }
}

export interface FaceVerificationProvider {
  /** Compares one photo against each reference photo. Throws FaceEngineUnavailableError. */
  compare(
    candidate: Buffer,
    references: Record<string, Buffer>,
  ): Promise<FaceComparison>;
  status(): Promise<FaceEngineStatus>;
}
