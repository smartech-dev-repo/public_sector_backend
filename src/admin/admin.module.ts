import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuditModule, FileStorageModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
