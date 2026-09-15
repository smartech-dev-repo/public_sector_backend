import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminInviteService } from './admin-invite.service';
import { AdminInviteController } from './admin-invite.controller';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminInviteController],
  providers: [AdminInviteService],
  exports: [AdminInviteService],
})
export class AdminInviteModule {}
