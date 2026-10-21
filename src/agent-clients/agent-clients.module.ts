import { Module } from '@nestjs/common';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { ClientLoanSummaryModule } from '../client-loan-summary/client-loan-summary.module';
import { AgentClientsController } from './agent-clients.controller';
import { AgentClientsService } from './agent-clients.service';

@Module({
  imports: [FileStorageModule, ClientLoanSummaryModule],
  controllers: [AgentClientsController],
  providers: [AgentClientsService],
})
export class AgentClientsModule {}
