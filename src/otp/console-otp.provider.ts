import { Injectable, Logger } from '@nestjs/common';
import { OtpProvider } from './otp-provider.interface';

@Injectable()
export class ConsoleOtpProvider implements OtpProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleOtpProvider.name);

  async send(phone: string, code: string): Promise<void> {
    this.logger.log(`OTP for ${phone}: ${code}`);
  }
}
