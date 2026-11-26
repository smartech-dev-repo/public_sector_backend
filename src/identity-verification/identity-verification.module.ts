import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityVerificationService } from './identity-verification.service';
import { MockIdentityVerificationProvider } from './mock-identity-verification.provider';
import { DojahIdentityVerificationProvider } from './dojah-identity-verification.provider';
import { IDENTITY_VERIFICATION_PROVIDERS } from './identity-verification-provider.interface';

@Module({
  providers: [
    IdentityVerificationService,
    MockIdentityVerificationProvider,
    DojahIdentityVerificationProvider,
    {
      provide: IDENTITY_VERIFICATION_PROVIDERS,
      // Exactly one active provider, chosen by config — never both in the
      // same list. See Task 2's design note: blending mock and real here
      // would risk silently "verifying" a client with fabricated data if
      // the real vendor ever failed.
      useFactory: (
        configService: ConfigService,
        mock: MockIdentityVerificationProvider,
        dojah: DojahIdentityVerificationProvider,
      ) => {
        const selected = configService.get<string>('IDENTITY_VERIFICATION_PROVIDER', 'mock');
        return selected === 'dojah' ? [dojah] : [mock];
      },
      inject: [ConfigService, MockIdentityVerificationProvider, DojahIdentityVerificationProvider],
    },
  ],
  exports: [IdentityVerificationService],
})
export class IdentityVerificationModule {}
