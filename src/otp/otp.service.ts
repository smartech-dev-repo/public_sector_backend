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
import { hashPassword } from '../common/password-hash.util';

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDERS) private readonly providers: OtpProvider[],
    private readonly configService?: ConfigService,
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

  async request(phone: string): Promise<void> {
    const code = generateCode();
    const codeHash = await hashPassword(code);
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: { phone, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
    });

    await this.sendWithFailover(phone, code);
  }

  async verify(phone: string, code: string): Promise<boolean> {
    const candidate = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidate || candidate.expiresAt < new Date()) {
      return false;
    }

    const matches = await bcrypt.compare(code, candidate.codeHash);
    if (!matches) {
      return false;
    }

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    return true;
  }
}
