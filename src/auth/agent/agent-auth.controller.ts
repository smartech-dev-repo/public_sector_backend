import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import { ConfirmTwoFactorDto } from './dto/confirm-two-factor.dto';
import { DisableTwoFactorDto } from './dto/disable-two-factor.dto';
import { TwoFactorLoginVerifyDto } from './dto/two-factor-login-verify.dto';
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

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto, @Req() req: Request) {
    return this.agentAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.agentAuthService.forgotPassword(dto.email);
    return { sent: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.agentAuthService.resetPassword(dto.token, dto.newPassword);
    return { reset: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    const payload: JwtPayload = { sub: req.user.sub, type: 'agent', mustChangePassword: false };
    return { accessToken: this.tokenService.signAccessToken(payload) };
  }

  @Post('2fa/setup')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  setupTwoFactor(@Body() dto: SetupTwoFactorDto, @Req() req: { user: JwtPayload }) {
    return this.agentAuthService.setupTwoFactor(req.user.sub, dto.method);
  }

  @Post('2fa/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async confirmTwoFactor(@Body() dto: ConfirmTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.confirmTwoFactor(req.user.sub, dto.code);
    return { enabled: true };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async disableTwoFactor(@Body() dto: DisableTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.disableTwoFactor(req.user.sub, dto.currentPassword);
    return { disabled: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('2fa/login-verify')
  @HttpCode(200)
  verifyTwoFactorLogin(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
    return this.agentAuthService.verifyTwoFactorLogin(dto.pendingToken, dto.code, getRequestMetadata(req));
  }
}
