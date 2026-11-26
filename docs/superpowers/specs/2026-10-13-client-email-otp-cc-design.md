# Optional Client Email (OTP + Notification CC) Design

## 1. Purpose

Today a `Client` is identified purely by `phone` (`@unique`), and nothing
in the client-facing flow ever collects or stores an email address. This
adds an **optional** email to the client's account, collected at
login/signup time (not inside the `client-onboarding` module — see the
terminology note below), that:

- is permanently unique across all clients (no two clients can share one,
  and once a client has one, it can never be changed or reassigned),
- receives a copy of every login OTP once set, alongside the existing SMS, and
- receives a copy of every other client-facing SMS notification this
  codebase sends (there are exactly four send sites total, enumerated in
  §4), so email becomes a full secondary channel, not just an OTP
  side-channel.

**Terminology note:** despite the feature being described as "added to
onboarding," it's implemented in the **auth/login layer**
(`ClientAuthController`'s OTP request/verify), not the `client-onboarding`
module — per the approved design, email is collected at signup, before
onboarding (IPPIS link → identity → documents → face-match) even starts.

## 2. Collection flow

`POST /auth/client/otp/request` gains an optional `email` field
(`RequestOtpDto`). `ClientAuthService.requestOtp(phone, email?)` decides
the *effective* email for this send:

```typescript
async requestOtp(phone: string, email?: string): Promise<{ mockCode?: string; emailSent: boolean }> {
  const existingClient = await this.prisma.client.findUnique({ where: { phone } });
  let effectiveEmail = existingClient?.email ?? undefined;

  if (!effectiveEmail && email) {
    const emailTaken = await this.prisma.client.findUnique({ where: { email } });
    if (emailTaken) {
      throw new ConflictException('This email is already in use');
    }
    effectiveEmail = email;
  }

  const { mockCode } = await this.otpService.request(phone, effectiveEmail);
  return { mockCode, emailSent: Boolean(effectiveEmail) };
}
```

- **Permanent once set**: if `existingClient.email` is already present,
  any newly-supplied `email` on this call is silently ignored — the OTP
  still goes to phone + the client's existing saved email. This is a
  deliberate, approved choice: a client's notification address can't
  silently change on a routine login.
- **Fails fast**: a brand-new email is uniqueness-checked right here, at
  request time — the client finds out immediately, not after they've
  already entered the code.
- **No Client row required yet**: on someone's very first-ever login,
  `existingClient` is `null` (the `Client` row isn't created until
  `verifyOtp`'s upsert, unchanged from today) — the supplied email just
  flows through as a pending value on this OTP, handled in §3.

`ClientAuthController.requestOtp` passes `dto.email` through and returns
`emailSent` alongside the existing `sent`/`mockCode` fields, so the
frontend knows whether a copy actually went out this time.

## 3. Storage: `OtpCode.email` carries the pending value to verify

`OtpService.request(phone, email?)` — unchanged SMS behavior, plus:

```typescript
async request(phone: string, email?: string): Promise<{ mockCode?: string }> {
  const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
  const code = generateNumericCode(length);
  const codeHash = await hashPassword(code);
  const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

  await this.prisma.otpCode.create({
    data: { phone, email, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
  });

  await this.sendWithFailover(phone, code);

  if (email) {
    await this.sendEmailCopy(email, code);
  }

  return {
    mockCode: this.configService?.get('ENABLE_MOCK_OTP') === 'true' ? code : undefined,
  };
}

private async sendEmailCopy(email: string, code: string): Promise<void> {
  const minutes = Math.round(this.ttlSeconds() / 60);
  try {
    await this.emailService?.send({
      to: email,
      subject: 'Your login code',
      html: `<p>Your verification code is <strong>${code}</strong>. It expires in ${minutes} minutes.</p>`,
      text: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`OTP email copy to ${email} failed: ${message}`);
  }
}
```

`emailService` is injected the same way `configService` already is
(optional, constructor-injected, no `@Inject` token needed since
`EmailService` is a concrete class) — `OtpModule` adds `EmailModule` to
its `imports`. **Email delivery failure never fails the request**: phone
is the hard-required channel (unchanged — `sendWithFailover` still throws
if every SMS provider fails); email is best-effort and only logged on
failure, consistent with it being a supplementary channel.

`OtpService.verify(phone, code)`'s return type changes from `boolean` to
carry the matched row's pending email through to the one caller that
needs it:

```typescript
export interface OtpVerifyResult {
  valid: boolean;
  email?: string | null;
}

async verify(phone: string, code: string): Promise<OtpVerifyResult> {
  if (this.configService?.get('ENABLE_MOCK_OTP') === 'true' && code === (this.configService?.get('MOCK_OTP_CODE') ?? '0000')) {
    return { valid: true };
  }

  const candidate = await this.prisma.otpCode.findFirst({
    where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!candidate || candidate.expiresAt < new Date()) {
    return { valid: false };
  }

  const matches = await bcrypt.compare(code, candidate.codeHash);
  if (!matches) {
    return { valid: false };
  }

  await this.prisma.otpCode.update({ where: { id: candidate.id }, data: { consumedAt: new Date() } });

  return { valid: true, email: candidate.email };
}
```

(The mock-bypass branch returns no email — a dev-only convenience that
doesn't touch a real `OtpCode` row, so there's nothing to carry through.
Acceptable: mock OTP is for local dev/test convenience, not a path real
email-collection needs to work through.)

`OtpService` is the only thing that calls `verify()`'s result today
(confirmed by searching the codebase for every call site) — `ClientAuthService.verifyOtp`:

```typescript
async verifyOtp(phone: string, code: string, meta?: { userAgent?: string; ip?: string }) {
  const result = await this.otpService.verify(phone, code);
  if (!result.valid) {
    throw new UnauthorizedException('Invalid or expired code');
  }

  let client = await this.prisma.client.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });

  if (result.email && !client.email) {
    try {
      client = await this.prisma.client.update({ where: { id: client.id }, data: { email: result.email } });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Someone else claimed this email in the window between this
      // client's request and verify calls -- login still succeeds, the
      // email is just silently dropped this time. Genuinely rare (two
      // concurrent signups racing for the exact same email), and failing
      // an otherwise-valid login over it would be worse UX than this.
    }
  }

  const payload = { sub: client.id, type: 'client' as const };
  const refreshToken = await this.sessionService.createSession({
    principalType: SessionPrincipalType.CLIENT,
    principalId: client.id,
    userAgent: meta?.userAgent,
    ip: meta?.ip,
  });

  return { accessToken: this.tokenService.signAccessToken(payload), refreshToken };
}
```

Reuses the just-added `isUniqueConstraintError` helper
(`src/common/is-unique-constraint-error.util.ts`) for the race-safety net.

## 4. Extending the other three client SMS notifications

Audited every SMS send site in the codebase (`TwoWaySmsProvider`/
`OtpProvider` usage) — there are exactly four, total:

1. `OtpService.request` — handled above.
2. `LoanRequestService.create` (line ~224) — loan origination confirmation.
3. `LoanRequestService.createTopup` (line ~277) — loan top-up confirmation.
4. `LoanRequestService.resend` (line ~311) — confirmation resend.

All three `LoanRequestService` sites already have the full `Client` row in
scope (`findUniqueOrThrow`, no narrowing `select`), so `client.email` is
available with no query changes. `LoanRequestModule` gains `EmailModule`
in its `imports`, `LoanRequestService` gains an injected `EmailService`
and a `Logger`, and a small private helper (local to this service, since
its try/catch/log policy is specific to these three call sites):

```typescript
private async sendEmailCopy(email: string | null, message: string): Promise<void> {
  if (!email) return;
  try {
    await this.emailService.send({
      to: email,
      subject: 'Confirm your loan request',
      html: `<p>${message}</p>`,
      text: message,
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Loan-request confirmation email to ${email} failed: ${err}`);
  }
}
```

Each of the three sites gets one line added immediately after its existing
`smsProvider.send(client.phone, ...)` call:
`await this.sendEmailCopy(client.email, this.confirmationMessage(...));`
(same message text already computed for the SMS). Same policy as the OTP
email: best-effort, logged, never fails the surrounding request.

No new shared cross-module abstraction — four call sites across two
services is too small to justify one, and the two services have
different failure-handling needs already (`OtpService` has its own
failover logger; `LoanRequestService` gets its own `Logger` instance
matching the same project convention).

## 5. Schema

```prisma
// Client
email String? @unique

