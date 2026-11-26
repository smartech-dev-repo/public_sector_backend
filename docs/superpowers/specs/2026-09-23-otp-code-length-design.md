# OTP / Verification Code Length Adjustment Design

## 1. Purpose

Two independent, byte-for-byte identical `Math.random()`-based 6-digit code
generators exist in this codebase today: `generateCode()`
(`src/otp/otp.service.ts`, client phone-login OTP over SMS) and
`generateEmailCode()` (`src/common/generate-email-code.util.ts`, Admin/Agent
2FA-via-email setup and login codes). This changes phone OTPs to 4 digits
and email-delivered codes to a configurable 6-8 digit length, consolidates
the two duplicated generators into one shared utility, and — since the
generators are being rewritten anyway — switches them from `Math.random()`
to `crypto.randomInt()`, since these are auth-sensitive codes and the
non-cryptographic RNG is a real (if narrow) weakness sitting directly in
the code being touched.

Brainstorming surfaced two real scope questions, now resolved:

- **Admin forgot-password** stays exactly as it is today (a long opaque
  bearer-token link) — out of scope, not touched.
- **Agent forgot-password** gains a second option: alongside the existing
  link, the agent can now also enter a 6-8 digit code. Either one resets
  the password; using one invalidates the other.
- **"Email verification"** in the original request refers to the existing
  Admin/Agent 2FA-via-email mechanism (`setupTwoFactor`/
  `beginTwoFactorLogin`) — there is no separate email-verification feature
  in this codebase, and none is being added.

## 2. Shared code-generation utility

Replace both existing generators with one new file,
`src/common/generate-numeric-code.util.ts`:

```typescript
import { randomInt } from 'crypto';

export function generateNumericCode(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return randomInt(min, max + 1).toString();
}
```

`src/otp/otp.service.ts`'s local `generateCode()` and
`src/common/generate-email-code.util.ts`'s `generateEmailCode()` are both
deleted; every call site imports `generateNumericCode` instead. This is a
straight swap — no caller's surrounding logic (hashing via `hashPassword`/
`hashToken`, storage, comparison) changes, since both bcrypt and SHA-256
hashing are length-agnostic.

## 3. Phone OTP → 4 digits, configurable

New env var `PHONE_OTP_LENGTH`, default `4` (documented in `.env.example`
following the existing `RATE_LIMITING_ENABLED`/`ENABLE_MOCK_OTP`
comment-block style). `OtpService.request()` becomes:

```typescript
const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
const code = generateNumericCode(length);
```

`src/auth/client/dto/verify-otp.dto.ts`'s `@Length(6, 6)` becomes
`@Length(4, 4)`. **Constraint worth stating plainly**: `class-validator`
DTOs validate before any service code runs, so they cannot read
`PHONE_OTP_LENGTH` at request time — the DTO's `@Length` is a static
literal that must be kept in sync with the *default* length by hand. This
spec sets both to `4` and documents the coupling with a comment on the
DTO field; it does not build dynamic DTO validation, since no one has
asked for `PHONE_OTP_LENGTH` to be changed in a running environment
without a code change.

