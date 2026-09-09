import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(private readonly agentAuthService: AgentAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto) {
    return this.agentAuthService.login(dto.email, dto.password);
  }
}
