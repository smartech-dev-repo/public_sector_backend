import { InternalServerErrorException } from '@nestjs/common';
import { IdentityVerificationService } from './identity-verification.service';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

function fakeProvider(name: string, impl: Partial<IdentityVerificationProvider>): IdentityVerificationProvider {
  return {
    name,
    lookupBvn: impl.lookupBvn ?? jest.fn().mockRejectedValue(new Error('not implemented')),
    lookupNin: impl.lookupNin ?? jest.fn().mockRejectedValue(new Error('not implemented')),
  };
}

const sampleResult: IdentityLookupResult = {
  firstName: 'Jane',
  lastName: 'Doe',
  dateOfBirth: '1990-01-01',
  phoneNumber: '08000000000',
  photoBase64: 'ZmFrZS1waG90bw==',
};

describe('IdentityVerificationService', () => {
  it('returns the first provider\'s successful BVN lookup', async () => {
    const provider = fakeProvider('primary', { lookupBvn: jest.fn().mockResolvedValue(sampleResult) });
    const service = new IdentityVerificationService([provider]);

    const result = await service.lookupBvn('12345678901');
    expect(result).toEqual(sampleResult);
  });

  it('falls through to the next provider in the list on failure', async () => {
    const failing = fakeProvider('primary', { lookupNin: jest.fn().mockRejectedValue(new Error('timeout')) });
    const backup = fakeProvider('backup', { lookupNin: jest.fn().mockResolvedValue(sampleResult) });
    const service = new IdentityVerificationService([failing, backup]);

    const result = await service.lookupNin('12345678901');
    expect(result).toEqual(sampleResult);
  });

  it('throws once every provider has failed', async () => {
    const failing = fakeProvider('only', { lookupBvn: jest.fn().mockRejectedValue(new Error('down')) });
    const service = new IdentityVerificationService([failing]);

    await expect(service.lookupBvn('12345678901')).rejects.toThrow(InternalServerErrorException);
  });
});
