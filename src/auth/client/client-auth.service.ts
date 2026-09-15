import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    await this.otpService.request(phone);
  }

  async verifyOtp(phone: string, code: string, meta?: { userAgent?: string; ip?: string }) {
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

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.CLIENT,
      principalId: client.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}
