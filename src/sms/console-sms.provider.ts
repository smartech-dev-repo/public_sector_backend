import { Injectable, Logger } from '@nestjs/common';
import { SmsChannel, SmsProvider } from './sms-provider.interface';

@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  async send(phone: string, message: string, channel: SmsChannel): Promise<void> {
    this.logger.log(`[${channel}] SMS to ${phone}: ${message}`);
  }
}
