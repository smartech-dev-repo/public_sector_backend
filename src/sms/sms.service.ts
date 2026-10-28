import { Inject, Injectable, Logger } from '@nestjs/common';
import { SMS_CHANNELS_BY_TYPE, SMS_PROVIDERS_BY_TYPE, SmsChannel, SmsProvider } from './sms-provider.interface';
import { SmsType } from './sms-type';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @Inject(SMS_PROVIDERS_BY_TYPE) private readonly providers: Record<SmsType, SmsProvider>,
    @Inject(SMS_CHANNELS_BY_TYPE) private readonly channels: Record<SmsType, SmsChannel>,
  ) {}

  async send(args: { type: SmsType; phone: string; message: string }): Promise<void> {
    const provider = this.providers[args.type];
    const channel = this.channels[args.type];
    try {
      await provider.send(args.phone, args.message, channel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMS provider "${provider.name}" failed for type ${args.type}: ${msg}`);
      throw error;
    }
  }
}
