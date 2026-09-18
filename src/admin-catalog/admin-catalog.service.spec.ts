import { AdminCatalogService } from './admin-catalog.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminCatalogService', () => {
  let service: AdminCatalogService;
  let prisma: { loan: { findMany: jest.Mock }; ippisRecord: { findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { loan: { findMany: jest.fn() }, ippisRecord: { findMany: jest.fn() } };
    service = new AdminCatalogService(prisma as unknown as PrismaService);
  });

  describe('listLoans', () => {
    it('lists every loan when no agency filter is given', async () => {
      prisma.loan.findMany.mockResolvedValue([]);
      await service.listLoans();
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters by agency when given', async () => {
      prisma.loan.findMany.mockResolvedValue([]);
      await service.listLoans('NPF');
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF' } }),
      );
    });
  });

  describe('listIppisRecords', () => {
    it('lists every record when no agency filter is given', async () => {
      prisma.ippisRecord.findMany.mockResolvedValue([]);
      await service.listIppisRecords();
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters by agency when given', async () => {
      prisma.ippisRecord.findMany.mockResolvedValue([]);
      await service.listIppisRecords('NSCDC');
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NSCDC' } }),
      );
    });
  });
});
