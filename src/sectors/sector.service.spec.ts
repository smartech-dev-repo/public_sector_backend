import { BadRequestException, ConflictException } from '@nestjs/common';
import { SectorService } from './sector.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SectorService', () => {
  let prisma: {
    sector: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    ippisRecord: { count: jest.Mock };
    loanProduct: { count: jest.Mock };
  };
  let service: SectorService;

  beforeEach(() => {
    prisma = {
      sector: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 's1', code: 'FRSC' }),
        create: jest.fn().mockResolvedValue({ id: 's1', code: 'FRSC' }),
        update: jest.fn(),
        delete: jest.fn(),
      },
      ippisRecord: { count: jest.fn().mockResolvedValue(0) },
      loanProduct: { count: jest.fn().mockResolvedValue(0) },
    };
    service = new SectorService(prisma as unknown as PrismaService);
  });

  it('stores one spelling of a code', async () => {
    await service.create({ code: '  lagos   state ', name: 'Lagos' });
    expect(prisma.sector.create).toHaveBeenCalledWith({ data: { code: 'LAGOS STATE', name: 'Lagos' } });
  });

  it('refuses a name that could only be a spreadsheet default', async () => {
    await expect(service.create({ code: 'Sheet1' })).rejects.toThrow(BadRequestException);
  });

  it('gives a clear message for a duplicate', async () => {
    prisma.sector.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(service.create({ code: 'NPF' })).rejects.toThrow('Sector NPF already exists');
  });

  it('refuses to remove a sector in use', async () => {
    prisma.ippisRecord.count.mockResolvedValue(3);
    await expect(service.remove('s1')).rejects.toThrow(ConflictException);
    expect(prisma.sector.delete).not.toHaveBeenCalled();
  });

  it('removes an unused sector', async () => {
    await service.remove('s1');
    expect(prisma.sector.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });
});
