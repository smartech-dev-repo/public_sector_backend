import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ClientInScope } from '../auth/client-scope.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { AgentCanOnboardClientsGuard } from '../auth/agent-can-onboard-clients.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientAssignmentService } from './client-assignment.service';
import {
  AgentLinkConfirmDto,
  AgentLinkRequestDto,
  AssignableQueryDto,
  ReassignAgentClientsDto,
  UpdateClientAssignmentDto,
} from './dto/assignment.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminOnlyGuard, PermissionsGuard)
export class AdminClientAssignmentController {
  constructor(private readonly assignments: ClientAssignmentService) {}

  /** Approved agents who can take clients, for the assign picker. */
  @Get('clients/assignable-agents')
  @RequirePermissions('clients:assign')
  assignableAgents(@Query() query: AssignableQueryDto) {
    return this.assignments.assignableAgents(query.q);
  }

  /** Active admins, for the assign picker. */
  @Get('clients/assignable-admins')
  @RequirePermissions('clients:assign')
  assignableAdmins(@Query() query: AssignableQueryDto) {
    return this.assignments.assignableAdmins(query.q);
  }

  @Get('clients/:clientId/assignment')
  @RequirePermissions('clients:read')
  @ClientInScope('clientId')
  get(@Param('clientId') clientId: string) {
    return this.assignments.getAssignment(clientId);
  }

  @Patch('clients/:clientId/assignment')
  @RequirePermissions('clients:assign')
  @ClientInScope('clientId')
  update(
    @Param('clientId') clientId: string,
    @Body() dto: UpdateClientAssignmentDto,
    @Req() req: { user: JwtPayload },
  ) {
    return this.assignments.updateAssignment(
      clientId,
      { agentId: dto.agentId, adminId: dto.adminId },
      dto.reason,
      { type: 'ADMIN', id: req.user.sub },
    );
  }

  @Post('agents/:agentId/clients/reassign')
  @HttpCode(200)
  @RequirePermissions('clients:assign')
  reassign(
    @Param('agentId') agentId: string,
    @Body() dto: ReassignAgentClientsDto,
    @Req() req: { user: JwtPayload },
  ) {
    return this.assignments.reassignAgentClients(
      agentId,
      dto.toAgentId,
      dto.clientIds,
      dto.reason,
      { type: 'ADMIN', id: req.user.sub },
      req.user,
    );
  }
}

/** An agent links a self-onboarded (or otherwise unassigned) client, with the client's code. */
@Controller('agent/clients/link')
@UseGuards(JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard)
export class AgentClientLinkController {
  constructor(private readonly assignments: ClientAssignmentService) {}

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('request')
  @HttpCode(201)
  request(@Body() dto: AgentLinkRequestDto, @Req() req: { user: JwtPayload }) {
    return this.assignments.requestAgentLink(req.user.sub, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() dto: AgentLinkConfirmDto, @Req() req: { user: JwtPayload }) {
    return this.assignments.confirmAgentLink(
      req.user.sub,
      dto.requestId,
      dto.code,
    );
  }
}
