import { Module } from '@nestjs/common';
import { MockFaceVerificationProvider } from './mock-face-verification.provider';
import { FACE_VERIFICATION_PROVIDER } from './face-verification-provider.interface';

@Module({
  providers: [
    MockFaceVerificationProvider,
    // Single-provider for now (per the original spec — no second vendor
    // exists yet), so this binds directly rather than through a
    // config-driven factory. Swapping in a real implementation later is a
    // one-line change here plus a new provider class, no other code changes.
    { provide: FACE_VERIFICATION_PROVIDER, useExisting: MockFaceVerificationProvider },
  ],
  exports: [FACE_VERIFICATION_PROVIDER],
})
export class FaceVerificationModule {}
