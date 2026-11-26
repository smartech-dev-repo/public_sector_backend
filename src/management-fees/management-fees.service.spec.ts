import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ManagementFeesService } from './management-fees.service';
import { PrismaService } from '../prisma/prisma.service';
import { ManagementChargeType } from '../generated/prisma/client';

describe('ManagementFeesService', () => {
  let prisma: { managementFee: Record<string, jest.Mock>; loanProduct: Record<string, jest.Mock>; $transaction: jest.Mock };
  let service: ManagementFeesService;

  beforeEach(() => {
    prisma = {
      managementFee: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), findUnique: jest.fn() },
      loanProduct: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([{ id: 'f1' }, { count: 0 }]),
    } as never;
    service = new ManagementFeesService(prisma as unknown as PrismaService);
  });

  it('rejects a percentage above 100 and an inverted range', async () => {
    await expect(service.create({ name: 'A', type: ManagementChargeType.PERCENTAGE, value: 101 })).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ name: 'A', type: ManagementChargeType.FLAT, value: 1, minAmount: 10, maxAmount: 5 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('checks an update against the stored bounds, and null clears one', async () => {
    prisma.managementFee.findUnique.mockResolvedValue({
      type: ManagementChargeType.FLAT, value: 1, minAmount: 100, maxAmount: 200, _count: { loanProducts: 0 },
    });
    await expect(service.update('f1', { maxAmount: 50 })).rejects.toThrow(BadRequestException);
    await expect(service.update('f1', { minAmount: null, maxAmount: 50 })).resolves.toEqual({ id: 'f1' });
  });

  it('copies an edit to linked products for new loans, and never touches loan tables', async () => {
    prisma.managementFee.findUnique.mockResolvedValue({
      type: ManagementChargeType.FLAT, value: 1, minAmount: null, maxAmount: null, _count: { loanProducts: 1 },
    });

    await service.update('f1', { value: 9 });

    expect(prisma.loanProduct.updateMany).toHaveBeenCalledWith({
      where: { managementFeeId: 'f1' },
      data: { managementChargeType: ManagementChargeType.FLAT, managementChargeValue: 9 },
    });
    expect(Object.keys(prisma)).not.toEqual(expect.arrayContaining(['loanRequest', 'clientLoan']));
  });

  it('refuses a range that no longer covers a product using the fee', async () => {
    prisma.managementFee.findUnique.mockResolvedValue({
      name: 'A', type: ManagementChargeType.FLAT, value: 1, minAmount: null, maxAmount: null, _count: { loanProducts: 1 },
    });
    prisma.loanProduct.findMany.mockResolvedValue([{ productName: 'P', minimumAmount: 1000, maximumAmount: 900000 }]);

    await expect(service.update('f1', { maxAmount: 500000 })).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s on an unknown fee', async () => {
    prisma.managementFee.findUnique.mockResolvedValue(null);
    await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
  });

  it('refuses to delete a fee a product uses', async () => {
    prisma.managementFee.findUnique.mockResolvedValue({ _count: { loanProducts: 2 } });
    await expect(service.remove('f1')).rejects.toThrow(ConflictException);
    expect(prisma.managementFee.delete).not.toHaveBeenCalled();
  });
});
