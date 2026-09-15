import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
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
}
