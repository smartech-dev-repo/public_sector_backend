import { NotFoundException } from '@nestjs/common';
import { ALL_CLIENT_RECORDS, assertClientInScope, clientScope } from './client-scope.util';
import { clientSearchWhere, phoneDigits } from './client-search.util';

describe('client record scope', () => {
  it('lets holders of the all-records permission see every client', () => {
    expect(clientScope({ sub: 'a1', permissions: [ALL_CLIENT_RECORDS] })).toBeUndefined();
  });

  it('limits everyone else to clients assigned to them', () => {
    expect(clientScope({ sub: 'a1', permissions: ['clients:review'] })).toEqual({ assignedAdminId: 'a1' });
  });

  it('404s for a client outside the scope, and skips the lookup for all-records holders', async () => {
    const prisma = { client: { count: jest.fn().mockResolvedValue(0) } };
    await expect(assertClientInScope(prisma, { sub: 'a1', permissions: [] }, 'c1')).rejects.toThrow(NotFoundException);
    await assertClientInScope(prisma, { sub: 'a1', permissions: [ALL_CLIENT_RECORDS] }, 'c1');
    expect(prisma.client.count).toHaveBeenCalledTimes(1);
  });
});

describe('client search', () => {
  it('reduces any written phone to the digits stored after +234', () => {
    expect(phoneDigits('0803 123 4567')).toBe('8031234567');
    expect(phoneDigits('+2348031234567')).toBe('8031234567');
    expect(phoneDigits('Ada')).toBeNull();
    expect(phoneDigits('Ada 08031234567')).toBeNull();
    expect(phoneDigits('SCB1234567')).toBeNull();
  });

  it('matches name, email, IPPIS number and phone, and the ID only when it is one', () => {
    const where = clientSearchWhere('08031234567')!;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { onboarding: { employeeName: { contains: '08031234567', mode: 'insensitive' } } },
        { onboarding: { ippisRecord: { staffId: { contains: '08031234567', mode: 'insensitive' } } } },
        { phone: { contains: '8031234567' } },
      ]),
    );
    expect(where.OR).not.toContainEqual(expect.objectContaining({ id: expect.anything() }));
    expect(clientSearchWhere('6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d')!.OR).toContainEqual({ id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d' });
    expect(clientSearchWhere('  ')).toBeUndefined();
  });
});
