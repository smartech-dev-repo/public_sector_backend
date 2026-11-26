import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FACE_VERIFICATION_PROVIDER } from './face-verification-provider.interface';
import { PythonFaceVerificationProvider } from './python-face-verification.provider';
import { FaceMatchSettingsService } from './face-match-settings.service';
import { FaceMatchService } from './face-match.service';
import { AdminFaceMatchSettingsController } from './admin-face-match-settings.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminFaceMatchSettingsController],
  providers: [
    {
      provide: FACE_VERIFICATION_PROVIDER,
      useClass: PythonFaceVerificationProvider,
    },
    FaceMatchSettingsService,
    FaceMatchService,
  ],
  exports: [FaceMatchService],
})
export class FaceVerificationModule {}
