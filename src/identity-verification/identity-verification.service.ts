import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  IDENTITY_VERIFICATION_PROVIDERS,
  IdentityLookupResult,
  IdentityVerificationProvider,
} from './identity-verification-provider.interface';

@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger(IdentityVerificationService.name);

  constructor(
    @Inject(IDENTITY_VERIFICATION_PROVIDERS) private readonly providers: IdentityVerificationProvider[],
  ) {}

  async lookupBvn(bvn: string): Promise<IdentityLookupResult> {
    return this.withFailover((provider) => provider.lookupBvn(bvn), 'BVN');
  }

  async lookupNin(nin: string): Promise<IdentityLookupResult> {
    return this.withFailover((provider) => provider.lookupNin(nin), 'NIN');
  }

  private async withFailover(
    fn: (provider: IdentityVerificationProvider) => Promise<IdentityLookupResult>,
    label: string,
  ): Promise<IdentityLookupResult> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        return await fn(provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`${label} provider "${provider.name}" failed: ${message}`);
        failures.push(`${provider.name}: ${message}`);
      }
    }

    throw new InternalServerErrorException(`All ${label} providers failed: ${failures.join('; ')}`);
  }
}
