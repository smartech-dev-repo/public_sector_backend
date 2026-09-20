import * as bcrypt from 'bcrypt';

const DEFAULT_ROUNDS = 12;
const PRODUCTION_MINIMUM_ROUNDS = 10;

export function getPasswordHashRounds(): number {
  const configured = process.env.PASSWORD_HASH_ROUNDS;
  const rounds = configured ? Number(configured) : DEFAULT_ROUNDS;

  if (process.env.NODE_ENV === 'production' && rounds < PRODUCTION_MINIMUM_ROUNDS) {
    throw new Error(
      `PASSWORD_HASH_ROUNDS=${configured} is below the minimum safe value ` +
        `(${PRODUCTION_MINIMUM_ROUNDS}) for production. Refusing to start.`,
    );
  }

  return rounds;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, getPasswordHashRounds());
}
