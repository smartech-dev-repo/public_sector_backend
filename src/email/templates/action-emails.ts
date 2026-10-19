// src/email/templates/action-emails.ts
import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

export function agentApplicationRejectedEmail(params: { fullName: string; reason: string }): { subject: string; html: string; text: string } {
  // "Reason: " must stay immediately before the reason text — src/admin-agent-review/admin-agent-review.service.spec.ts
  // asserts `text` contains the reason string.
  const bodyText = `Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.\n\nReason: ${params.reason}\n\nIf you believe this was a mistake or have questions, please contact support.`;
  const bodyHtml = `<p>Hi ${params.fullName}, thank you for applying to become a Moneyfield agent. After review, we're unable to approve your application at this time.</p><p><strong>Reason:</strong> ${params.reason}</p><p>If you believe this was a mistake or have questions, please contact support.</p>`;
  return {
    subject: 'An update on your agent application',
    html: wrapEmailLayout({ headline: 'Application update', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Application update', bodyText }),
  };
}

export function agentCredentialsEmail(params: { fullName: string; email: string; temporaryPassword: string; downloadUrl?: string }): { subject: string; html: string; text: string } {
  // "Download the app: " must stay present/absent exactly as before —
  // src/admin-agent-review/admin-agent-review.service.spec.ts asserts
  // both the absence (no downloadUrl) and presence+URL (with downloadUrl) cases.
  const downloadText = params.downloadUrl ? `\n\nDownload the app: ${params.downloadUrl}` : '';
  const downloadHtml = params.downloadUrl ? `<p>Download the app: <a href="${params.downloadUrl}">${params.downloadUrl}</a></p>` : '';
  const bodyText = `Hi ${params.fullName}, your agent account has been approved. Here are your login details:\n\nEmail: ${params.email}\nTemporary password: ${params.temporaryPassword}${downloadText}\n\nYou'll be asked to set a new password the first time you log in.`;
  const bodyHtml = `<p>Hi ${params.fullName}, your agent account has been approved. Here are your login details:</p><p>Email: ${params.email}</p>${highlightBox(params.temporaryPassword)}${downloadHtml}<p>You'll be asked to set a new password the first time you log in.</p>`;
  return {
    subject: 'Welcome to Moneyfield — your account is ready',
    html: wrapEmailLayout({ headline: 'Your account is ready', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Your account is ready', bodyText }),
  };
}

export function loanRequestConfirmationEmail(params: { amount: number; type: 'ORIGINATION' | 'TOPUP' }): { subject: string; html: string; text: string } {
  // src/loan-request/loan-request.service.spec.ts asserts `text` contains
  // the amount (e.g. "5000") and, for topups, the substring "top-up".
  const kind = params.type === 'TOPUP' ? 'loan top-up' : 'loan';
  const bodyText = `We've received your ${kind} request for ₦${params.amount}. To confirm it, reply YES to the SMS we sent to your registered phone number. This email is a copy of that message for your records.`;
  const bodyHtml = `<p>We've received your ${kind} request for ₦${params.amount}. To confirm it, reply YES to the SMS we sent to your registered phone number. This email is a copy of that message for your records.</p>`;
  return {
    subject: 'Confirm your loan request',
    html: wrapEmailLayout({ headline: 'Confirm your loan request', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Confirm your loan request', bodyText }),
  };
}
