import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DepartmentService } from './department.service';
import { AdminDepartmentsController } from './admin-departments.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminDepartmentsController],
  providers: [DepartmentService],
})
export class AdminDepartmentModule {}
