import { ConfigService } from '@nestjs/config';
import { buildFrom } from './email-from.util';

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('buildFrom', () => {
  it('reads EMAIL_FROM_NAME and EMAIL_FROM into a {name, address} sender', () => {
    const config = fakeConfig({ EMAIL_FROM_NAME: 'Public Sector Backend', EMAIL_FROM: 'no-reply@example.com' });
    expect(buildFrom(config)).toEqual({ name: 'Public Sector Backend', address: 'no-reply@example.com' });
  });

  it('throws when EMAIL_FROM is missing', () => {
    const config = fakeConfig({ EMAIL_FROM_NAME: 'Public Sector Backend' });
    expect(() => buildFrom(config)).toThrow('Missing config: EMAIL_FROM');
  });

  it('throws when EMAIL_FROM_NAME is missing', () => {
    const config = fakeConfig({ EMAIL_FROM: 'no-reply@example.com' });
    expect(() => buildFrom(config)).toThrow('Missing config: EMAIL_FROM_NAME');
  });
});
