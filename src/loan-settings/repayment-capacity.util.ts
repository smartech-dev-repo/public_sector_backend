import { BadRequestException } from '@nestjs/common';
import { RepaymentCapacityDto } from './dto/repayment-capacity.dto';

type Stored = {
  affordabilityMethod: string | null;
  basePayAmount: unknown;
  dtiPercent: unknown;
};

export interface CapacityData {
  affordabilityMethod?: 'BASE_PAY' | 'DTI' | null;
  basePayAmount?: number | null;
  dtiPercent?: number | null;
}

/**
 * Merges a change over what is stored and checks the result is usable: BASE_PAY needs a
 * base pay amount and DTI a percentage. Clearing the method clears both values. Returns
 * only the fields to write; an empty object when nothing capacity-related was sent.
 */
export function capacityChange(
  dto: RepaymentCapacityDto,
  current: Stored,
): CapacityData {
  const touched = ['affordabilityMethod', 'basePayAmount', 'dtiPercent'].some(
    (key) => key in dto && dto[key as keyof RepaymentCapacityDto] !== undefined,
  );
  if (!touched) return {};
  if (dto.affordabilityMethod === null)
    return { affordabilityMethod: null, basePayAmount: null, dtiPercent: null };

  const method =
    dto.affordabilityMethod ??
    (current.affordabilityMethod as 'BASE_PAY' | 'DTI' | null);
  const basePayAmount =
    dto.basePayAmount !== undefined
      ? dto.basePayAmount
      : current.basePayAmount === null
        ? null
        : Number(current.basePayAmount);
  const dtiPercent =
    dto.dtiPercent !== undefined
      ? dto.dtiPercent
      : current.dtiPercent === null
        ? null
        : Number(current.dtiPercent);

  if (!method)
    throw new BadRequestException(
      'Choose a repayment capacity method: BASE_PAY or DTI',
    );
  if (
    method === 'BASE_PAY' &&
    (basePayAmount === null || basePayAmount === undefined)
  ) {
    throw new BadRequestException(
      'Base pay needs an amount the client keeps each month',
    );
  }
  if (method === 'DTI' && (dtiPercent === null || dtiPercent === undefined)) {
    throw new BadRequestException('DTI needs a percentage of salary');
  }
  return {
    affordabilityMethod: method,
    basePayAmount: basePayAmount ?? null,
    dtiPercent: dtiPercent ?? null,
  };
}
