import { Injectable } from '@nestjs/common';
import { FaceMatchResult, FaceVerificationProvider } from './face-verification-provider.interface';

@Injectable()
export class MockFaceVerificationProvider implements FaceVerificationProvider {
  async compare(_referencePhotoKey: string, _candidatePhotoKey: string): Promise<FaceMatchResult> {
    return { score: 0.95, passed: true };
  }
}
