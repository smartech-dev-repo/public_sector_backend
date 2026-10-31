import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminManagementFeesController } from './admin-management-fees.controller';
import { ManagementFeesService } from './management-fees.service';

@Module({
  imports: [AuditModule],
  controllers: [AdminManagementFeesController],
  providers: [ManagementFeesService],
  exports: [ManagementFeesService],
})
export class ManagementFeesModule {}
