// src/email/templates/token-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox, ctaButton } from './layout';

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

function buildAdminInviteEmail(params: {
  token: string;
  acceptUrl?: string;
  intro: string;
  subject: string;
  headline: string;
}): { subject: string; html: string; text: string } {
  const closingText = "If you weren't expecting this invitation, you can safely ignore this email.\n\nWarm regards,\nThe Moneyfield Team";
  const closingHtml = `<p>If you weren't expecting this invitation, you can safely ignore this email.</p><p>Warm regards,<br>The Moneyfield Team</p>`;

  if (params.acceptUrl) {
    // "accept-invite?token=" must stay in the link, on one line, in
    // `text` — test/admin-invite.e2e-spec.ts extracts the token from it.
    const bodyText = `Hello,\n\n${params.intro} Accept your invitation here: ${params.acceptUrl}\n\n${closingText}`;
    const bodyHtml = `<p>Hello,</p><p>${params.intro} Click the button below to accept your invitation and set up your account.</p>${ctaButton(params.acceptUrl, 'Accept Invitation')}<p>If the button above doesn't work, copy and paste this link into your browser: <a href="${params.acceptUrl}">${params.acceptUrl}</a></p>${closingHtml}`;
    return {
      subject: params.subject,
      html: wrapEmailLayout({ headline: params.headline, bodyHtml }),
      text: wrapEmailLayoutText({ headline: params.headline, bodyText }),
    };
  }

  const bodyText = `Hello,\n\n${params.intro} Use this invitation code to accept and set up your account: ${params.token}\n\n${closingText}`;
  const bodyHtml = `<p>Hello,</p><p>${params.intro} Use the code below to accept your invitation and set up your account.</p>${highlightBox(params.token)}${closingHtml}`;
  return {
    subject: params.subject,
    html: wrapEmailLayout({ headline: params.headline, bodyHtml }),
    text: wrapEmailLayoutText({ headline: params.headline, bodyText }),
  };
}

export function adminInviteEmail(params: { token: string; acceptUrl?: string }): { subject: string; html: string; text: string } {
  return buildAdminInviteEmail({
    ...params,
    intro: "You've been invited to join the admin team at Moneyfield Microfinance Bank Limited.",
    subject: "You've been invited to Moneyfield Admin",
    headline: "You're invited",
  });
}

export function adminInviteResentEmail(params: { token: string; acceptUrl?: string }): { subject: string; html: string; text: string } {
  return buildAdminInviteEmail({
    ...params,
    intro: 'As requested, here is another copy of your invitation to join the admin team at Moneyfield Microfinance Bank Limited.',
    subject: 'Your admin invitation (resent)',
    headline: 'Your invitation, resent',
  });
}
