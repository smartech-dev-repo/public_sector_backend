import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PrincipalRef {
  type: string;
  id: string | null;
}

export type ResolvedPrincipal = Record<string, unknown> | null;

interface RegistryEntry {
  findMany: (prisma: PrismaService, ids: string[]) => Promise<Array<{ id: string } & Record<string, unknown>>>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  ADMIN: {
    findMany: (p, ids) =>
      p.adminUser.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true, email: true, role: { select: { name: true } } },
      }),
  },
  AGENT: {
    findMany: (p, ids) =>
      p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  CLIENT: {
    findMany: (p, ids) =>
      p.client.findMany({
        where: { id: { in: ids } },
        select: { id: true, phone: true, status: true, onboarding: { select: { employeeName: true } } },
      }),
  },
  AdminUser: {
    findMany: (p, ids) =>
      p.adminUser.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true, email: true, role: { select: { name: true } } },
      }),
  },
  Agent: {
    findMany: (p, ids) =>
      p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  Client: {
    findMany: (p, ids) =>
      p.client.findMany({
        where: { id: { in: ids } },
        select: { id: true, phone: true, status: true, onboarding: { select: { employeeName: true } } },
      }),
  },
  AdminInvite: {
    findMany: (p, ids) =>
      p.adminInvite.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, status: true } }),
  },
  Department: {
    findMany: (p, ids) => p.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  },
  LoanRequest: {
    findMany: (p, ids) =>
      p.loanRequest.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, status: true } }),
  },
  Permission: {
    findMany: (p, ids) => p.permission.findMany({ where: { id: { in: ids } }, select: { id: true, key: true } }),
  },
  ManagementFee: {
    findMany: (p, ids) => p.managementFee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  },
  LoanProduct: {
    findMany: (p, ids) =>
      p.loanProduct.findMany({ where: { id: { in: ids } }, select: { id: true, productName: true, productCode: true } }),
  },
  DocumentUploadBatch: {
    findMany: (p, ids) =>
      p.documentUploadBatch.findMany({
        where: { id: { in: ids } },
        select: { id: true, originalFileName: true, documentType: true, status: true },
      }),
  },
  Role: {
    findMany: (p, ids) => p.role.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  },
  IppisRecord: {
    findMany: (p, ids) =>
      p.ippisRecord.findMany({
        where: { id: { in: ids } },
        select: { id: true, staffId: true, employeeName: true, agency: true },
      }),
  },
};

@Injectable()
export class PrincipalResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ids of the admins, agents and clients whose name, email or phone contains `q`. */
  async searchIds(q: string): Promise<Record<'ADMIN' | 'AGENT' | 'CLIENT', string[]>> {
    const match = { contains: q, mode: 'insensitive' as const };
    const take = 500;
    const select = { id: true };
    const [admins, agents, clients] = await Promise.all([
      this.prisma.adminUser.findMany({ where: { OR: [{ email: match }, { fullName: match }] }, select, take }),
      this.prisma.agent.findMany({ where: { OR: [{ email: match }, { fullName: match }, { phone: match }] }, select, take }),
      this.prisma.client.findMany({
        where: { OR: [{ phone: match }, { email: match }, { onboarding: { employeeName: match } }] },
        select,
        take,
      }),
    ]);
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    return { ADMIN: ids(admins), AGENT: ids(agents), CLIENT: ids(clients) };
  }

  async resolveMany(refs: PrincipalRef[]): Promise<Map<string, ResolvedPrincipal>> {
    const byType = new Map<string, Set<string>>();
    for (const ref of refs) {
      if (!ref.id || !REGISTRY[ref.type]) continue;
      if (!byType.has(ref.type)) byType.set(ref.type, new Set());
      byType.get(ref.type)!.add(ref.id);
    }

    const result = new Map<string, ResolvedPrincipal>();
    await Promise.all(
      Array.from(byType.entries()).map(async ([type, idSet]) => {
        const rows = await REGISTRY[type].findMany(this.prisma, Array.from(idSet));
        for (const row of rows) {
          result.set(`${type}:${row.id}`, row);
        }
      }),
    );
    return result;
  }
}
