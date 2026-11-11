import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SMS_CHANNELS_BY_TYPE, SMS_PROVIDERS_BY_TYPE, SmsChannel, SmsProvider } from './sms-provider.interface';
import { SmsType } from './sms-type';

/** What the caller is told when a text can't be sent. The provider's own error is only logged. */
export const SMS_FAILED_MESSAGES: Record<SmsType, string> = {
  [SmsType.OTP]: "We couldn't send the confirmation code. Please try again shortly",
  [SmsType.LOAN_CONFIRMATION]: "We couldn't send the confirmation code. Please try again shortly",
  [SmsType.NOTIFICATION]: "We couldn't send the text message. Please try again shortly",
};

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @Inject(SMS_PROVIDERS_BY_TYPE) private readonly providers: Record<SmsType, SmsProvider>,
    @Inject(SMS_CHANNELS_BY_TYPE) private readonly channels: Record<SmsType, SmsChannel>,
  ) {}

  /**
   * Sends one text. A provider failure is logged with its real cause and surfaces as a 503,
   * so the request it was part of fails with a message the user can act on, not a 500.
   */
  async send(args: { type: SmsType; phone: string; message: string }): Promise<void> {
    const provider = this.providers[args.type];
    const channel = this.channels[args.type];
    try {
      await provider.send(args.phone, args.message, channel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMS provider "${provider.name}" failed for type ${args.type}: ${msg}`);
      throw new ServiceUnavailableException(SMS_FAILED_MESSAGES[args.type], {
        cause: error,
        description: 'Service Unavailable',
      });
    }
  }
}
