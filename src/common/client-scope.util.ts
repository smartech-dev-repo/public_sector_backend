import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { JwtPayload } from '../auth/jwt-payload.interface';

/** Holders see every client. Without it an admin sees only the clients they onboarded or created. */
export const ALL_CLIENT_RECORDS = 'clients:all-records';

/** The clients this admin may see, or undefined for all of them. */
export function clientScope(user?: Pick<JwtPayload, 'sub' | 'permissions'>): Prisma.ClientWhereInput | undefined {
  if (!user || user.permissions?.includes(ALL_CLIENT_RECORDS)) return undefined;
  return { OR: [{ createdById: user.sub }, { onboarding: { onboardedById: user.sub } }] };
}

/** Prisma's minimal surface for the check, so any service can call it. */
interface ClientCounter {
  client: { count(args: { where: Prisma.ClientWhereInput }): Promise<number> };
}

/** 404 rather than 403, so an admin can't learn which clients exist outside their scope. */
export async function assertClientInScope(
  prisma: ClientCounter,
  user: Pick<JwtPayload, 'sub' | 'permissions'> | undefined,
  clientId: string,
): Promise<void> {
  const scope = clientScope(user);
  if (!scope) return;
  const visible = await prisma.client.count({ where: { AND: [{ id: clientId }, scope] } });
  if (!visible) throw new NotFoundException('Client not found');
}
