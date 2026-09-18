export type PrincipalType = 'admin' | 'agent' | 'client';

export interface JwtPayload {
  sub: string;
  type: PrincipalType;
  permissions?: string[];
  mustChangePassword?: boolean;
}
