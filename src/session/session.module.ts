import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionService } from './session.service';

@Module({
  imports: [AuditModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
