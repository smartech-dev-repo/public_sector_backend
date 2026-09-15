import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(private readonly agentAuthService: AgentAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto, @Req() req: Request) {
    return this.agentAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }
}
