import { MockFaceVerificationProvider } from './mock-face-verification.provider';

describe('MockFaceVerificationProvider', () => {
  it('returns a passing match for any pair of keys', async () => {
    const provider = new MockFaceVerificationProvider();
    const result = await provider.compare('reference-key', 'candidate-key');
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });
});
