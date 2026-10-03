import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { ConsoleEmailProvider } from './console-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';
import { SendGridEmailProvider } from './sendgrid-email.provider';
import { EMAIL_PROVIDERS, EmailProvider } from './email-provider.interface';

@Module({
  providers: [
    EmailService,
    ConsoleEmailProvider,
    SmtpEmailProvider,
    SendGridEmailProvider,
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (
        configService: ConfigService,
        consoleProvider: ConsoleEmailProvider,
        smtp: SmtpEmailProvider,
        sendgrid: SendGridEmailProvider,
      ): EmailProvider[] => {
        const provider = configService.get<string>('EMAIL_PROVIDER', 'console');
        if (provider === 'smtp') return [smtp];
        if (provider === 'sendgrid') return [sendgrid];
        return [consoleProvider];
      },
      inject: [ConfigService, ConsoleEmailProvider, SmtpEmailProvider, SendGridEmailProvider],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
