import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './console-otp.provider';
import { OTP_PROVIDERS } from './otp-provider.interface';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  providers: [
    OtpService,
    ConsoleOtpProvider,
    {
      provide: OTP_PROVIDERS,
      useFactory: (consoleProvider: ConsoleOtpProvider) => [consoleProvider],
      inject: [ConsoleOtpProvider],
    },
  ],
  exports: [OtpService],
})
export class OtpModule {}
