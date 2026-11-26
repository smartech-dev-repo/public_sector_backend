import { generateNumericCode } from './generate-numeric-code.util';

describe('generateNumericCode', () => {
  it('returns a string of exactly 4 digits when length is 4', () => {
    expect(generateNumericCode(4)).toMatch(/^\d{4}$/);
  });

  it('returns a string of exactly 6 digits when length is 6', () => {
    expect(generateNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('returns a string of exactly 8 digits when length is 8', () => {
    expect(generateNumericCode(8)).toMatch(/^\d{8}$/);
  });

  it('never collapses a small random value into a shorter string', () => {
    const codes = Array.from({ length: 200 }, () => generateNumericCode(4));
    expect(codes.every((code) => code.length === 4)).toBe(true);
  });

  it('produces different codes across calls', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateNumericCode(6)));
    expect(codes.size).toBeGreaterThan(1);
  });
});
