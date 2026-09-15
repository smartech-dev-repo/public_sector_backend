import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ConsoleEmailProvider } from './console-email.provider';
import { EMAIL_PROVIDERS } from './email-provider.interface';

@Module({
  providers: [
    EmailService,
    ConsoleEmailProvider,
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (consoleProvider: ConsoleEmailProvider) => [consoleProvider],
      inject: [ConsoleEmailProvider],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
