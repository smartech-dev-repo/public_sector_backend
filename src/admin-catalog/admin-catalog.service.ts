import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listLoans(agency?: string) {
    return this.prisma.loan.findMany({
      where: agency ? { agency } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listIppisRecords(agency?: string) {
    return this.prisma.ippisRecord.findMany({
      where: agency ? { agency } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
}
