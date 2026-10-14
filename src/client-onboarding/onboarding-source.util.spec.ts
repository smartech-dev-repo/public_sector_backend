import { deriveOnboardingSource } from './onboarding-source.util';

describe('deriveOnboardingSource', () => {
  it('returns null when there is no onboarding record at all', () => {
    expect(deriveOnboardingSource(null)).toBeNull();
    expect(deriveOnboardingSource(undefined)).toBeNull();
  });

  it('returns SELF when neither onboardedById nor onboardedByAgentId is set', () => {
    expect(deriveOnboardingSource({ onboardedById: null, onboardedByAgentId: null })).toBe('SELF');
  });

  it('returns AGENT when onboardedByAgentId is set', () => {
    expect(deriveOnboardingSource({ onboardedById: null, onboardedByAgentId: 'agent-1' })).toBe('AGENT');
  });

  it('returns ADMIN when onboardedById is set and onboardedByAgentId is not', () => {
    expect(deriveOnboardingSource({ onboardedById: 'admin-1', onboardedByAgentId: null })).toBe('ADMIN');
  });
});
