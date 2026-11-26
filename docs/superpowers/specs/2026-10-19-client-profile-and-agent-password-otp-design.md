# Client Profile Extension & Agent Change-Password OTP Design

## 1. Purpose

Two independent changes bundled under one spec since they're both small:

1. `GET client/me` today returns almost nothing (`id, phone, email, status,
   createdAt, updatedAt`) — extend it into a real self-service profile:
   onboarding/IPPIS info, identity/face-match checks, wallet balance,
   active-loan flag, and active session count. Client has no 2FA at all
   (confirmed — no `twoFactor*` fields on the `Client` model), so "2FA
   status" is replaced with the onboarding verification checks that
   actually exist for a client.
2. The existing agent `POST /auth/agent/change-password` (used when an
   agent must change the system-issued default password, `Agent
   .mustChangePassword`) does no OTP/code verification today — just a
   current-password check. Add an email-OTP confirmation step, and a
   dev-mode "echo the code in the response" convenience applied
   consistently across every email-delivered numeric code in the app.

## 2. `GET client/me` — new response shape

```typescript
{
  id: string;
  phone: string;
  email: string | null;
  status: ClientStatus;
  createdAt: Date;
  updatedAt: Date;
  onboarding: {
    step: OnboardingStep;
    completed: boolean; // step === 'COMPLETED'
    employeeName: string;
    agency: string;
    lengthOfService: { years: number; months: number } | null;
    identityVerified: boolean | null;
    faceMatchPassed: boolean | null;
    ippisRecord: {
      agency: string;
      staffId: string;
      employeeName: string;
      employeeStatus: string | null;
      hireDate: Date | null;
      department: string | null;
      grade: string | null;
      bankName: string | null;
      accountNumber: string | null;
    };
  } | null; // null when the client has no onboarding row yet
  wallet: { balance: number };
  hasActiveLoan: boolean;
  activeSessionCount: number;
}
```

`onboarding.ippisRecord` is the existing `narrowIppisRecord()` shape
(`src/client-onboarding/narrow-ippis-record.util.ts`) — same PII
exclusions (no `bvn`, `salary`, `pinNumber`, `rawFields`) already used
everywhere else a client-facing or admin-facing view touches an
`IppisRecord`. `lengthOfService` reuses
`src/client-onboarding/length-of-service.util.ts`'s existing
`computeLengthOfService()`.

### Service implementation

```typescript
// src/client-profile/client-profile.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';
import { computeLengthOfService } from '../client-onboarding/length-of-service.util';
import { OnboardingStep, SessionPrincipalType } from '../generated/prisma/client';

@Injectable()
export class ClientProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async getProfile(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { onboarding: { include: { ippisRecord: true } } },
    });

    const [balance, hasActiveLoan, activeSessionCount] = await Promise.all([
      this.walletService.getBalance(clientId),
      this.clientLoansService.hasActiveLoan(clientId),
      this.prisma.session.count({
        where: {
          principalType: SessionPrincipalType.CLIENT,
          principalId: clientId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);

    return {
      id: client.id,
      phone: client.phone,
      email: client.email,
      status: client.status,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      onboarding: client.onboarding
        ? {
            step: client.onboarding.step,
            completed: client.onboarding.step === OnboardingStep.COMPLETED,
            employeeName: client.onboarding.employeeName,
            agency: client.onboarding.agency,
            lengthOfService: computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null),
            identityVerified: client.onboarding.identityVerified,
            faceMatchPassed: client.onboarding.faceMatchPassed,
            ippisRecord: narrowIppisRecord(client.onboarding.ippisRecord),
          }
        : null,
      wallet: { balance },
      hasActiveLoan,
      activeSessionCount,
    };
  }
}
```

`ClientProfileModule` gains `imports: [WalletModule, ClientLoansModule]`
to make `WalletService`/`ClientLoansService` injectable (matching the
existing cross-module-service-reuse convention, e.g.
`AdminClientReviewModule` importing `ClientOnboardingModule`).

No new permission, no controller change beyond the service call already
being `GET client/me` — same route, same guard (`JwtAuthGuard,
ClientOnlyGuard`), richer response.

## 3. Agent change-password OTP

### Schema — 3 new nullable columns on `Agent`

```prisma
model Agent {
  // ...existing fields...
  changePasswordPendingHash     String?
  changePasswordCodeHash        String?
  changePasswordCodeExpiresAt   DateTime?
}
```

### Flow

