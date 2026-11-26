import { LoanSettingsService } from './loan-settings.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LoanSettingsService', () => {
  let prisma: { loanSettings: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let service: LoanSettingsService;

  beforeEach(() => {
    prisma = { loanSettings: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() } };
    service = new LoanSettingsService(prisma as unknown as PrismaService);
  });

  describe('get', () => {
    it('creates a row with schema defaults on first call', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue(null);
      prisma.loanSettings.create.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });

      const result = await service.get();

      expect(prisma.loanSettings.create).toHaveBeenCalledWith({ data: {} });
      expect(result).toEqual({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });
    });

    it('returns the existing row on subsequent calls without creating another', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });

      await service.get();

      expect(prisma.loanSettings.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('persists partial changes against the existing row', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });
      prisma.loanSettings.update.mockResolvedValue({ id: 's1', retirementAgeYears: 62, maxServiceYears: 35 });

      const result = await service.update({ retirementAgeYears: 62 });

      expect(prisma.loanSettings.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { retirementAgeYears: 62 },
      });
      expect(result.retirementAgeYears).toBe(62);
    });
  });
});
