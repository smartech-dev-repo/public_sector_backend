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

  it('fails when the latest ClientLoan still has an outstanding balance', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1', principalBalance: 5000 });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/outstanding balance/);
    expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1' },
      orderBy: { disbursementDate: 'desc' },
    });
  });

  it('passes when the latest ClientLoan balance is 0 (closed)', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1', principalBalance: 0 });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when there is no ClientLoan row but a matched ingested loan is still outstanding', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/outstanding balance/);
  });

  it('passes when there is no ClientLoan row and the only matched ingested loan is closed', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(false);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client has no ClientLoan row and no matched ingested loan at all', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(false);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no existing loan to renew/);
  });
});
