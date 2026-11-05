import { createSign } from 'crypto';

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** A service-account JWT for Google's token endpoint, signed RS256 (no SDK needed). */
export function serviceAccountAssertion(
  creds: FcmCredentials,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claims = encode({
    iss: creds.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(creds.privateKey).toString('base64url')}`;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Extra values for the app, e.g. { type: 'LOAN_APPROVED', loanRequestId }. FCM wants strings. */
  data?: Record<string, string>;
}

/** The FCM HTTP v1 request body for one device. */
export function fcmMessageBody(token: string, message: PushMessage) {
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data: message.data ?? {},
      android: { priority: 'HIGH' },
      apns: { payload: { aps: { sound: 'default' } } },
    },
  };
}

/** FCM's answer for a token that no longer belongs to an installed app. */
export function isDeadTokenError(status: number, body: string): boolean {
  return (
    status === 404 ||
    (status === 400 &&
      /UNREGISTERED|INVALID_ARGUMENT.*token|registration-token-not-registered/i.test(
        body,
      ))
  );
}
