export const FACE_VERIFICATION_PROVIDER = Symbol('FACE_VERIFICATION_PROVIDER');

export interface FaceMatchResult {
  score: number;
  passed: boolean;
}

export interface FaceVerificationProvider {
  compare(referencePhotoKey: string, candidatePhotoKey: string): Promise<FaceMatchResult>;
}
