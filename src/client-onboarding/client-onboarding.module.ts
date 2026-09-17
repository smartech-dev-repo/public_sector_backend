import { Module } from '@nestjs/common';
import { ClientOnboardingController } from './client-onboarding.controller';
import { ClientOnboardingService } from './client-onboarding.service';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FaceVerificationModule } from '../face-verification/face-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
  imports: [IdentityVerificationModule, FaceVerificationModule, FileStorageModule],
  controllers: [ClientOnboardingController],
  providers: [ClientOnboardingService],
})
export class ClientOnboardingModule {}
