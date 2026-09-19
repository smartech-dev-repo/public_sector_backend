import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import { ConfirmTwoFactorDto } from './dto/confirm-two-factor.dto';
import { DisableTwoFactorDto } from './dto/disable-two-factor.dto';
import { TwoFactorLoginVerifyDto } from './dto/two-factor-login-verify.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { AdminOnlyGuard } from '../admin-only.guard';
import { JwtPayload } from '../jwt-payload.interface';

@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.adminAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.adminAuthService.acceptInvite(
      dto.token,
      dto.password,
      dto.fullName,
      getRequestMetadata(req),
    );
  }

  @Post('forgot-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.adminAuthService.forgotPassword(dto.email);
    return { sent: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.adminAuthService.resetPassword(dto.token, dto.newPassword);
    return { reset: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    return { changed: true };
  }

  @Post('2fa/setup')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  setupTwoFactor(@Body() dto: SetupTwoFactorDto, @Req() req: { user: JwtPayload }) {
    return this.adminAuthService.setupTwoFactor(req.user.sub, dto.method);
  }

  @Post('2fa/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async confirmTwoFactor(@Body() dto: ConfirmTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.confirmTwoFactor(req.user.sub, dto.code);
    return { enabled: true };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async disableTwoFactor(@Body() dto: DisableTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.disableTwoFactor(req.user.sub, dto.currentPassword);
    return { disabled: true };
  }

  @Post('2fa/login-verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  verifyTwoFactorLogin(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
    return this.adminAuthService.verifyTwoFactorLogin(dto.pendingToken, dto.code, getRequestMetadata(req));
  }
}
