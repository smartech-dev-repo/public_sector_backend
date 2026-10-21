import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AgentClientsService } from './agent-clients.service';
import { ListMyClientsQueryDto } from './dto/list-my-clients-query.dto';

@Controller('agent/clients')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentClientsController {
  constructor(private readonly agentClientsService: AgentClientsService) {}

  @Get()
  list(@Query() query: ListMyClientsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.agentClientsService.listMyClients(
      req.user.sub,
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get(':clientId')
  getOne(@Param('clientId') clientId: string, @Req() req: { user: JwtPayload }) {
    return this.agentClientsService.getOneForAgent(req.user.sub, clientId);
  }
}
