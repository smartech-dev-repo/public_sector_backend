// IPPIS payroll data stores phone numbers as bare 10-digit local numbers
// (no leading 0, no country code) — e.g. "8038847641" — while the rest of
// this app standardizes on E.164 Nigerian format ("+2348038847641"), which
// is what class-validator's @IsPhoneNumber() on the client-facing OTP DTOs
// requires. Anything that creates a Client from IPPIS data must normalize
// through here first, or that client's phone silently diverges from the
// format every other lookup/match in the app expects.
export function normalizeNigerianPhone(raw: string): string {
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
