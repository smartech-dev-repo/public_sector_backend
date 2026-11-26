import * as bcrypt from 'bcrypt';
import { getPasswordHashRounds, hashPassword } from './password-hash.util';

describe('getPasswordHashRounds', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to 12 when PASSWORD_HASH_ROUNDS is unset', () => {
    delete process.env.PASSWORD_HASH_ROUNDS;
    delete process.env.NODE_ENV;
    expect(getPasswordHashRounds()).toBe(12);
  });

  it('uses the configured value outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.PASSWORD_HASH_ROUNDS = '4';
    expect(getPasswordHashRounds()).toBe(4);
  });

  it('throws when a below-minimum value is configured for production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PASSWORD_HASH_ROUNDS = '4';
    expect(() => getPasswordHashRounds()).toThrow(/below the minimum safe value/);
  });

  it('allows a safe value in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PASSWORD_HASH_ROUNDS = '12';
    expect(getPasswordHashRounds()).toBe(12);
  });
});

describe('hashPassword', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('produces a bcrypt hash that verifies against the plaintext', async () => {
    delete process.env.NODE_ENV;
    process.env.PASSWORD_HASH_ROUNDS = '4';
    const hash = await hashPassword('correct-password');
    expect(await bcrypt.compare('correct-password', hash)).toBe(true);
  });
});
