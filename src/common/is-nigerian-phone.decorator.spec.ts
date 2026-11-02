import { ValidationPipe } from '@nestjs/common';
import { IsNigerianPhone } from './is-nigerian-phone.decorator';

class PhoneDto {
  @IsNigerianPhone()
  phone: string;
}

const validate = (phone: unknown) =>
  new ValidationPipe({ whitelist: true, transform: true }).transform({ phone }, { type: 'body', metatype: PhoneDto });

describe('IsNigerianPhone', () => {
  it.each(['0803 123 4567', '+234 803 123 4567', '+23408031234567', '8031234567', '0803-123-4567', 8031234567])(
    'accepts %s and passes on the +234 form',
    async (phone) => {
      await expect(validate(phone)).resolves.toEqual({ phone: '+2348031234567' });
    },
  );

  it.each(['803123', '08031234567/08051234567', '1234567890', '', null, undefined])('rejects %s', async (phone) => {
    await expect(validate(phone)).rejects.toThrow();
  });
});
