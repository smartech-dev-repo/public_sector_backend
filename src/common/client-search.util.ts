import { Prisma } from '../generated/prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phones are stored as +234…, so "0803 123 4567", "2348031234567" and
 * "8031234567" all reduce to the national digits that the stored value contains.
 */
export function phoneDigits(term: string): string | null {
  // Only a phone-looking term is a phone search, so "Ada 0803" or an IPPIS number
  // with letters doesn't also match every phone containing its digits.
  if (!/^[\d\s()+-]+$/.test(term.trim())) return null;
  let digits = term.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 4 ? digits : null;
}

/** Finds a client by what admins actually know: name, phone, email, IPPIS number, or the ID itself. */
export function clientSearchWhere(term?: string): Prisma.ClientWhereInput | undefined {
  const q = term?.trim();
  if (!q) return undefined;
  const text = { contains: q, mode: 'insensitive' as const };
  const digits = phoneDigits(q);
  const or: Prisma.ClientWhereInput[] = [
    { email: text },
    { onboarding: { employeeName: text } },
    { onboarding: { ippisRecord: { staffId: text } } },
    { onboarding: { ippisRecord: { employeeName: text } } },
  ];
  if (digits) or.push({ phone: { contains: digits } });
  if (UUID.test(q)) or.push({ id: q });
  return { OR: or };
}

/** Finds an agent by name, email, phone or ID. */
export function agentSearchWhere(term?: string): Prisma.AgentWhereInput | undefined {
  const q = term?.trim();
  if (!q) return undefined;
  const text = { contains: q, mode: 'insensitive' as const };
  const digits = phoneDigits(q);
  const or: Prisma.AgentWhereInput[] = [{ fullName: text }, { email: text }];
  if (digits) or.push({ phone: { contains: digits } });
  if (UUID.test(q)) or.push({ id: q });
  return { OR: or };
}

/** Combines optional client conditions; undefined when there are none. */
export function allOf(...parts: Array<Prisma.ClientWhereInput | undefined>): Prisma.ClientWhereInput | undefined {
  const present = parts.filter((part): part is Prisma.ClientWhereInput => !!part);
  return present.length ? { AND: present } : undefined;
}
