export type OnboardingSource = 'SELF' | 'AGENT' | 'ADMIN';

export function deriveOnboardingSource(
  onboarding: { onboardedById: string | null; onboardedByAgentId: string | null } | null | undefined,
): OnboardingSource | null {
  if (!onboarding) return null;
  if (onboarding.onboardedByAgentId) return 'AGENT';
  if (onboarding.onboardedById) return 'ADMIN';
  return 'SELF';
}
