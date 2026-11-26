import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('ClientMustBeVerifiedRule', () => {
  const rule = new ClientMustBeVerifiedRule();
  const ippisRecord = {} as IppisRecord;

  it('passes for a VERIFIED client', () => {
    const result = rule.check({ status: 'VERIFIED' } as Client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails for a non-VERIFIED client', () => {
    const result = rule.check({ status: 'MANUAL_REVIEW' } as Client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });
});
