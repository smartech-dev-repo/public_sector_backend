import { Injectable } from '@nestjs/common';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

const PLACEHOLDER_PHOTO_BASE64 = Buffer.from('mock-identity-photo').toString('base64');

@Injectable()
export class MockIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'mock';

  async lookupBvn(_bvn: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
      gender: 'Female',
      stateOfOrigin: 'Lagos',
      lgaOfOrigin: 'Ikeja',
      stateOfResidence: 'Lagos',
      lgaOfResidence: 'Ikeja',
      maritalStatus: 'Single',
      address: null,
      city: null,
    };
  }

  async lookupNin(_nin: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
      gender: 'Female',
      stateOfOrigin: null,
      lgaOfOrigin: null,
      stateOfResidence: null,
      lgaOfResidence: null,
      maritalStatus: null,
      address: '1 Mock Street',
      city: 'Mocktown',
    };
  }
}
