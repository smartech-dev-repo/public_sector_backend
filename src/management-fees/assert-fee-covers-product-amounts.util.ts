import { BadRequestException } from '@nestjs/common';

type Amount = { toString(): string } | number | string | null;

// A product has one fee, so a ranged fee has to span every amount the product
// lends, or some loans would have no fee at all. A fee with no range always fits.
export function assertFeeCoversProductAmounts(
  fee: { name: string; minAmount: Amount; maxAmount: Amount },
  product: { minimumAmount: Amount; maximumAmount: Amount },
): void {
  const startsTooHigh = fee.minAmount !== null && Number(fee.minAmount) > Number(product.minimumAmount);
  const endsTooLow = fee.maxAmount !== null && Number(fee.maxAmount) < Number(product.maximumAmount);
  if (startsTooHigh || endsTooLow) {
    throw new BadRequestException(`The amount range of management fee "${fee.name}" must cover the loan product's minimum and maximum amount`);
  }
}
