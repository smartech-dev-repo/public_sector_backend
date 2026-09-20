import { generateEmailCode } from './generate-email-code.util';

describe('generateEmailCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateEmailCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('produces different codes across calls (not a constant)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateEmailCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
