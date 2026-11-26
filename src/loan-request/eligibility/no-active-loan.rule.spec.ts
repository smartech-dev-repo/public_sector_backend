import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoActiveLoanRule', () => {
  let rule: NoActiveLoanRule;
  let prisma: { loanRequest: { findFirst: jest.Mock }; clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    clientLoansService = {
      hasAnyMatchedLoan: jest.fn().mockResolvedValue(false),
    };
    rule = new NoActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('passes when there is no in-progress request and no lifetime loan on record', async () => {
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client already has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/in progress/);
  });

  it('fails when the client already has a ClientLoan row, regardless of its status', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/already taken a loan/);
  });

  it('fails when the client has a matched ingested loan, regardless of its status', async () => {
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/already taken a loan/);
  });
});
