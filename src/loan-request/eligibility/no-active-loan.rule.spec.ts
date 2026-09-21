import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoActiveLoanRule', () => {
  let rule: NoActiveLoanRule;
  let prisma: { loanRequest: { findFirst: jest.Mock }; clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { getDashboard: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    clientLoansService = { getDashboard: jest.fn().mockResolvedValue({ loans: [], repayments: [] }) };
    rule = new NoActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('passes when there is no in-progress request, active ClientLoan, or active ingested loan', async () => {
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client already has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/in progress/);
  });

  it('fails when the client already has an ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/active loan/);
  });

  it('fails when the client has an ACTIVE ingested loan', async () => {
    clientLoansService.getDashboard.mockResolvedValue({ loans: [{ id: 'loan-1', status: 'ACTIVE' }], repayments: [] });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/active loan/);
  });

  it('passes when the client has only a CLOSED ingested loan', async () => {
    clientLoansService.getDashboard.mockResolvedValue({ loans: [{ id: 'loan-1', status: 'CLOSED' }], repayments: [] });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });
});
