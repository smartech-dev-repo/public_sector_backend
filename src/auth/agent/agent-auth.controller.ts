import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { AgentOnlyGuard } from '../agent-only.guard';
import { JwtPayload } from '../jwt-payload.interface';
import { TokenService } from '../token.service';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(
    private readonly agentAuthService: AgentAuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto, @Req() req: Request) {
    return this.agentAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    const payload: JwtPayload = { sub: req.user.sub, type: 'agent', mustChangePassword: false };
    return { accessToken: this.tokenService.signAccessToken(payload) };
  }
}
