import { Module } from '@nestjs/common';
import { AgentClientsController } from './agent-clients.controller';
import { AgentClientsService } from './agent-clients.service';

@Module({
  controllers: [AgentClientsController],
  providers: [AgentClientsService],
})
export class AgentClientsModule {}
