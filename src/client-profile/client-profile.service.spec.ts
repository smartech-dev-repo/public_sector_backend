import { ClientProfileService } from './client-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClientProfileService', () => {
  let service: ClientProfileService;
  let prisma: { client: { findUniqueOrThrow: jest.Mock } };

  beforeEach(() => {
    prisma = { client: { findUniqueOrThrow: jest.fn() } };
    service = new ClientProfileService(prisma as unknown as PrismaService);
  });

  it('returns the whitelisted profile fields, excluding createdById', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'VERIFIED',
      createdById: 'admin-1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });

    const result = await service.getProfile('client-1');

    expect(result).toEqual({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'VERIFIED',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(result).not.toHaveProperty('createdById');
  });
});
