import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionModule } from '../session/session.module';
import { AdminSessionController } from './admin-session.controller';

@Module({
  imports: [AuditModule, SessionModule],
  controllers: [AdminSessionController],
})
export class AdminSessionModule {}
