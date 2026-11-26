import { randomInt } from 'crypto';

export function generateNumericCode(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return randomInt(min, max + 1).toString();
}
