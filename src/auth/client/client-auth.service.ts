import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    await this.otpService.request(phone);
  }

  async verifyOtp(phone: string, code: string) {
    const isValid = await this.otpService.verify(phone, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    const payload = { sub: client.id, type: 'client' as const };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: this.tokenService.signRefreshToken(payload),
    };
  }
}
