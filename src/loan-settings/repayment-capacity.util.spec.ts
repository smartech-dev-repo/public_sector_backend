import { BadRequestException } from '@nestjs/common';
import { capacityChange } from './repayment-capacity.util';

const none = {
  affordabilityMethod: null,
  basePayAmount: null,
  dtiPercent: null,
};

describe('capacityChange', () => {
  it('base pay + DTI needs both values', () => {
    expect(() =>
      capacityChange(
        { affordabilityMethod: 'BASE_PAY_DTI', dtiPercent: 40 },
        none,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      capacityChange(
        { affordabilityMethod: 'BASE_PAY_DTI', basePayAmount: 50000 },
        none,
      ),
    ).toThrow(BadRequestException);
    expect(
      capacityChange(
        {
          affordabilityMethod: 'BASE_PAY_DTI',
          basePayAmount: 50000,
          dtiPercent: 40,
        },
        none,
      ),
    ).toEqual({
      affordabilityMethod: 'BASE_PAY_DTI',
      basePayAmount: 50000,
      dtiPercent: 40,
    });
  });

  it('keeps a stored value when switching to base pay + DTI', () => {
    expect(
      capacityChange(
        { affordabilityMethod: 'BASE_PAY_DTI', basePayAmount: 50000 },
        {
          affordabilityMethod: 'DTI',
          basePayAmount: null,
          dtiPercent: '33.33',
        },
      ),
    ).toEqual({
      affordabilityMethod: 'BASE_PAY_DTI',
      basePayAmount: 50000,
      dtiPercent: 33.33,
    });
  });

  it('clearing the method clears both values', () => {
    expect(
      capacityChange(
        { affordabilityMethod: null },
        {
          affordabilityMethod: 'BASE_PAY_DTI',
          basePayAmount: '50000',
          dtiPercent: '40',
        },
      ),
    ).toEqual(none);
  });
});
