import { Module } from '@nestjs/common';
import { ClientOnboardingController } from './client-onboarding.controller';
import { AdminClientOnboardingController } from './admin-client-onboarding.controller';
import { ClientOnboardingService } from './client-onboarding.service';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FaceVerificationModule } from '../face-verification/face-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [IdentityVerificationModule, FaceVerificationModule, FileStorageModule, AuditModule],
  controllers: [ClientOnboardingController, AdminClientOnboardingController],
  providers: [ClientOnboardingService],
  exports: [ClientOnboardingService],
})
export class ClientOnboardingModule {}
