import { Module } from '@nestjs/common';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AgentClientsController } from './agent-clients.controller';
import { AgentClientsService } from './agent-clients.service';

@Module({
  imports: [FileStorageModule],
  controllers: [AgentClientsController],
  providers: [AgentClientsService],
})
export class AgentClientsModule {}