`ENABLE_MOCK_OTP`'s companion `MOCK_OTP_CODE` default changes from
`000000` to `0000` (`.env.example` and the fallback in
`OtpService.verify()`'s comparison) to match the new default length.

## 4. Admin/Agent 2FA-via-email codes → 6-8 digits, configurable, default 6

New env var `EMAIL_CODE_LENGTH`, default `6`. Both `AdminAuthService` and
`AgentAuthService` gain a `ConfigService` constructor dependency (neither
injects it today). All four call sites —
`AdminAuthService.setupTwoFactor`/`beginTwoFactorLogin` and
`AgentAuthService.setupTwoFactor`/`beginTwoFactorLogin` — switch to:

```typescript
const length = Number(this.configService.get('EMAIL_CODE_LENGTH') ?? 6);
const code = generateNumericCode(length);
```

No DTO changes needed here (`ConfirmTwoFactorDto`/`TwoFactorLoginVerifyDto`
on both Admin and Agent already validate `code` as a bare `@IsString()`
with no length constraint).

## 5. Agent forgot-password gains an OTP path

**Schema**: `Agent` gains two nullable columns, mirroring the existing
`twoFactorEmailCodeHash`/`twoFactorEmailCodeExpiresAt` pattern:

```prisma
  passwordResetCodeHash       String?
  passwordResetCodeExpiresAt  DateTime?
```

**`AgentAuthService.forgotPassword(email)`**: generates both the existing
opaque token (unchanged) and a new `EMAIL_CODE_LENGTH`-digit code in the
same call, stores both (same `PASSWORD_RESET_TTL_MS` expiry for both —
one hour, matching the existing token TTL), and sends one email
containing both:

```typescript
const token = generateOpaqueToken();
const length = Number(this.configService.get('EMAIL_CODE_LENGTH') ?? 6);
const code = generateNumericCode(length);
const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

await this.prisma.agent.update({
  where: { id: agent.id },
  data: {
    passwordResetTokenHash: hashToken(token),
    passwordResetTokenExpiresAt: expiresAt,
    passwordResetCodeHash: hashToken(code),
    passwordResetCodeExpiresAt: expiresAt,
  },
});

await this.emailService.send({
  to: agent.email,
  subject: 'Reset your password',
  html: `<p>Use this link to reset your password: ${token}</p><p>Or enter this code: ${code}</p>`,
  text: `Use this token to reset your password: ${token}\nOr enter this code: ${code}`,
});
```

**Existing `POST /auth/agent/reset-password` (`{ token, newPassword }`,
`AgentAuthService.resetPassword`)**: unchanged in its own validation, but
on success now also clears `passwordResetCodeHash`/
`passwordResetCodeExpiresAt` (not just the token fields), so a code from
the same request can't be used afterward.

**New `POST /auth/agent/reset-password/code` (`{ email, code, newPassword }`)**:
new `AgentAuthController` route, same `@Throttle` limits as the existing
reset-password route, calling a new `AgentAuthService.resetPasswordByCode(email, code, newPassword)`:

```typescript
async resetPasswordByCode(email: string, code: string, newPassword: string): Promise<void> {
  const agent = await this.prisma.agent.findUnique({ where: { email } });

  if (
    !agent ||
    !agent.passwordResetCodeHash ||
    !agent.passwordResetCodeExpiresAt ||
    agent.passwordResetCodeExpiresAt < new Date() ||
    agent.passwordResetCodeHash !== hashToken(code)
  ) {
    throw new UnauthorizedException('Invalid or expired reset code');
  }

  const passwordHash = await hashPassword(newPassword);
  await this.prisma.agent.update({
    where: { id: agent.id },
    data: {
      passwordHash,
      mustChangePassword: false,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      passwordResetCodeHash: null,
      passwordResetCodeExpiresAt: null,
    },
  });

  await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, agent.id, 'password_reset');
}
```

(Scoped by `email` rather than a global code lookup, mirroring how phone
OTP verification scopes by `phone` — a 6-digit code alone isn't
guaranteed unique across agents with simultaneous pending resets.)

New `src/auth/agent/dto/reset-password-by-code.dto.ts`:

```typescript
import { IsEmail, IsString, Length, MinLength } from 'class-validator';

export class ResetPasswordByCodeDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 8)
  code: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
```

(`@Length(6, 8)` accepts the full configurable range rather than a single
literal, since `EMAIL_CODE_LENGTH` is expected to plausibly change within
that range without a matching DTO edit — unlike the phone OTP DTO, which
pins to the single default value.)

## 6. Testing

- Unit: `generateNumericCode(length)` — returns a string of the exact
  requested length for several lengths (4, 6, 8), returns only digit
  characters, never leading-zero-collapses (i.e. always exactly `length`
  characters even when the random value is small).
- Unit: `OtpService.request()`/`verify()` — generated code matches
  `PHONE_OTP_LENGTH` (default 4), mock-OTP default updated to `0000`.
- Unit: `AdminAuthService`/`AgentAuthService` `setupTwoFactor`/
  `beginTwoFactorLogin` — generated code matches `EMAIL_CODE_LENGTH`
  (default 6).
- Unit: `AgentAuthService.forgotPassword` — stores both token and code
  hashes with the same expiry, email contains both.
- Unit: `AgentAuthService.resetPassword` (token path) — now also clears
  the code fields on success.
- Unit: `AgentAuthService.resetPasswordByCode` — wrong/expired/missing
  code rejected with `UnauthorizedException`; correct code resets the
  password, clears both token and code fields, revokes sessions.
- e2e: Agent forgot-password → reset via the code path succeeds; the
  token from that same request is confirmed unusable afterward (and vice
  versa — reset via token invalidates the code).
- e2e: client phone-login OTP end-to-end still works with a 4-digit code.
- e2e: Admin/Agent 2FA-email setup+login still works with a 6-digit code.

## 7. Postman

Per this repo's `CLAUDE.md`: update the saved response examples for
`POST /client/auth/otp/verify` request bodies to use a 4-digit example
code; add a new `POST /auth/agent/reset-password/code` request (success,
plus wrong-code `401` and validation `400` scenarios) under Agent's Auth
folder; update the Agent `forgot-password` example response/description
to mention the email now contains both a link and a code.
