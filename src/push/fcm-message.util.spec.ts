import { generateKeyPairSync, createVerify } from 'crypto';
import {
  fcmMessageBody,
  isDeadTokenError,
  serviceAccountAssertion,
} from './fcm-message.util';

describe('FCM helpers', () => {
  it('signs a service-account assertion Google can verify', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const jwt = serviceAccountAssertion(
      {
        projectId: 'p',
        clientEmail: 'svc@p.iam.gserviceaccount.com',
        privateKey: privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      },
      1000,
    );
    const [header, claims, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(decoded).toMatchObject({
      iss: 'svc@p.iam.gserviceaccount.com',
      iat: 1000,
      exp: 4600,
    });
    expect(decoded.scope).toContain('firebase.messaging');
  });

  it('builds a v1 message for one token', () => {
    expect(
      fcmMessageBody('tok', { title: 'T', body: 'B', data: { type: 'X' } }),
    ).toEqual({
      message: expect.objectContaining({
        token: 'tok',
        notification: { title: 'T', body: 'B' },
        data: { type: 'X' },
      }),
    });
  });

  it('recognises a token that is no longer registered', () => {
    expect(isDeadTokenError(404, '')).toBe(true);
    expect(
      isDeadTokenError(
        400,
        '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}',
      ),
    ).toBe(true);
    expect(isDeadTokenError(500, 'oops')).toBe(false);
  });
});
