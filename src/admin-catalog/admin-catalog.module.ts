import { Module } from '@nestjs/common';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminLoansController } from './admin-loans.controller';
import { AdminIppisRecordsController } from './admin-ippis-records.controller';

@Module({
  controllers: [AdminLoansController, AdminIppisRecordsController],
  providers: [AdminCatalogService],
})
export class AdminCatalogModule {}
