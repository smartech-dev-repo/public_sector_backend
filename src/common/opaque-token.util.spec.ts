import { generateOpaqueToken, hashToken } from './opaque-token.util';

describe('opaque-token.util', () => {
  it('generates high-entropy, unique tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();

    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes deterministically', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toEqual(hashToken(token));
  });

  it('produces different hashes for different tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(hashToken(a)).not.toEqual(hashToken(b));
  });
});
