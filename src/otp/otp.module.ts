import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { EmailModule } from '../email/email.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [EmailModule, SmsModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
