import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

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
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.clientAuthService.verifyOtp(dto.phone, dto.code);
  }
}
