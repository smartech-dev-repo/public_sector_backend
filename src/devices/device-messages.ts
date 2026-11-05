import {
  wrapEmailLayout,
  wrapEmailLayoutText,
} from '../email/templates/layout';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ]!,
  );

/** What the app shows when sign-in is refused on another phone. */
export const DEVICE_NOT_RECOGNISED_MESSAGE =
  'This account is linked to another device, so you cannot sign in on this one. Contact customer support to remove the device on your account, then sign in here to link this one.';

export const DEVICE_REQUIRED_MESSAGE =
  'Your app needs updating before you can sign in. Update it and try again.';

export function blockedSignInEmail(params: {
  fullName: string;
  attempted: string;
  when: Date;
}) {
  const when = params.when.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const bodyText = `Hi ${params.fullName},\n\nSomeone tried to sign in to your Moneyfield agent account on a device that isn't linked to it:\n\n${params.attempted}\n${when}\n\nThe sign-in was blocked. Your account only works on the device it's linked to.\n\nIf this was you on a new phone, contact customer support to remove your current device, then sign in on the new one. If it wasn't you, change your password and tell support.\n\nWarm regards,\nThe Moneyfield Team`;
  const bodyHtml = `<p>Hi ${escapeHtml(params.fullName)},</p><p>Someone tried to sign in to your Moneyfield agent account on a device that isn't linked to it:</p><p><strong>${escapeHtml(params.attempted)}</strong><br>${escapeHtml(when)}</p><p>The sign-in was blocked. Your account only works on the device it's linked to.</p><p>If this was you on a new phone, contact customer support to remove your current device, then sign in on the new one. If it wasn't you, change your password and tell support.</p><p>Warm regards,<br>The Moneyfield Team</p>`;
  return {
    subject: 'Sign-in blocked on an unrecognised device',
    html: wrapEmailLayout({ headline: 'Sign-in blocked', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Sign-in blocked', bodyText }),
  };
}

/** GSM-7 and under 160 characters. */
export function blockedSignInSms(attempted: string): string {
  const device = attempted.replace(/[^\x20-\x7E]/g, '').slice(0, 40);
  return `Moneyfield: sign-in blocked on ${device}. Your account works only on your linked phone. New phone? Contact support to remove the old one.`;
}

export function deviceReleasedEmail(params: {
  fullName: string;
  released: string;
  reason: string;
}) {
  const bodyText = `Hi ${params.fullName},\n\nThe device linked to your Moneyfield account has been removed by support:\n\n${params.released}\nReason: ${params.reason}\n\nThe next device you sign in on will be linked to your account. If you didn't ask for this, contact support straight away.\n\nWarm regards,\nThe Moneyfield Team`;
  const bodyHtml = `<p>Hi ${escapeHtml(params.fullName)},</p><p>The device linked to your Moneyfield account has been removed by support:</p><p><strong>${escapeHtml(params.released)}</strong><br>Reason: ${escapeHtml(params.reason)}</p><p>The next device you sign in on will be linked to your account. If you didn't ask for this, contact support straight away.</p><p>Warm regards,<br>The Moneyfield Team</p>`;
  return {
    subject: 'Your linked device was removed',
    html: wrapEmailLayout({ headline: 'Device removed', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Device removed', bodyText }),
  };
}

export function deviceReleasedSms(): string {
  return 'Moneyfield: support removed the phone linked to your account. The next phone you sign in on will be linked. Not you? Contact support.';
}
