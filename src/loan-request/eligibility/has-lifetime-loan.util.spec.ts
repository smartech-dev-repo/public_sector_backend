import { hasLifetimeLoan } from './has-lifetime-loan.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';

describe('hasLifetimeLoan', () => {
  let prisma: { clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    clientLoansService = { hasAnyMatchedLoan: jest.fn() };
  });

  it('returns true when a ClientLoan row exists, without checking ingested loans', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(true);
    expect(clientLoansService.hasAnyMatchedLoan).not.toHaveBeenCalled();
  });

  it('falls back to checking matched ingested loans when no ClientLoan row exists', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(true);
  });

  it('returns false when neither a ClientLoan row nor a matched ingested loan exists', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(false);
  });
});
