import { highlightBox, wrapEmailLayout, wrapEmailLayoutText } from '../email/templates/layout';

// The SMS channel is one-way, so the SMS carries the code instead of asking
// for a YES reply. Who receives the code decides the wording:
// - client-made request: the client enters the code in the app;
// - agent-made request: the client sends the code to the admin approval phone,
//   and an admin enters it in the back office.
//
// Texts stay within GSM-7 (no ₦) and one 160-character SMS part for typical amounts.

export interface LoanConfirmationMessageParams {
  code: string;
  amount: number;
  topup: boolean;
  /** Admin approval phone (+234…) when an agent made the request; absent for the client's own request. */
  approvalPhone?: string | null;
  ttlMinutes: number;
}

export function formatNaira(amount: number): string {
  return `NGN ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)}`;
}

/** +2348031234567 → 08031234567, the form people dial. */
export function localPhone(phone: string): string {
  return phone.startsWith('+234') ? `0${phone.slice(4)}` : phone;
}

export function formatTtl(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function loanConfirmationSms(p: LoanConfirmationMessageParams): string {
  const kind = p.topup ? 'loan top-up' : 'loan';
  const amount = formatNaira(p.amount);
  if (p.approvalPhone) {
    return `Moneyfield: Your agent requested a ${amount} ${kind} for you. To approve it, send code ${p.code} to ${localPhone(p.approvalPhone)}. Did not ask for it? Do not send the code.`;
  }
  return `Moneyfield: Your code to confirm your ${amount} ${kind} request is ${p.code}. It expires in ${formatTtl(p.ttlMinutes)}. Do not share it with anyone.`;
}

const CLOSING_TEXT = 'Warm regards,\nThe Moneyfield Team';
const CLOSING_HTML = '<p>Warm regards,<br>The Moneyfield Team</p>';

/**
 * One email per code, worded like the SMS. "Your verification code is: " stays
 * immediately before the code on one line in `text`, as with the other code emails.
 */
export function loanConfirmationEmail(p: LoanConfirmationMessageParams): { subject: string; html: string; text: string } {
  const kind = p.topup ? 'loan top-up' : 'loan';
  const amount = formatNaira(p.amount);
  const ttl = formatTtl(p.ttlMinutes);
  const intro = p.approvalPhone
    ? `Your agent requested a ${kind} of ${amount} for you.`
    : `We received your request for a ${kind} of ${amount}.`;
  const instruction = p.approvalPhone
    ? `To approve it, send this code by SMS to ${localPhone(p.approvalPhone)}. An admin will enter it to confirm the request.`
    : 'Enter this code in the app to confirm the request.';
  const warning = p.approvalPhone
    ? `This code expires in ${ttl}. If you did not ask for this ${kind}, do not send the code, and the request will lapse.`
    : `This code expires in ${ttl}. Do not share it with anyone. If you did not make this request, ignore this email and no ${kind} will be confirmed.`;
  const headline = p.topup ? 'Confirm your loan top-up' : 'Confirm your loan request';

  const bodyText = `Hello,\n\n${intro}\n\nYour verification code is: ${p.code}\n\n${instruction}\n\n${warning}\n\n${CLOSING_TEXT}`;
  const bodyHtml = `<p>Hello,</p><p>${intro}</p><p>Your verification code is:</p>${highlightBox(p.code)}<p>${instruction}</p><p>${warning}</p>${CLOSING_HTML}`;
  return {
    subject: headline,
    html: wrapEmailLayout({ headline, bodyHtml }),
    text: wrapEmailLayoutText({ headline, bodyText }),
  };
}
