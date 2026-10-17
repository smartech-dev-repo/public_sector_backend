import { normalizeNigerianPhone } from './normalize-nigerian-phone.util';

describe('normalizeNigerianPhone', () => {
  it('leaves an already-E.164 number unchanged', () => {
    expect(normalizeNigerianPhone('+2348038847641')).toBe('+2348038847641');
  });

  it('adds the + when given a 234-prefixed number without it', () => {
    expect(normalizeNigerianPhone('2348038847641')).toBe('+2348038847641');
  });

  it('strips a leading 0 and prepends +234', () => {
    expect(normalizeNigerianPhone('08038847641')).toBe('+2348038847641');
  });

  it('prepends +234 to a bare 10-digit local number with no leading 0', () => {
    expect(normalizeNigerianPhone('8038847641')).toBe('+2348038847641');
  });

  it('strips spaces and dashes before normalizing', () => {
    expect(normalizeNigerianPhone('080 388 47641')).toBe('+2348038847641');
    expect(normalizeNigerianPhone('0803-884-7641')).toBe('+2348038847641');
  });
});
