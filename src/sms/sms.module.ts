import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { ConsoleSmsProvider } from './console-sms.provider';
import { TermiiSmsProvider } from './termii-sms.provider';
import { SMS_CHANNELS_BY_TYPE, SMS_PROVIDERS_BY_TYPE, SmsChannel, SmsProvider } from './sms-provider.interface';
import { SmsType } from './sms-type';

@Module({
  providers: [
    SmsService,
    ConsoleSmsProvider,
    TermiiSmsProvider,
    {
      provide: SMS_PROVIDERS_BY_TYPE,
      useFactory: (
        config: ConfigService,
        console_: ConsoleSmsProvider,
        termii: TermiiSmsProvider,
      ): Record<SmsType, SmsProvider> => {
        // `||`, not `??` -- an unset override in .env (e.g. `SMS_OTP_PROVIDER=`)
        // resolves to an empty string, not undefined, so `??` would never
        // fall through to the SMS_PROVIDER default.
        const resolve = (envVar: string): SmsProvider => {
          const name = config.get<string>(envVar) || config.get<string>('SMS_PROVIDER', 'console');
          return name === 'termii' ? termii : console_;
        };
        return {
          [SmsType.OTP]: resolve('SMS_OTP_PROVIDER'),
          [SmsType.LOAN_CONFIRMATION]: resolve('SMS_LOAN_CONFIRMATION_PROVIDER'),
          [SmsType.NOTIFICATION]: resolve('SMS_NOTIFICATION_PROVIDER'),
        };
      },
      inject: [ConfigService, ConsoleSmsProvider, TermiiSmsProvider],
    },
    {
      provide: SMS_CHANNELS_BY_TYPE,
      useFactory: (config: ConfigService): Record<SmsType, SmsChannel> => {
        const resolve = (envVar: string): SmsChannel =>
          (config.get<string>(envVar) || config.get<string>('SMS_CHANNEL', 'dnd')) as SmsChannel;
        return {
          [SmsType.OTP]: resolve('SMS_OTP_CHANNEL'),
          [SmsType.LOAN_CONFIRMATION]: resolve('SMS_LOAN_CONFIRMATION_CHANNEL'),
          [SmsType.NOTIFICATION]: resolve('SMS_NOTIFICATION_CHANNEL'),
        };
      },
      inject: [ConfigService],
    },
  ],
  exports: [SmsService],
})
export class SmsModule {}
