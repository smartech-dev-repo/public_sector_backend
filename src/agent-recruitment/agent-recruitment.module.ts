import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AgentRecruitmentController } from './agent-recruitment.controller';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { AgentApplicationTokenGuard } from '../auth/agent-application-token.guard';

@Module({
  imports: [AuthModule, EmailModule, IdentityVerificationModule, FileStorageModule],
  controllers: [AgentRecruitmentController],
  providers: [AgentRecruitmentService, AgentApplicationTokenGuard],
})
export class AgentRecruitmentModule {}
