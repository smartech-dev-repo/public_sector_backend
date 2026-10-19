import { ClientProfileService } from './client-profile.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ClientLoansService } from '../client-loans/client-loans.service';

describe('ClientProfileService', () => {
  let service: ClientProfileService;
  let prisma: { client: { findUniqueOrThrow: jest.Mock }; session: { count: jest.Mock } };
  let walletService: { getBalance: jest.Mock };
  let clientLoansService: { hasActiveLoan: jest.Mock };

  beforeEach(() => {
    prisma = { client: { findUniqueOrThrow: jest.fn() }, session: { count: jest.fn() } };
    walletService = { getBalance: jest.fn() };
    clientLoansService = { hasActiveLoan: jest.fn() };
    service = new ClientProfileService(
      prisma as unknown as PrismaService,
      walletService as unknown as WalletService,
      clientLoansService as unknown as ClientLoansService,
    );
  });

  it('returns onboarding: null when the client has no onboarding row yet', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'PHONE_VERIFIED',
      createdById: 'admin-1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: null,
    });
    walletService.getBalance.mockResolvedValue(0);
    clientLoansService.hasActiveLoan.mockResolvedValue(false);
    prisma.session.count.mockResolvedValue(0);

    const result = await service.getProfile('client-1');

    expect(result).toEqual({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'PHONE_VERIFIED',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: null,
      wallet: { balance: 0 },
      hasActiveLoan: false,
      activeSessionCount: 0,
    });
    expect(result).not.toHaveProperty('createdById');
  });

  it('returns the narrowed onboarding/ippisRecord shape, completion flag, and length of service when onboarding exists', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: null,
      status: 'VERIFIED',
      createdById: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: {
        step: 'COMPLETED',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        identityVerified: true,
        faceMatchPassed: true,
        ippisRecord: {
          agency: 'NPF',
          staffId: 'PF123',
          employeeName: 'Jane Doe',
          employeeStatus: 'ACTIVE',
          hireDate: new Date('2015-01-01'),
          department: 'Finance',
          grade: 'GL10',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          bvn: '12345678901',
          salary: 500000,
        },
      },
    });
    walletService.getBalance.mockResolvedValue(15000);
    clientLoansService.hasActiveLoan.mockResolvedValue(true);
    prisma.session.count.mockResolvedValue(2);

    const result = await service.getProfile('client-1');

    expect(result.onboarding).toEqual(
      expect.objectContaining({
        step: 'COMPLETED',
        completed: true,
        employeeName: 'Jane Doe',
        agency: 'NPF',
        identityVerified: true,
        faceMatchPassed: true,
      }),
    );
    expect(result.onboarding!.lengthOfService).not.toBeNull();
    expect(result.onboarding!.ippisRecord).not.toHaveProperty('bvn');
    expect(result.onboarding!.ippisRecord).not.toHaveProperty('salary');
    expect(result.wallet).toEqual({ balance: 15000 });
    expect(result.hasActiveLoan).toBe(true);
    expect(result.activeSessionCount).toBe(2);
  });

  it('queries active sessions scoped to CLIENT, not revoked, not expired', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: null,
      status: 'PHONE_VERIFIED',
      createdAt: new Date(),
      updatedAt: new Date(),
      onboarding: null,
    });
    walletService.getBalance.mockResolvedValue(0);
    clientLoansService.hasActiveLoan.mockResolvedValue(false);
    prisma.session.count.mockResolvedValue(0);

    await service.getProfile('client-1');

    expect(prisma.session.count).toHaveBeenCalledWith({
      where: {
        principalType: 'CLIENT',
        principalId: 'client-1',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });
});
