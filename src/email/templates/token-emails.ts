// src/email/templates/token-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox, ctaButton, copyableLink } from './layout';

export function adminPasswordResetEmail(params: { token: string }): { subject: string; html: string; text: string } {
  // "reset your password: " must stay immediately before the token, on
  // one line, in `text` — test/admin-password-self-service.e2e-spec.ts
  // regex-matches this exact phrase.
  const bodyText = `We received a request to reset your admin account password.\n\nUse this token to reset your password: ${params.token}\n\nThis token expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.`;
  const bodyHtml = `<p>We received a request to reset your admin account password. Enter this token in the reset form:</p>${highlightBox(params.token)}<p>This token expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>`;
  return {
    subject: 'Reset your password',
    html: wrapEmailLayout({ headline: 'Reset your password', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Reset your password', bodyText }),
  };
}

export function agentPasswordResetEmail(params: { token: string; code: string }): { subject: string; html: string; text: string } {
  // Both "reset your password: " and "enter this code: " must stay
  // immediately before their value, on one line, in `text` —
  // test/agent-password-self-service.e2e-spec.ts and
  // src/auth/agent/agent-auth.service.spec.ts:233-235 regex-match both.
  const bodyText = `We received a request to reset your password. Use either of the following to continue:\n\nUse this token to reset your password: ${params.token}\nOr enter this code: ${params.code}\n\nBoth expire in 1 hour. If you didn't request this, you can safely ignore this email.`;
  const bodyHtml = `<p>We received a request to reset your password. Use either of the following to continue:</p><p><strong>Token:</strong></p>${highlightBox(params.token)}<p><strong>Code:</strong></p>${highlightBox(params.code)}<p>Both expire in 1 hour. If you didn't request this, you can safely ignore this email.</p>`;
  return {
    subject: 'Reset your password',
    html: wrapEmailLayout({ headline: 'Reset your password', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Reset your password', bodyText }),
  };
}

export function adminInviteEmail(params: { token: string; acceptUrl?: string }): { subject: string; html: string; text: string } {
  // "accept: " must stay immediately before the token, on one line, in
  // `text` — test/admin-invite.e2e-spec.ts regex-matches this exact phrase.
  const linkText = params.acceptUrl ? `\n\nAccept your invitation: ${params.acceptUrl}` : '';
  const linkHtml = params.acceptUrl ? ctaButton(params.acceptUrl, 'Accept Invitation') + copyableLink(params.acceptUrl) : '';
  const bodyText = `You've been invited to join Moneyfield Microfinance Bank's admin team.${linkText}\n\nOr use this token to accept: ${params.token}`;
  const bodyHtml = `<p>You've been invited to join Moneyfield Microfinance Bank's admin team.</p>${linkHtml}<p>Or use this token to accept your invitation and set up your account:</p>${highlightBox(params.token)}`;
  return {
    subject: "You've been invited to Moneyfield Admin",
    html: wrapEmailLayout({ headline: "You're invited", bodyHtml }),
    text: wrapEmailLayoutText({ headline: "You're invited", bodyText }),
  };
}

export function adminInviteResentEmail(params: { token: string; acceptUrl?: string }): { subject: string; html: string; text: string } {
  // Same "accept: " constraint as adminInviteEmail.
  const linkText = params.acceptUrl ? `\n\nAccept your invitation: ${params.acceptUrl}` : '';
  const linkHtml = params.acceptUrl ? ctaButton(params.acceptUrl, 'Accept Invitation') + copyableLink(params.acceptUrl) : '';
  const bodyText = `You've been invited to join Moneyfield Microfinance Bank's admin team.${linkText}\n\nOr use this token to accept: ${params.token}`;
  const bodyHtml = `<p>You've been invited to join Moneyfield Microfinance Bank's admin team.</p>${linkHtml}<p>Or use this token to accept your invitation and set up your account:</p>${highlightBox(params.token)}`;
  return {
    subject: 'Your admin invitation (resent)',
    html: wrapEmailLayout({ headline: 'Your invitation, resent', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your invitation, resent', bodyText }),
  };
}
