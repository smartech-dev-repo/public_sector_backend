import { BadRequestException } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

describe('LoanProductsService management fee', () => {
  const fee = { id: 'f1', name: 'Std', type: ManagementChargeType.PERCENTAGE, value: 2, minAmount: null, maxAmount: null, isActive: true };
  const input = {
    productName: 'P', productCode: 'P', sectors: ['NPF'], minimumAmount: 1000, maximumAmount: 500000,
    minimumTenorMonths: 1, maximumTenorMonths: 12,
    interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 3 }],
    managementChargeApplication: ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT,
  };
  let prisma: { managementFee: { findUnique: jest.Mock }; loanProduct: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock } };
  let service: LoanProductsService;

  beforeEach(() => {
    prisma = {
      managementFee: { findUnique: jest.fn().mockResolvedValue(fee) },
      loanProduct: { create: jest.fn().mockResolvedValue({ id: 'p1' }), update: jest.fn().mockResolvedValue({ id: 'p1' }), findUnique: jest.fn() },
    };
    service = new (LoanProductsService as any)(prisma, {}, {}, {}, {});
  });

  it('links the picked fee and copies its charge onto the product', async () => {
    await service.create({ ...input, managementFeeId: 'f1' });
    expect(prisma.loanProduct.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          managementChargeType: ManagementChargeType.PERCENTAGE,
          managementChargeValue: 2,
          managementFee: { connect: { id: 'f1' } },
        }),
      }),
    );
  });

  it('requires a fee or a manual charge', async () => {
    await expect(service.create(input)).rejects.toThrow(BadRequestException);
  });

  it('refuses a fee that does not span the product amounts, or an inactive new pick', async () => {
    prisma.managementFee.findUnique.mockResolvedValue({ ...fee, maxAmount: 100000 });
    await expect(service.create({ ...input, managementFeeId: 'f1' })).rejects.toThrow(BadRequestException);
    prisma.managementFee.findUnique.mockResolvedValue({ ...fee, isActive: false });
    await expect(service.create({ ...input, managementFeeId: 'f1' })).rejects.toThrow(BadRequestException);
  });

  it('lets a product keep its fee after the fee is deactivated', async () => {
    prisma.loanProduct.findUnique.mockResolvedValue({ ...input, managementFeeId: 'f1' });
    prisma.managementFee.findUnique.mockResolvedValue({ ...fee, isActive: false });
    await expect(service.update('p1', { managementFeeId: 'f1' })).resolves.toBeDefined();
  });

  it('refuses raising the product maximum past its fee range', async () => {
    prisma.loanProduct.findUnique.mockResolvedValue({ ...input, managementFeeId: 'f1' });
    prisma.managementFee.findUnique.mockResolvedValue({ ...fee, maxAmount: 500000 });
    await expect(service.update('p1', { maximumAmount: 900000 })).rejects.toThrow(BadRequestException);
  });
});
