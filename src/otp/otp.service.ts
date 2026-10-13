import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_PROVIDERS, OtpProvider } from './otp-provider.interface';
import { EmailService } from '../email/email.service';
import { hashPassword } from '../common/password-hash.util';
import { generateNumericCode } from '../common/generate-numeric-code.util';

export interface OtpVerifyResult {
  valid: boolean;
  email?: string | null;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDERS) private readonly providers: OtpProvider[],
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
  ) {}

  private ttlSeconds(): number {
    return Number(this.configService?.get('OTP_TTL_SECONDS') ?? 300);
  }

  private async sendWithFailover(phone: string, code: string): Promise<void> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        await provider.send(phone, code);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`OTP provider "${provider.name}" failed: ${message}`);
        failures.push(`${provider.name}: ${message}`);
      }
    }

    throw new InternalServerErrorException(
      `All OTP providers failed: ${failures.join('; ')}`,
    );
  }

  async request(phone: string, email?: string): Promise<{ mockCode?: string }> {
    const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
    const code = generateNumericCode(length);
    const codeHash = await hashPassword(code);
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: { phone, email, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
    });

    await this.sendWithFailover(phone, code);

    if (email) {
      await this.sendEmailCopy(email, code);
    }

    return {
      mockCode:
        this.configService?.get('ENABLE_MOCK_OTP') === 'true'
          ? code
          : undefined,
    };
  }

  private async sendEmailCopy(email: string, code: string): Promise<void> {
    const minutes = Math.round(this.ttlSeconds() / 60);
    try {
      await this.emailService?.send({
        to: email,
        subject: 'Your login code',
        html: `<p>Your verification code is <strong>${code}</strong>. It expires in ${minutes} minutes.</p>`,
        text: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OTP email copy to ${email} failed: ${message}`);
    }
  }

  async verify(phone: string, code: string): Promise<OtpVerifyResult> {
    if (
      this.configService?.get('ENABLE_MOCK_OTP') === 'true' &&
      code === (this.configService?.get('MOCK_OTP_CODE') ?? '0000')
    ) {
      return { valid: true };
    }

    const candidate = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidate || candidate.expiresAt < new Date()) {
      return { valid: false };
    }

    const matches = await bcrypt.compare(code, candidate.codeHash);
    if (!matches) {
      return { valid: false };
    }

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    return { valid: true, email: candidate.email };
  }
}
