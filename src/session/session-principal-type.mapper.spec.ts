import { toSessionPrincipalType, toJwtPrincipalType } from './session-principal-type.mapper';
import { SessionPrincipalType } from '../generated/prisma/client';

describe('session-principal-type.mapper', () => {
  it('maps every JWT principal type to its Session enum value', () => {
    expect(toSessionPrincipalType('admin')).toBe(SessionPrincipalType.ADMIN);
    expect(toSessionPrincipalType('agent')).toBe(SessionPrincipalType.AGENT);
    expect(toSessionPrincipalType('client')).toBe(SessionPrincipalType.CLIENT);
  });

  it('maps every Session enum value back to its JWT principal type', () => {
    expect(toJwtPrincipalType(SessionPrincipalType.ADMIN)).toBe('admin');
    expect(toJwtPrincipalType(SessionPrincipalType.AGENT)).toBe('agent');
    expect(toJwtPrincipalType(SessionPrincipalType.CLIENT)).toBe('client');
  });
});