1. **`POST /auth/agent/change-password`** (existing path, existing body
   `{ currentPassword, newPassword }`, existing guards) — now:
   - Verifies `currentPassword` via `bcrypt.compare` (unchanged).
   - Hashes `newPassword` and stores it as `changePasswordPendingHash`
     (not yet applied to `passwordHash`).
   - Generates a numeric code (`EMAIL_CODE_LENGTH`, same convention as
     2FA/password-reset codes), stores `hashToken(code)` +
     `changePasswordCodeExpiresAt` (10-minute TTL, matching
     `TWO_FACTOR_EMAIL_CODE_TTL_MS`'s existing value).
   - Emails the code via a new `changePasswordConfirmationCodeEmail`
     template (same greeting/sign-off convention as every other
     template).
   - **Response shape changes**: returns `{ sent: true }` instead of
     `{ accessToken }` — this is an intentional breaking change to this
     endpoint's existing contract, since the password change is no longer
     finalized synchronously.
2. **`POST /auth/agent/change-password/confirm`** (new, same guards:
   `JwtAuthGuard, AgentOnlyGuard`) — body `{ code: string }`:
   - Requires a pending change to exist (`changePasswordPendingHash` set)
     — 409 if not.
   - Verifies the code against `changePasswordCodeHash` +
     `changePasswordCodeExpiresAt` (expired/mismatched → 401, matching
     every other code-verification error shape in this codebase).
   - On success: `passwordHash = changePasswordPendingHash`,
     `mustChangePassword: false`, clears all 3 pending columns.
   - Returns `{ accessToken }` — the exact response shape the OLD
     `change-password` endpoint used to return, now moved here.
3. **`POST /auth/agent/change-password/resend`** (new, same guards) — no
   body:
   - Requires a pending change to exist — 409 if not.
   - Generates a fresh code against the *same* pending password hash
     (doesn't require re-entering `currentPassword`), re-emails it.
   - Returns `{ sent: true }`.

A second call to the original `change-password` endpoint before
confirming simply overwrites the pending state (new password, new code)
— same "latest request wins" behavior already established by
`forgotPassword`/`resetPassword` overwriting prior reset tokens.

### Exact code

```typescript
// src/auth/agent/agent-auth.service.ts — new/changed pieces only
const CHANGE_PASSWORD_CODE_TTL_MS = 10 * 60 * 1000;

async changePassword(agentId: string, currentPassword: string, newPassword: string): Promise<{ sent: true; devCode?: string }> {
  const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
  if (!passwordMatches) {
    throw new UnauthorizedException('Current password is incorrect');
  }

  const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
  const code = generateNumericCode(length);
  const pendingHash = await hashPassword(newPassword);

  await this.prisma.agent.update({
    where: { id: agentId },
    data: {
      changePasswordPendingHash: pendingHash,
      changePasswordCodeHash: hashToken(code),
      changePasswordCodeExpiresAt: new Date(Date.now() + CHANGE_PASSWORD_CODE_TTL_MS),
    },
  });

  await this.emailService.send({ to: agent.email, ...changePasswordConfirmationCodeEmail({ code, ttlMinutes: 10 }) });

  return { sent: true, devCode: devCodeEcho(this.configService, code) };
}

async confirmChangePassword(agentId: string, code: string): Promise<{ accessToken: string }> {
  const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  if (!agent.changePasswordPendingHash) {
    throw new ConflictException('No password change is pending confirmation');
  }

  if (
    !agent.changePasswordCodeHash ||
    !agent.changePasswordCodeExpiresAt ||
    agent.changePasswordCodeExpiresAt < new Date() ||
    agent.changePasswordCodeHash !== hashToken(code)
  ) {
    throw new UnauthorizedException('Invalid or expired verification code');
  }

  await this.prisma.agent.update({
    where: { id: agentId },
    data: {
      passwordHash: agent.changePasswordPendingHash,
      mustChangePassword: false,
      changePasswordPendingHash: null,
      changePasswordCodeHash: null,
      changePasswordCodeExpiresAt: null,
    },
  });

  const payload: JwtPayload = { sub: agentId, type: 'agent', mustChangePassword: false };
  return { accessToken: this.tokenService.signAccessToken(payload) };
}

async resendChangePasswordCode(agentId: string): Promise<{ sent: true; devCode?: string }> {
  const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  if (!agent.changePasswordPendingHash) {
    throw new ConflictException('No password change is pending confirmation');
  }

  const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
  const code = generateNumericCode(length);

  await this.prisma.agent.update({
    where: { id: agentId },
    data: {
      changePasswordCodeHash: hashToken(code),
      changePasswordCodeExpiresAt: new Date(Date.now() + CHANGE_PASSWORD_CODE_TTL_MS),
    },
  });

  await this.emailService.send({ to: agent.email, ...changePasswordConfirmationCodeEmail({ code, ttlMinutes: 10 }) });

  return { sent: true, devCode: devCodeEcho(this.configService, code) };
}
```

### Controller changes

```typescript
// src/auth/agent/agent-auth.controller.ts — change-password route body unchanged;
// response is now whatever the service returns directly (no more manual
// accessToken construction in the controller for this route)
@Throttle({ default: { limit: 5, ttl: 900000 } })
@Post('change-password')
@HttpCode(200)
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
  return this.agentAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
}

@Throttle({ default: { limit: 5, ttl: 900000 } })
@Post('change-password/confirm')
@HttpCode(200)
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
confirmChangePassword(@Body() dto: ConfirmChangePasswordDto, @Req() req: { user: JwtPayload }) {
  return this.agentAuthService.confirmChangePassword(req.user.sub, dto.code);
}

@Throttle({ default: { limit: 5, ttl: 900000 } })
@Post('change-password/resend')
@HttpCode(200)
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
resendChangePasswordCode(@Req() req: { user: JwtPayload }) {
  return this.agentAuthService.resendChangePasswordCode(req.user.sub);
}
```

New `ConfirmChangePasswordDto`:

```typescript
// src/auth/agent/dto/confirm-change-password.dto.ts
import { IsString, Length } from 'class-validator';

export class ConfirmChangePasswordDto {
  @IsString()
  @Length(6, 8)
  code: string;
}
```

## 4. Dev code echo — applied to every email-delivered code

New shared util:

```typescript
// src/common/dev-code-echo.util.ts
import { ConfigService } from '@nestjs/config';

export function devCodeEcho(configService: ConfigService | undefined, code: string): string | undefined {
  return configService?.get('EMAIL_CODE_DEV_ECHO') === 'true' ? code : undefined;
}
```

`.env.example` addition:

```
# Optional, default off. When 'true', every email-delivered numeric code
# (2FA setup/login, password-reset-by-code, agent-recruitment
# verification, agent change-password confirmation) is echoed back in
# its response as `devCode`, so a dev/test client doesn't need a real
# inbox. Never enable this in a real deployment.
EMAIL_CODE_DEV_ECHO=
```

Applied at every existing email-code call site, each gaining a
`devCode?: string` field in its returned object (none of these have an
existing `devCode`/similar field today, so this is purely additive —
no response field is renamed or removed):

| Call site | Current return | New return |
|---|---|---|
| `AdminAuthService.setupTwoFactor` (EMAIL branch) | `{ method: 'EMAIL' }` | `{ method: 'EMAIL', devCode? }` |
| `AdminAuthService.beginTwoFactorLogin` (private, via `login()`) | `{ twoFactorRequired, method, pendingToken }` | `+ devCode?` |
| `AgentAuthService.setupTwoFactor` (EMAIL branch) | `{ method: 'EMAIL' }` | `{ method: 'EMAIL', devCode? }` |
| `AgentAuthService.beginTwoFactorLogin` (private, via `login()`) | `{ twoFactorRequired, method, pendingToken }` | `+ devCode?` |
| `AgentAuthService.forgotPassword` | `Promise<void>`, controller returns `{ sent: true }` | `Promise<{ devCode?: string }>`, controller spreads it into `{ sent: true, ...result }` — only the numeric `code` is echoed, not the opaque reset `token` (a token isn't really an "OTP" in the dev-convenience sense this is for) |
| `AgentRecruitmentService.requestCode` | `Promise<void>`, controller returns `{ sent: true }` | `Promise<{ devCode?: string }>`, controller spreads it the same way |
| `AgentAuthService.changePassword`/`resendChangePasswordCode` (new, §3) | — | `{ sent: true, devCode? }` |

`AdminAuthService` has no code-based password-reset (token-only, per
§Purpose) — nothing to change there beyond its two 2FA call sites above.

## 5. Testing

- Unit: `ClientProfileService.getProfile` — with onboarding present vs
  `null` (no onboarding row yet), confirms `ippisRecord` is narrowed
  (doesn't leak `bvn`/`salary`), confirms `wallet.balance`/
  `hasActiveLoan`/`activeSessionCount` are wired from their respective
  services/query.
- Unit: `AgentAuthService.changePassword`/`confirmChangePassword`/
  `resendChangePasswordCode` — wrong current password still rejected;
  successful initiate stores pending hash + code, doesn't touch
  `passwordHash` yet; confirm with wrong/expired code rejected; confirm
  with right code applies the pending hash and clears all 3 pending
  columns; confirm with no pending change pending → 409; resend without
  a pending change → 409; resend reuses the existing pending hash.
- Unit: `devCodeEcho` util — returns the code when the flag is `'true'`,
  `undefined` otherwise (including when unset).
- Unit: each of the 6 call sites in §4's table gets a one-line addition
  to its existing spec confirming `devCode` is present when the flag is
  on and absent when it's off/unset.
- e2e: full agent change-password-with-OTP round trip (initiate →
  confirm → old password no longer works, new one does, a stale/reused
  code is rejected on a second confirm attempt); resend path (initiate →
  resend → confirm with the resent code succeeds, the original code no
  longer does); `GET client/me` returns the full new shape against a
  real onboarded + loan + wallet-entry fixture.

## 6. Out of scope

- No OTP-gating added to `AdminUser`'s change-password (no default-password
  concept exists there — see §Purpose).
- `RequirePasswordChangedGuard` stays unused/unwired, as it is today —
  not part of this change.
- No change to the existing phone-login OTP (`OtpService`) or its
  separate `ENABLE_MOCK_OTP`/`mockCode` mechanism — this is a distinct,
  already-solved dev-convenience for a different flow.
- No 2FA added to `Client` (confirmed explicitly out of scope per the
  approved design decision).
