import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminController],
})
export class AdminModule {}