// OtpCode
email String?
```

Both nullable, no backfill needed (Postgres allows unlimited `NULL`s under
a unique constraint) — a standard additive migration.

## 6. Admin visibility

`AdminClientReviewService.findById`/`list` already spread the full
`Client` row into their response (`{ ...client, onboarding: {...} }`), so
`email` appears automatically in `GET /admin/clients` /
`GET /admin/clients/:id` with no service code change — just a Postman
example update (§8).

## 7. Testing

- Unit: `ClientAuthService.requestOtp` — no existing client → supplied
  email used as-is (uniqueness-checked); existing client with no email →
  same; existing client WITH an email → supplied value ignored, their own
  email used; supplied email already taken by another client →
  `ConflictException`, `otpService.request` never called; no email
  supplied at all → `effectiveEmail` undefined, `emailSent: false`.
- Unit: `OtpService.request` — stores `email` on the `OtpCode` row when
  given; calls `emailService.send` with the generated code when given;
  does NOT call it when omitted; a rejected `emailService.send` is caught
  and logged, not thrown (request still resolves normally); SMS failure
  still throws exactly as today (unchanged behavior, regression check).
- Unit: `OtpService.verify` — returns `{ valid: true, email: <value> }`
  when the matched row has one; `{ valid: true }` (no `email` key
  populated) when it doesn't; `{ valid: false }` for unknown/expired/
  mismatched code (regression check on existing behavior, now via the new
  return shape); mock-bypass path returns `{ valid: true }` with no email.
- Unit: `ClientAuthService.verifyOtp` — persists `result.email` onto a
  newly-created `Client`; persists it onto an existing `Client` that has
  none yet; does NOT overwrite an existing `Client.email` even if
  `result.email` differs (shouldn't happen given §2's logic, but tested as
  a safety-net case); a `P2002` on the email-set update is swallowed,
  login still succeeds; a non-`P2002` error from that update still
  propagates.
- Unit: `LoanRequestService.create`/`createTopup`/`resend` — each sends
  the email copy when `client.email` is set, skips it when not, and a
  rejected `emailService.send` doesn't stop the loan request from being
  created/resent.
- e2e: client requests OTP with a new email → verify → `GET
  /admin/clients/:id` shows the saved email; client requests OTP a second
  time (new login) with a *different* email supplied → the original
  email is still the one on file (permanence); two different phones
  racing for the same email at request time → the second gets `409`.

## 8. Postman

Per this repo's `CLAUDE.md`: update `POST /auth/client/otp/request`'s
saved examples to include the optional `email` field and the new
`emailSent` response field; add a `409` example ("email already in use");
update `GET /admin/clients`/`GET /admin/clients/:id` saved examples to
show the new `email` field on the client object.

## 9. Out of scope

- Email address *verification* (confirming the client actually owns the
  inbox) — this spec only covers collection, uniqueness, and CC'ing
  existing notifications. A verification flow (e.g. a confirmation link)
  is a separate, later feature if wanted.
- Allowing a client to change their email after it's set — explicitly
  rejected per the approved design (permanent once set).
- Case-insensitive email matching — kept consistent with how
  `AdminUser.email`/`Agent.email` already behave (case-sensitive exact
  match); not a new gap introduced by this feature.
