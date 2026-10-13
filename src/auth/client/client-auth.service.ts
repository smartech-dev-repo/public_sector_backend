import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { isUniqueConstraintError } from '../../common/is-unique-constraint-error.util';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async requestOtp(phone: string, email?: string): Promise<{ mockCode?: string; emailSent: boolean }> {
    const existingClient = await this.prisma.client.findUnique({ where: { phone } });
    let effectiveEmail: string | undefined = existingClient?.email ?? undefined;

    if (!effectiveEmail && email) {
      const emailTaken = await this.prisma.client.findUnique({ where: { email } });
      if (emailTaken) {
        throw new ConflictException('This email is already in use');
      }
      effectiveEmail = email;
    }

    const { mockCode } = await this.otpService.request(phone, effectiveEmail);
    return { mockCode, emailSent: Boolean(effectiveEmail) };
  }

  async verifyOtp(phone: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    const result = await this.otpService.verify(phone, code);
    if (!result.valid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    let client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    if (result.email && !client.email) {
      try {
        client = await this.prisma.client.update({ where: { id: client.id }, data: { email: result.email } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        // Someone else claimed this email in the window between this
        // client's request and verify calls -- login still succeeds, the
        // email is just silently dropped this time.
      }
    }

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
