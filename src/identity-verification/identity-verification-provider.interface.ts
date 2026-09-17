export const IDENTITY_VERIFICATION_PROVIDERS = Symbol('IDENTITY_VERIFICATION_PROVIDERS');

export interface IdentityLookupResult {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  photoBase64: string;
}

export interface IdentityVerificationProvider {
  readonly name: string;
  lookupBvn(bvn: string): Promise<IdentityLookupResult>;
  lookupNin(nin: string): Promise<IdentityLookupResult>;
}
