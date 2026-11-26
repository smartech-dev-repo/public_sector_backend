import { AdminCatalogService } from './admin-catalog.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminCatalogService', () => {
  let service: AdminCatalogService;
  let prisma: {
    loan: { findMany: jest.Mock; count: jest.Mock };
    ippisRecord: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loan: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      ippisRecord: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    service = new AdminCatalogService(prisma as unknown as PrismaService);
  });

  describe('listLoans', () => {
    it('lists every loan when no filters are given, defaulting to page 1/limit 25', async () => {
      const result = await service.listLoans();
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: undefined, product: undefined }), skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency and product when given', async () => {
      await service.listLoans({ agency: 'NPF', product: 'Salary Advance' });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: 'NPF', product: 'Salary Advance' }) }),
      );
    });

    it('applies a case-insensitive search across customerName, accountNumber, and ippisNumber', async () => {
      await service.listLoans({ q: 'okoro' });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { customerName: { contains: 'okoro', mode: 'insensitive' } },
              { accountNumber: { contains: 'okoro', mode: 'insensitive' } },
              { ippisNumber: { contains: 'okoro', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies the disbursement date range filter', async () => {
      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');
      await service.listLoans({ disbursedFrom, disbursedTo });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ disbursementDate: { gte: disbursedFrom, lte: disbursedTo } }) }),
      );
    });

    it('computes skip/take from page and limit', async () => {
      prisma.loan.count.mockResolvedValue(53);
      const result = await service.listLoans({}, { page: 3, limit: 20 });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
      expect(result.meta).toEqual({ total: 53, page: 3, limit: 20, totalPages: 3 });
    });
  });

  describe('listIppisRecords', () => {
    it('lists every record when no filters are given, defaulting to page 1/limit 25', async () => {
      const result = await service.listIppisRecords();
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: undefined }), skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency, employeeStatus, department, and grade when given', async () => {
      await service.listIppisRecords({ agency: 'NSCDC', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-10' });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agency: 'NSCDC', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-10' }),
        }),
      );
    });

    it('applies a case-insensitive search across employeeName and staffId', async () => {
      await service.listIppisRecords({ q: 'chidi' });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { employeeName: { contains: 'chidi', mode: 'insensitive' } },
              { staffId: { contains: 'chidi', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies the hireDate range filter', async () => {
      const hireDateFrom = new Date('2010-01-01');
      const hireDateTo = new Date('2020-01-01');
      await service.listIppisRecords({ hireDateFrom, hireDateTo });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ hireDate: { gte: hireDateFrom, lte: hireDateTo } }) }),
      );
    });
  });
});
