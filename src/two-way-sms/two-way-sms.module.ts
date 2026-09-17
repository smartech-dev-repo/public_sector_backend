import { Module } from '@nestjs/common';
import { MockTwoWaySmsProvider } from './mock-two-way-sms.provider';
import { TWO_WAY_SMS_PROVIDER } from './two-way-sms-provider.interface';

@Module({
  providers: [
    MockTwoWaySmsProvider,
    // Single-provider for now (per the spec — no second vendor exists yet),
    // matching FaceVerificationModule's own no-failover-list precedent.
    { provide: TWO_WAY_SMS_PROVIDER, useExisting: MockTwoWaySmsProvider },
  ],
  exports: [TWO_WAY_SMS_PROVIDER],
})
export class TwoWaySmsModule {}
