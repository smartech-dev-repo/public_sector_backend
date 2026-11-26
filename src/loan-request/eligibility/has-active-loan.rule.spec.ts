import { HasActiveLoanRule } from './has-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('HasActiveLoanRule', () => {
  let rule: HasActiveLoanRule;
  let prisma: { clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasOutstandingMatchedLoan: jest.Mock; hasAnyMatchedLoan: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    clientLoansService = {
      hasOutstandingMatchedLoan: jest.fn().mockResolvedValue(false),
      hasAnyMatchedLoan: jest.fn().mockResolvedValue(false),
    };
    rule = new HasActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('passes while the latest app loan still has a balance: a top-up can happen at any time', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    expect((await rule.check(client, ippisRecord, 1000)).eligible).toBe(true);
  });

  it('passes with no app loan but an imported loan, open or closed', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);
    expect((await rule.check(client, ippisRecord, 1000)).eligible).toBe(true);
  });

  it('fails when the client has no loan at all', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no existing loan to renew/);
  });
});
