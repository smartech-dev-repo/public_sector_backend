import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminAuditLogController } from './admin-audit-log.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminAuditLogController],
})
export class AdminAuditLogModule {}
