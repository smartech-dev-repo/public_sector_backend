import { formatNaira, formatTtl, loanConfirmationEmail, loanConfirmationSms, localPhone } from './loan-confirmation-messages';

const GSM7 = /^[A-Za-z0-9 @$_!"#%&'()*+,\-./:;<=>?\n]*$/;

describe('loan confirmation messages', () => {
  it('formats amounts, phones and expiry the way clients read them', () => {
    expect(formatNaira(1500000)).toBe('NGN 1,500,000');
    expect(formatNaira(2500.5)).toBe('NGN 2,500.5');
    expect(localPhone('+2348031234567')).toBe('08031234567');
    expect(formatTtl(10)).toBe('10 minutes');
    expect(formatTtl(60)).toBe('1 hour');
    expect(formatTtl(1439)).toBe('23 hours');
  });

  it.each([false, true])('keeps every SMS to one GSM-7 part (top-up: %s)', (topup) => {
    for (const approvalPhone of [null, '+2348031234567']) {
      const sms = loanConfirmationSms({ code: '123456', amount: 99999999, topup, approvalPhone, ttlMinutes: 10 });
      expect(sms.length).toBeLessThanOrEqual(160);
      expect(sms).toMatch(GSM7);
    }
  });

  it('tells an agent-assisted client to send the code to the admin number', () => {
    const p = { code: '123456', amount: 500000, topup: false, approvalPhone: '+2348031234567', ttlMinutes: 1440 };
    expect(loanConfirmationSms(p)).toBe(
      'Moneyfield: Your agent requested a NGN 500,000 loan for you. To approve it, send code 123456 to 08031234567. Did not ask for it? Do not send the code.',
    );
    const mail = loanConfirmationEmail(p);
    expect(mail.subject).toBe('Confirm your loan request');
    expect(mail.text).toContain('Your verification code is: 123456');
    expect(mail.text).toContain('send this code by SMS to 08031234567');
    expect(mail.text).toContain('expires in 24 hours');
    expect(mail.html).toContain('123456');
  });

  it('tells a client who asked themselves to enter the code in the app', () => {
    const p = { code: '123456', amount: 50000, topup: true, approvalPhone: null, ttlMinutes: 10 };
    expect(loanConfirmationSms(p)).toBe(
      'Moneyfield: Your code to confirm your NGN 50,000 loan top-up request is 123456. It expires in 10 minutes. Do not share it with anyone.',
    );
    const mail = loanConfirmationEmail(p);
    expect(mail.subject).toBe('Confirm your loan top-up');
    expect(mail.text).toContain('Enter this code in the app');
    expect(mail.text).not.toContain('08031234567');
    expect(mail.text).toContain('Warm regards,\nThe Moneyfield Team');
  });
});
