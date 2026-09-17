import { ConfigService } from '@nestjs/config';
import { DojahIdentityVerificationProvider } from './dojah-identity-verification.provider';

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing config: ${key}`);
      return values[key];
    },
    get: (key: string, defaultValue?: string) => (key in values ? values[key] : defaultValue),
  } as unknown as ConfigService;
}

describe('DojahIdentityVerificationProvider', () => {
  const config = fakeConfig({ DOJAH_APP_ID: 'app-id', DOJAH_SECRET_KEY: 'secret' });
  let provider: DojahIdentityVerificationProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    provider = new DojahIdentityVerificationProvider(config);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('calls the advance BVN endpoint with the correct headers and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number1: '08000000000',
          image: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: 'ZmFrZS1waG90bw==',
    });
  });

  it('calls the advance NIN endpoint and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number: '08000000000',
          photo: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupNin('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/nin/advance?nin=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result.photoBase64).toBe('ZmFrZS1waG90bw==');
  });

  it('throws when Dojah returns a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(provider.lookupBvn('12345678901')).rejects.toThrow('404');
  });

  it('uses DOJAH_BASE_URL when set (e.g. production)', async () => {
    const prodConfig = fakeConfig({
      DOJAH_APP_ID: 'app-id',
      DOJAH_SECRET_KEY: 'secret',
      DOJAH_BASE_URL: 'https://api.dojah.io',
    });
    const prodProvider = new DojahIdentityVerificationProvider(prodConfig);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ entity: { first_name: 'A', last_name: 'B', date_of_birth: null, phone_number1: null, image: 'x' } }),
    });

    await prodProvider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      expect.anything(),
    );
  });
});
