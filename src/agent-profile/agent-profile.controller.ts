// src/agent-profile/agent-profile.controller.ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AgentProfileService } from './agent-profile.service';

@Controller('agent')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentProfileController {
  constructor(private readonly agentProfileService: AgentProfileService) {}

  @Get('me')
  getProfile(@Req() req: { user: JwtPayload }) {
    return this.agentProfileService.getProfile(req.user.sub);
  }
}
