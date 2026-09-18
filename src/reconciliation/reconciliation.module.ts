import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { AdminReconciliationController } from './admin-reconciliation.controller';

@Module({
  controllers: [AdminReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
