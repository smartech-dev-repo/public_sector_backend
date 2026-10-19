// src/email/templates/verification-code-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

export function twoFactorSetupCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // "Your verification code is: " must stay immediately before the code,
  // on one line, in `text` — test/admin-two-factor-auth.e2e-spec.ts,
  // agent-two-factor-auth.e2e-spec.ts, and src/auth/admin/admin-auth.service.spec.ts:319-321
  // / src/auth/agent/agent-auth.service.spec.ts:426-428 regex-match this exact phrase.
  const bodyText = `You're enabling email-based two-factor authentication on your account.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const bodyHtml = `<p>You're enabling email-based two-factor authentication on your account.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email.</p>`;
  return {
    subject: 'Your two-factor setup code',
    html: wrapEmailLayout({ headline: 'Set up two-factor authentication', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Set up two-factor authentication', bodyText }),
  };
}

export function loginVerificationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // Same "Your verification code is: " constraint as twoFactorSetupCodeEmail.
  const bodyText = `We received a sign-in attempt that requires email verification.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If this wasn't you, please change your password immediately.`;
  const bodyHtml = `<p>We received a sign-in attempt that requires email verification.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If this wasn't you, please change your password immediately.</p>`;
  return {
    subject: 'Your login verification code',
    html: wrapEmailLayout({ headline: "Verify it's you", bodyHtml }),
    text: wrapEmailLayoutText({ headline: "Verify it's you", bodyText }),
  };
}

export function agentRecruitmentVerificationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // Same "Your verification code is: " constraint — test/agent-recruitment.e2e-spec.ts
  // and test/admin-agent-recruitment-review.e2e-spec.ts both regex-match it.
  const bodyText = `Thanks for starting your agent application with Moneyfield Microfinance Bank.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes.`;
  const bodyHtml = `<p>Thanks for starting your agent application with Moneyfield Microfinance Bank.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes.</p>`;
  return {
    subject: 'Verify your email to continue your application',
    html: wrapEmailLayout({ headline: 'Verify your email', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Verify your email', bodyText }),
  };
}

export function clientOtpCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  // src/otp/otp.service.spec.ts:243 asserts `html` contains "verification code".
  const bodyText = `Use this verification code to log in to your Moneyfield account:\n\n${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.`;
  const bodyHtml = `<p>Use this verification code to log in to your Moneyfield account:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. This is a backup copy — you should also have received it by SMS.</p>`;
  return {
    subject: 'Your login code',
    html: wrapEmailLayout({ headline: 'Your one-time login code', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your one-time login code', bodyText }),
  };
}
