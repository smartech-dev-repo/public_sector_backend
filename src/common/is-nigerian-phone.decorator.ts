import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { NIGERIAN_MOBILE, validNigerianPhone } from './normalize-nigerian-phone.util';

/** Accepts any way of writing a Nigerian mobile and hands the service the +234 form. */
export function IsNigerianPhone(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => {
      if (typeof value !== 'string' && typeof value !== 'number') return value;
      return validNigerianPhone(String(value)) ?? String(value);
    }),
    Matches(NIGERIAN_MOBILE, { message: 'Enter a valid Nigerian mobile number, such as 08031234567' }),
  );
}
