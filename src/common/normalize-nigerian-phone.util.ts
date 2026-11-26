// IPPIS payroll files carry phone numbers in mixed shapes, often bare 10-digit
// local numbers (no leading 0, no country code) — e.g. "8038847641" — while this
// app standardizes on E.164 Nigerian format ("+2348038847641"), which
// is what class-validator's @IsPhoneNumber() on the client-facing OTP DTOs
// requires. Anything that creates a Client from IPPIS data must normalize
// through here first, or that client's phone silently diverges from the
// format every other lookup/match in the app expects.
export function normalizeNigerianPhone(raw: string): string {
  // Covers 0803..., 234803..., 00234... and the common +234 0803... mistake.
  const localNumber = /^(?:00)?(?:234)?0?(\d{10})$/.exec(raw.replace(/\D/g, ''))?.[1];
  if (localNumber) {
    return `+234${localNumber}`;
  }

  const digitsOnly = raw.replace(/[^\d+]/g, '');
  if (digitsOnly.startsWith('+234')) {
    return digitsOnly;
  }
  if (digitsOnly.startsWith('234')) {
    return `+${digitsOnly}`;
  }
  if (digitsOnly.startsWith('0')) {
    return `+234${digitsOnly.slice(1)}`;
  }
  return `+234${digitsOnly}`;
}

export const NIGERIAN_MOBILE = /^\+234[789][01]\d{8}$/;

/** The +234 form of a number, or null when it isn't one valid Nigerian mobile. */
export function validNigerianPhone(raw: string): string | null {
  const phone = normalizeNigerianPhone(raw);
  return NIGERIAN_MOBILE.test(phone) ? phone : null;
}

export function phonesTally(a: string | null, b: string | null): boolean {
  return Boolean(a && b) && normalizeNigerianPhone(a as string) === normalizeNigerianPhone(b as string);
}

// A number that can't be read as valid stays on the IPPIS record as uploaded, so
// a stored-value lookup has to compare on the local number rather than E.164.
export function ippisPhoneFilter(phone: string): { endsWith: string } {
  return { endsWith: normalizeNigerianPhone(phone).slice(-10) };
}
