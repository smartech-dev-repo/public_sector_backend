// src/email/templates/verification-code-emails.spec.ts
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  agentRecruitmentVerificationCodeEmail,
  clientOtpCodeEmail,
  changePasswordConfirmationCodeEmail,
} from './verification-code-emails';

describe('twoFactorSetupCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = twoFactorSetupCodeEmail({ code: '123456', ttlMinutes: 10 });
    expect(result.subject).toBe('Your two-factor setup code');
    expect(result.text).toContain('Your verification code is: 123456');
    expect(result.html).toContain('123456');
    expect(result.text).toContain('10 minutes');
  });
});

describe('loginVerificationCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = loginVerificationCodeEmail({ code: '654321', ttlMinutes: 10 });
    expect(result.subject).toBe('Your login verification code');
    expect(result.text).toContain('Your verification code is: 654321');
    expect(result.html).toContain('654321');
  });
});

describe('agentRecruitmentVerificationCodeEmail', () => {
  it('includes the exact phrase and code on one line in text', () => {
    const result = agentRecruitmentVerificationCodeEmail({ code: '111222', ttlMinutes: 10 });
    expect(result.subject).toBe('Verify your email to continue your application');
    expect(result.text).toContain('Your verification code is: 111222');
    expect(result.html).toContain('111222');
  });
});

describe('clientOtpCodeEmail', () => {
  it('includes "verification code" and the code', () => {
    const result = clientOtpCodeEmail({ code: '4321', ttlMinutes: 5 });
    expect(result.subject).toBe('Your login code');
    expect(result.html).toContain('verification code');
    expect(result.text).toContain('4321');
    expect(result.text).toContain('5 minutes');
  });
});

describe('changePasswordConfirmationCodeEmail', () => {
  it('includes the exact phrase, code, greeting, and sign-off', () => {
    const result = changePasswordConfirmationCodeEmail({ code: '778899', ttlMinutes: 10 });
    expect(result.subject).toBe('Confirm your password change');
    expect(result.text).toContain('Your verification code is: 778899');
    expect(result.text).toContain('Hello,');
    expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
    expect(result.html).toContain('778899');
  });
});

describe('every verification-code template', () => {
  const builders = [
    () => twoFactorSetupCodeEmail({ code: '123456', ttlMinutes: 10 }),
    () => loginVerificationCodeEmail({ code: '123456', ttlMinutes: 10 }),
    () => agentRecruitmentVerificationCodeEmail({ code: '123456', ttlMinutes: 10 }),
    () => clientOtpCodeEmail({ code: '1234', ttlMinutes: 5 }),
  ];

  it('opens with a greeting and closes with a sign-off', () => {
    for (const build of builders) {
      const result = build();
      expect(result.text).toContain('Hello,');
      expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
      expect(result.html).toContain('Warm regards');
      expect(result.html).toContain('The Moneyfield Team');
    }
  });
});
