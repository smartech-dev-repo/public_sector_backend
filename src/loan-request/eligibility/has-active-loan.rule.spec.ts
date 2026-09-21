import { HasActiveLoanRule } from './has-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('HasActiveLoanRule', () => {
  let rule: HasActiveLoanRule;
  let prisma: { clientLoan: { findFirst: jest.Mock } };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    rule = new HasActiveLoanRule(prisma as unknown as PrismaService);
  });

  it('fails when the client has no ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no active loan/);
  });

  it('passes when the client has an ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
    expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'ACTIVE' },
    });
  });
});
