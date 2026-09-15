import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ClientAuthService } from './client-auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/client')
export class ClientAuthController {
  constructor(private readonly clientAuthService: ClientAuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.clientAuthService.requestOtp(dto.phone);
    return { sent: true };
  }

  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.clientAuthService.verifyOtp(dto.phone, dto.code, getRequestMetadata(req));
  }
}
