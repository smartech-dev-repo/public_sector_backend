import { PrincipalType } from '../auth/jwt-payload.interface';
import { SessionPrincipalType } from '../generated/prisma/client';

const TO_SESSION: Record<PrincipalType, SessionPrincipalType> = {
  admin: SessionPrincipalType.ADMIN,
  agent: SessionPrincipalType.AGENT,
  client: SessionPrincipalType.CLIENT,
};

const TO_JWT: Record<SessionPrincipalType, PrincipalType> = {
  [SessionPrincipalType.ADMIN]: 'admin',
  [SessionPrincipalType.AGENT]: 'agent',
  [SessionPrincipalType.CLIENT]: 'client',
};

export function toSessionPrincipalType(type: PrincipalType): SessionPrincipalType {
  return TO_SESSION[type];
}

export function toJwtPrincipalType(type: SessionPrincipalType): PrincipalType {
  return TO_JWT[type];
}
