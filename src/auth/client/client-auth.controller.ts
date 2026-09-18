import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { ClientAuthService } from './client-auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/client')
export class ClientAuthController {
  constructor(private readonly clientAuthService: ClientAuthService) {}

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.clientAuthService.requestOtp(dto.phone);
    return { sent: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.clientAuthService.verifyOtp(dto.phone, dto.code, getRequestMetadata(req));
  }
}
