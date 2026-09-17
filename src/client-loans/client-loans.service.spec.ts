import { ClientLoansService } from './client-loans.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClientLoansService', () => {
  let service: ClientLoansService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock };
    loan: { findMany: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn() },
      loan: { findMany: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
    };
    service = new ClientLoansService(prisma as unknown as PrismaService);
  });

  it('returns empty lists when the client has no ClientOnboarding row', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue(null);

    const result = await service.getDashboard('c1');

    expect(result).toEqual({ loans: [], repayments: [] });
    expect(prisma.loan.findMany).not.toHaveBeenCalled();
    expect(prisma.loanRepaymentRecord.findMany).not.toHaveBeenCalled();
  });

  it('matches loans and repayments by the linked IppisRecord agency+staffId', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue({
      bvn: null,
      ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
    });
    prisma.loan.findMany.mockResolvedValue([{ id: 'loan-1', bvn: null }]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([{ id: 'rep-1' }]);

    const result = await service.getDashboard('c1');

    expect(prisma.loan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agency: 'NPF', ippisNumber: 'NPF-001' } }),
    );
    expect(prisma.loanRepaymentRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agency: 'NPF', staffId: 'NPF-001' } }),
    );
    expect(result).toEqual({ loans: [{ id: 'loan-1', bvn: null }], repayments: [{ id: 'rep-1' }] });
  });

  it('applies the bvn cross-check when the client has a verified bvn on file', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue({
      bvn: '11111111111',
      ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
    });
    prisma.loan.findMany.mockResolvedValue([
      { id: 'loan-no-bvn', bvn: null },
      { id: 'loan-match', bvn: '11111111111' },
      { id: 'loan-mismatch', bvn: '99999999999' },
    ]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

    const result = await service.getDashboard('c1');

    expect(result.loans.map((loan: { id: string }) => loan.id)).toEqual(['loan-no-bvn', 'loan-match']);
  });

  it('skips the bvn cross-check entirely when the client has no verified bvn on file', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue({
      bvn: null,
      ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
    });
    prisma.loan.findMany.mockResolvedValue([{ id: 'loan-1', bvn: '22222222222' }]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

    const result = await service.getDashboard('c1');

    expect(result.loans).toEqual([{ id: 'loan-1', bvn: '22222222222' }]);
  });
});
