import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { Sector } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canBeSectorName, normalizeSectorCode } from './sector-code.util';

@Injectable()
export class SectorService {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<Sector[]> {
    return this.prisma.sector.findMany({ orderBy: { code: 'asc' } });
  }

  async codes(): Promise<string[]> {
    return (await this.list()).map((sector) => sector.code);
  }

  async create(input: { code: string; name?: string }): Promise<Sector> {
    const code = normalizeSectorCode(input.code);
    if (!canBeSectorName(code)) {
      throw new BadRequestException(`"${code}" cannot be a sector. Use the name the sector's sheet will have`);
    }
    try {
      return await this.prisma.sector.create({ data: { code, name: input.name } });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`Sector ${code} already exists`);
      }
      throw error;
    }
  }

  // Only the display name changes: the code is what records and products hold.
  async updateName(id: string, name: string | undefined): Promise<{ before: Sector; after: Sector }> {
    const before = await this.findById(id);
    const after = await this.prisma.sector.update({ where: { id }, data: { name } });
    return { before, after };
  }

  async remove(id: string): Promise<Sector> {
    const sector = await this.findById(id);
    const [records, products] = await Promise.all([
      this.prisma.ippisRecord.count({ where: { agency: sector.code } }),
      this.prisma.loanProduct.count({ where: { sectors: { has: sector.code } } }),
    ]);
    if (records > 0 || products > 0) {
      throw new ConflictException(`Sector ${sector.code} is in use by ${records} staff records and ${products} loan products`);
    }
    await this.prisma.sector.delete({ where: { id } });
    return sector;
  }

  private async findById(id: string): Promise<Sector> {
    const sector = await this.prisma.sector.findUnique({ where: { id } });
    if (!sector) {
      throw new NotFoundException('Sector not found');
    }
    return sector;
  }
}
