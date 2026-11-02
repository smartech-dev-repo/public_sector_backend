import { IppisPhoneRegister } from './ippis-phone-register';

const A = 'NPF::A';
const B = 'NPF::B';
const C = 'LASG::C';
const stored = (staffId: string, phone: string) => ({ agency: 'NPF', staffId, phone });

describe('IppisPhoneRegister', () => {
  it('gives a number to the first row in the file, across sectors and formats', () => {
    const register = new IppisPhoneRegister([], [], new Set([A, C]));
    expect(register.claim(A, '08031234567')).toBe(true);
    expect(register.claim(C, '+2348031234567')).toBe(false);
  });

  it('lets one staff member repeat their own number', () => {
    const register = new IppisPhoneRegister([], [], new Set([A]));
    expect(register.claim(A, '08031234567')).toBe(true);
    expect(register.claim(A, '8031234567')).toBe(true);
  });

  it('refuses a number held by a record outside the file', () => {
    const register = new IppisPhoneRegister([stored('B', '8031234567')], [], new Set([A]));
    expect(register.claim(A, '08031234567')).toBe(false);
  });

  it('refuses a number registered to a client on another record', () => {
    const register = new IppisPhoneRegister([], [{ phone: '+2348031234567', key: B }], new Set([A, B]));
    expect(register.claim(A, '08031234567')).toBe(false);
  });

  it('lets two staff in the file swap numbers', () => {
    const register = new IppisPhoneRegister([stored('A', '08031234567'), stored('B', '08051234567')], [], new Set([A, B]));
    expect(register.claim(A, '08051234567')).toBe(true);
    expect(register.claim(B, '08031234567')).toBe(true);
  });

  it('keeps an old duplicate updating for the first row, then refuses the second', () => {
    const register = new IppisPhoneRegister([stored('A', '08031234567'), stored('B', '08031234567')], [], new Set([A, B]));
    expect(register.claim(A, '08031234567')).toBe(true);
    expect(register.claim(B, '08031234567')).toBe(false);
  });

  it('does not freeze a staff member whose duplicate partner is not in the file', () => {
    const register = new IppisPhoneRegister([stored('A', '08031234567'), stored('B', '08031234567')], [], new Set([A]));
    expect(register.claim(A, '08031234567')).toBe(true);
  });

  it('ignores blank and unreadable numbers', () => {
    const register = new IppisPhoneRegister([], [], new Set([A, B]));
    expect(register.claim(A, '803123')).toBe(true);
    expect(register.claim(B, '803123')).toBe(true);
    expect(register.claim(B, null)).toBe(true);
  });
});
