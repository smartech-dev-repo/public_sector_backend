import { BadRequestException } from '@nestjs/common';
import { assertFeeCoversProductAmounts } from './assert-fee-covers-product-amounts.util';

describe('assertFeeCoversProductAmounts', () => {
  const product = { minimumAmount: 1000, maximumAmount: 500000 };

  it('accepts a general fee, an exact fit, and an open-ended range', () => {
    expect(() => assertFeeCoversProductAmounts({ name: 'a', minAmount: null, maxAmount: null }, product)).not.toThrow();
    expect(() => assertFeeCoversProductAmounts({ name: 'b', minAmount: 1000, maxAmount: 500000 }, product)).not.toThrow();
    expect(() => assertFeeCoversProductAmounts({ name: 'c', minAmount: 0, maxAmount: null }, product)).not.toThrow();
  });

  it('rejects a range that misses either end', () => {
    expect(() => assertFeeCoversProductAmounts({ name: 'd', minAmount: 2000, maxAmount: null }, product)).toThrow(BadRequestException);
    expect(() => assertFeeCoversProductAmounts({ name: 'e', minAmount: null, maxAmount: 400000 }, product)).toThrow(BadRequestException);
  });
});
