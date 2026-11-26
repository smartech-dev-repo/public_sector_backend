import { NoTopupInProgressRule } from './no-topup-in-progress.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoTopupInProgressRule', () => {
  let rule: NoTopupInProgressRule;
  let prisma: { loanRequest: { findFirst: jest.Mock } };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { loanRequest: { findFirst: jest.fn() } };
    rule = new NoTopupInProgressRule(prisma as unknown as PrismaService);
  });

  it('fails when the client has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/still in progress/);
  });

  it('passes when the client has no non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue(null);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
    expect(prisma.loanRequest.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: { in: ['PENDING', 'CONFIRMED', 'APPROVED'] } },
    });
  });
});
