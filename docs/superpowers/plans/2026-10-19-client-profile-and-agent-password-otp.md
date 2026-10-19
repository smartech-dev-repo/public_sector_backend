# Client Profile Extension & Agent Change-Password OTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `GET client/me` into a real self-service profile (onboarding/IPPIS/wallet/loan/session status), and add an email-OTP confirmation step to the agent default-password change flow, plus a dev-mode code-echo convenience applied consistently across every email-delivered numeric code in the app.

**Architecture:** Two independent features sharing one small piece of common infra (`devCodeEcho` util). Client profile extension is read-only composition over existing services (`WalletService`, `ClientLoansService`) plus direct Prisma queries — no schema change. Agent change-password becomes a 3-step pending-then-confirm flow backed by 3 new nullable `Agent` columns, mirroring the existing 2FA-email-code column pattern exactly.

**Tech Stack:** NestJS, Prisma, class-validator DTOs, Jest unit tests, supertest e2e tests.

**Spec:** `docs/superpowers/specs/2026-10-19-client-profile-and-agent-password-otp-design.md`

## Global Constraints

- `POST /auth/agent/change-password`'s response shape intentionally changes from `{ accessToken }` to `{ sent: true, devCode? }` — this is an approved breaking change, not a bug. The new `/confirm` endpoint now returns the `{ accessToken }` shape instead.
- Every `devCode` addition must be purely additive (an optional field on an existing return object) — confirmed safe against all 6 existing `toEqual()`/`.expect()` assertions on these objects, since Jest's `toEqual` ignores `undefined`-valued keys and JSON serialization drops `undefined` entirely, so no existing test needs to change for the devCode-only additions (only `changePassword`'s behavior change needs a test update — see Task 5).
- No OTP/2FA added to `Client` or `AdminUser` — out of scope per the approved spec.
- `EMAIL_CODE_DEV_ECHO` defaults to unset/off in `.env.example`; must never be enabled in a real deployment.

---

### Task 1: `devCodeEcho` shared util

**Files:**
- Create: `src/common/dev-code-echo.util.ts`
- Create: `src/common/dev-code-echo.util.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `devCodeEcho(configService: ConfigService | undefined, code: string): string | undefined` — consumed by Tasks 5, 6, 7.

- [ ] **Step 1: Write the util**

```typescript
// src/common/dev-code-echo.util.ts
import { ConfigService } from '@nestjs/config';

export function devCodeEcho(configService: ConfigService | undefined, code: string): string | undefined {
  return configService?.get('EMAIL_CODE_DEV_ECHO') === 'true' ? code : undefined;
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/common/dev-code-echo.util.spec.ts
import { ConfigService } from '@nestjs/config';
import { devCodeEcho } from './dev-code-echo.util';

describe('devCodeEcho', () => {
  it('returns the code when the flag is the string "true"', () => {
    const configService = { get: jest.fn().mockReturnValue('true') } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBe('123456');
  });

  it('returns undefined when the flag is unset', () => {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBeUndefined();
  });

  it('returns undefined when the flag is any other value', () => {
    const configService = { get: jest.fn().mockReturnValue('false') } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBeUndefined();
  });

  it('returns undefined when configService itself is undefined', () => {
    expect(devCodeEcho(undefined, '123456')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/common/dev-code-echo.util.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Add the env var**

In `.env.example`, add near the other `EMAIL_*` entries:

```
# Optional, default off. When 'true', every email-delivered numeric code
# (2FA setup/login, agent-recruitment verification, agent change-password
# confirmation) is echoed back in its response as `devCode`, so a dev/test
# client doesn't need a real inbox. Never enable this in a real deployment.
EMAIL_CODE_DEV_ECHO=
```

- [ ] **Step 5: Commit**

```bash
git add src/common/dev-code-echo.util.ts src/common/dev-code-echo.util.spec.ts .env.example
git commit -m "feat(common): add devCodeEcho util for dev-mode email-code echoing"
```

---

### Task 2: `GET client/me` extension

**Files:**
- Modify: `src/client-profile/client-profile.service.ts`
- Modify: `src/client-profile/client-profile.service.spec.ts`
- Modify: `src/client-profile/client-profile.module.ts`

**Interfaces:**
- Consumes: `WalletService.getBalance(clientId): Promise<number>`, `ClientLoansService.hasActiveLoan(clientId): Promise<boolean>`, `narrowIppisRecord` (`src/client-onboarding/narrow-ippis-record.util.ts`), `computeLengthOfService` (`src/client-onboarding/length-of-service.util.ts`).
- Produces: the new `GET client/me` response shape — no other task depends on this.

- [ ] **Step 1: Write the failing spec**

```typescript
// src/client-profile/client-profile.service.spec.ts
import { ClientProfileService } from './client-profile.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ClientLoansService } from '../client-loans/client-loans.service';

describe('ClientProfileService', () => {
  let service: ClientProfileService;
  let prisma: { client: { findUniqueOrThrow: jest.Mock }; session: { count: jest.Mock } };
  let walletService: { getBalance: jest.Mock };
  let clientLoansService: { hasActiveLoan: jest.Mock };

  beforeEach(() => {
    prisma = { client: { findUniqueOrThrow: jest.fn() }, session: { count: jest.fn() } };
    walletService = { getBalance: jest.fn() };
    clientLoansService = { hasActiveLoan: jest.fn() };
    service = new ClientProfileService(
      prisma as unknown as PrismaService,
      walletService as unknown as WalletService,
      clientLoansService as unknown as ClientLoansService,
    );
  });

  it('returns onboarding: null when the client has no onboarding row yet', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'PHONE_VERIFIED',
      createdById: 'admin-1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: null,
    });
    walletService.getBalance.mockResolvedValue(0);
    clientLoansService.hasActiveLoan.mockResolvedValue(false);
    prisma.session.count.mockResolvedValue(0);

    const result = await service.getProfile('client-1');

    expect(result).toEqual({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'PHONE_VERIFIED',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: null,
      wallet: { balance: 0 },
      hasActiveLoan: false,
      activeSessionCount: 0,
    });
    expect(result).not.toHaveProperty('createdById');
  });

  it('returns the narrowed onboarding/ippisRecord shape, completion flag, and length of service when onboarding exists', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: null,
      status: 'VERIFIED',
      createdById: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      onboarding: {
        step: 'COMPLETED',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        identityVerified: true,
        faceMatchPassed: true,
        ippisRecord: {
          agency: 'NPF',
          staffId: 'PF123',
          employeeName: 'Jane Doe',
          employeeStatus: 'ACTIVE',
          hireDate: new Date('2015-01-01'),
          department: 'Finance',
          grade: 'GL10',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          bvn: '12345678901',
          salary: 500000,
        },
      },
    });
    walletService.getBalance.mockResolvedValue(15000);
    clientLoansService.hasActiveLoan.mockResolvedValue(true);
    prisma.session.count.mockResolvedValue(2);

    const result = await service.getProfile('client-1');

    expect(result.onboarding).toEqual(
      expect.objectContaining({
        step: 'COMPLETED',
        completed: true,
        employeeName: 'Jane Doe',
        agency: 'NPF',
        identityVerified: true,
        faceMatchPassed: true,
      }),
    );
    expect(result.onboarding!.lengthOfService).not.toBeNull();
    expect(result.onboarding!.ippisRecord).not.toHaveProperty('bvn');
    expect(result.onboarding!.ippisRecord).not.toHaveProperty('salary');
    expect(result.wallet).toEqual({ balance: 15000 });
    expect(result.hasActiveLoan).toBe(true);
    expect(result.activeSessionCount).toBe(2);
  });

  it('queries active sessions scoped to CLIENT, not revoked, not expired', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: null,
      status: 'PHONE_VERIFIED',
      createdAt: new Date(),
      updatedAt: new Date(),
      onboarding: null,
    });
    walletService.getBalance.mockResolvedValue(0);
    clientLoansService.hasActiveLoan.mockResolvedValue(false);
    prisma.session.count.mockResolvedValue(0);

    await service.getProfile('client-1');

    expect(prisma.session.count).toHaveBeenCalledWith({
      where: {
        principalType: 'CLIENT',
        principalId: 'client-1',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/client-profile/client-profile.service.spec.ts`
Expected: FAIL — `ClientProfileService` constructor doesn't yet accept `walletService`/`clientLoansService`, and `getProfile` doesn't return the new shape.

- [ ] **Step 3: Implement the service**

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

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/client-profile/client-profile.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the module**

Change `src/client-profile/client-profile.module.ts` from:

```typescript
import { Module } from '@nestjs/common';
import { ClientProfileController } from './client-profile.controller';
import { ClientProfileService } from './client-profile.service';

@Module({
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}
```

to:

```typescript
import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { ClientProfileController } from './client-profile.controller';
import { ClientProfileService } from './client-profile.service';

@Module({
  imports: [WalletModule, ClientLoansModule],
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}
```

(`WalletModule` and `ClientLoansModule` both already `export` their respective services — confirmed by reading both files — so no changes needed there. The controller itself needs no changes — same route, same guard, richer response from the same `getProfile` call.)

- [ ] **Step 6: Verify the app compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/client-profile/client-profile.service.ts src/client-profile/client-profile.service.spec.ts src/client-profile/client-profile.module.ts
git commit -m "feat(client-profile): extend GET client/me with onboarding, wallet, loan, and session status"
```

---

### Task 3: Schema — 3 new `Agent` columns for pending password change

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Agent.changePasswordPendingHash`, `Agent.changePasswordCodeHash`, `Agent.changePasswordCodeExpiresAt` — consumed by Task 5.

- [ ] **Step 1: Add the 3 columns**

In `prisma/schema.prisma`, in the `Agent` model, change:

```prisma
  passwordResetCodeHash       String?
  passwordResetCodeExpiresAt  DateTime?
}
```

to:

```prisma
  passwordResetCodeHash       String?
  passwordResetCodeExpiresAt  DateTime?
  changePasswordPendingHash   String?
  changePasswordCodeHash      String?
  changePasswordCodeExpiresAt DateTime?
}
```

- [ ] **Step 2: Run the migration**

Run: `npx prisma migrate dev --name agent_change_password_otp`
Expected: non-destructive (3 new nullable columns), completes cleanly.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add Agent pending-password-change OTP columns"
```

---

### Task 4: `changePasswordConfirmationCodeEmail` template

**Files:**
- Modify: `src/email/templates/verification-code-emails.ts`
- Modify: `src/email/templates/verification-code-emails.spec.ts`

**Interfaces:**
- Produces: `changePasswordConfirmationCodeEmail(params: { code: string; ttlMinutes: number }): { subject, html, text }` — consumed by Task 5.

- [ ] **Step 1: Add the template**

In `src/email/templates/verification-code-emails.ts`, add after `clientOtpCodeEmail`:

```typescript
export function changePasswordConfirmationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  const bodyText = `Hello,\n\nWe received a request to change your password.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email — your password won't change.\n\n${CLOSING_TEXT}`;
  const bodyHtml = `<p>Hello,</p><p>We received a request to change your password.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email — your password won't change.</p>${CLOSING_HTML}`;
  return {
    subject: 'Confirm your password change',
    html: wrapEmailLayout({ headline: 'Confirm your password change', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Confirm your password change', bodyText }),
  };
}
```

- [ ] **Step 2: Add its spec**

In `src/email/templates/verification-code-emails.spec.ts`, add:

```typescript
describe('changePasswordConfirmationCodeEmail', () => {
  it('includes the exact phrase, code, greeting, and sign-off', () => {
    const result = changePasswordConfirmationCodeEmail({ code: '778899', ttlMinutes: 10 });
    expect(result.subject).toBe('Confirm your password change');
    expect(result.text).toContain('Your verification code is: 778899');
    expect(result.text).toContain('Hello,');
    expect(result.text).toContain('Warm regards,\nThe Moneyfield Team');
    expect(result.html).toContain('778899');
  });
});
```

And update its import line from:

```typescript
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  agentRecruitmentVerificationCodeEmail,
  clientOtpCodeEmail,
} from './verification-code-emails';
```

to:

```typescript
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  agentRecruitmentVerificationCodeEmail,
  clientOtpCodeEmail,
  changePasswordConfirmationCodeEmail,
} from './verification-code-emails';
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/email/templates/verification-code-emails.spec.ts`
Expected: PASS (all existing tests + 1 new)

- [ ] **Step 4: Commit**

```bash
git add src/email/templates/verification-code-emails.ts src/email/templates/verification-code-emails.spec.ts
git commit -m "feat(email): add changePasswordConfirmationCodeEmail template"
```

---

### Task 5: Agent change-password OTP flow (service + controller + DTO)

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`
- Create: `src/auth/agent/dto/confirm-change-password.dto.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`

**Interfaces:**
- Consumes: `devCodeEcho` (Task 1), `Agent.changePasswordPendingHash`/`changePasswordCodeHash`/`changePasswordCodeExpiresAt` (Task 3), `changePasswordConfirmationCodeEmail` (Task 4).
- Produces: `AgentAuthService.changePassword` (changed signature/behavior), `.confirmChangePassword` (new), `.resendChangePasswordCode` (new).

- [ ] **Step 1: Update imports and add the TTL constant**

In `src/auth/agent/agent-auth.service.ts`, change:

```typescript
import { agentPasswordResetEmail } from '../../email/templates/token-emails';
import { twoFactorSetupCodeEmail, loginVerificationCodeEmail } from '../../email/templates/verification-code-emails';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
```

to:

```typescript
import { agentPasswordResetEmail } from '../../email/templates/token-emails';
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  changePasswordConfirmationCodeEmail,
} from '../../email/templates/verification-code-emails';
import { devCodeEcho } from '../../common/dev-code-echo.util';
import { JwtPayload } from '../jwt-payload.interface';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const CHANGE_PASSWORD_CODE_TTL_MS = 10 * 60 * 1000;
```

- [ ] **Step 2: Replace `changePassword` and add `confirmChangePassword`/`resendChangePasswordCode`**

Change:

```typescript
  async changePassword(agentId: string, currentPassword: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { passwordHash, mustChangePassword: false },
    });
  }
```

to:

```typescript
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

- [ ] **Step 3: Add `devCode` to the existing 2FA email-code return paths**

Change `setupTwoFactor`'s EMAIL branch from:

```typescript
    await this.emailService.send({ to: agent.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL };
```

to:

```typescript
    await this.emailService.send({ to: agent.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL, devCode: devCodeEcho(this.configService, code) };
```

Change `beginTwoFactorLogin` from:

```typescript
  private async beginTwoFactorLogin(agent: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    if (agent.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
      const code = generateNumericCode(length);
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({ to: agent.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(agent.id);
    return { twoFactorRequired: true, method: agent.twoFactorMethod, pendingToken };
  }
```

to:

```typescript
  private async beginTwoFactorLogin(agent: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    let devCode: string | undefined;
    if (agent.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
      const code = generateNumericCode(length);
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({ to: agent.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
      devCode = devCodeEcho(this.configService, code);
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(agent.id);
    return { twoFactorRequired: true, method: agent.twoFactorMethod, pendingToken, devCode };
  }
```

- [ ] **Step 4: Add `devCode` to `forgotPassword`'s return**

Change:

```typescript
  async forgotPassword(email: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.status !== AgentStatus.APPROVED) {
      return;
    }

    const token = generateOpaqueToken();
    const codeLength = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(codeLength);
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

    await this.emailService.send({ to: agent.email, ...agentPasswordResetEmail({ token, code }) });
  }
```

to:

```typescript
  async forgotPassword(email: string): Promise<{ devCode?: string }> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.status !== AgentStatus.APPROVED) {
      return {};
    }

    const token = generateOpaqueToken();
    const codeLength = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(codeLength);
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

    await this.emailService.send({ to: agent.email, ...agentPasswordResetEmail({ token, code }) });

    return { devCode: devCodeEcho(this.configService, code) };
  }
```

- [ ] **Step 5: Update the controller**

Change the imports to add the new DTO:

```typescript
import { ChangePasswordDto } from './dto/change-password.dto';
```

to:

```typescript
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmChangePasswordDto } from './dto/confirm-change-password.dto';
```

Change the `forgotPassword` route from:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.agentAuthService.forgotPassword(dto.email);
    return { sent: true };
  }
```

to:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    const result = await this.agentAuthService.forgotPassword(dto.email);
    return { sent: true, ...result };
  }
```

Change the `change-password` route from:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    const payload: JwtPayload = { sub: req.user.sub, type: 'agent', mustChangePassword: false };
    return { accessToken: this.tokenService.signAccessToken(payload) };
  }
```

to:

```typescript
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

`TokenService` was only ever used in this controller by the `changePassword` method just removed above (confirmed by `grep -n "tokenService" src/auth/agent/agent-auth.controller.ts` during plan-writing — its only two hits were the constructor injection line and that one usage). Remove it cleanly: change the constructor from

```typescript
  constructor(
    private readonly agentAuthService: AgentAuthService,
    private readonly tokenService: TokenService,
  ) {}
```

to:

```typescript
  constructor(private readonly agentAuthService: AgentAuthService) {}
```

and remove the now-unused `import { TokenService } from '../token.service';` import line.

- [ ] **Step 6: Write the new DTO**

```typescript
// src/auth/agent/dto/confirm-change-password.dto.ts
import { IsString, Length } from 'class-validator';

export class ConfirmChangePasswordDto {
  @IsString()
  @Length(6, 8)
  code: string;
}
```

- [ ] **Step 7: Update the existing unit test for `changePassword`'s new behavior**

In `src/auth/agent/agent-auth.service.spec.ts`, change:

```typescript
  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await expect(
        service.changePassword('agent-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('hashes the new password and clears mustChangePassword', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await service.changePassword('agent-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.agent.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'agent-1' });
      expect(updateCall.data.mustChangePassword).toBe(false);
      expect(updateCall.data.passwordHash).not.toBe(passwordHash);
    });
  });
```

to:

```typescript
  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, email: 'agent@example.com' });

      await expect(
        service.changePassword('agent-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('stores a pending password hash and a code, emails it, and does not touch passwordHash yet', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, email: 'agent@example.com' });

      const result = await service.changePassword('agent-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.agent.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'agent-1' });
      expect(updateCall.data.changePasswordPendingHash).toEqual(expect.any(String));
      expect(updateCall.data.changePasswordCodeHash).toEqual(expect.any(String));
      expect(updateCall.data.changePasswordCodeExpiresAt).toEqual(expect.any(Date));
      expect(updateCall.data.passwordHash).toBeUndefined();
      expect(updateCall.data.mustChangePassword).toBeUndefined();
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
      expect(result).toEqual({ sent: true, devCode: undefined });
    });
  });

  describe('confirmChangePassword', () => {
    it('throws ConflictException when no change is pending', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', changePasswordPendingHash: null });
      await expect(service.confirmChangePassword('agent-1', '123456')).rejects.toThrow(ConflictException);
    });

    it('throws UnauthorizedException for an expired or mismatched code', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        changePasswordPendingHash: 'pending-hash',
        changePasswordCodeHash: hashToken('123456'),
        changePasswordCodeExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.confirmChangePassword('agent-1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('applies the pending hash, clears mustChangePassword, clears the pending columns, and returns an accessToken', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        changePasswordPendingHash: 'pending-hash',
        changePasswordCodeHash: hashToken('123456'),
        changePasswordCodeExpiresAt: new Date(Date.now() + 100000),
      });

      const result = await service.confirmChangePassword('agent-1', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: {
          passwordHash: 'pending-hash',
          mustChangePassword: false,
          changePasswordPendingHash: null,
          changePasswordCodeHash: null,
          changePasswordCodeExpiresAt: null,
        },
      });
      expect(result.accessToken).toEqual(expect.any(String));
    });
  });

  describe('resendChangePasswordCode', () => {
    it('throws ConflictException when no change is pending', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', changePasswordPendingHash: null });
      await expect(service.resendChangePasswordCode('agent-1')).rejects.toThrow(ConflictException);
    });

    it('generates and emails a fresh code without requiring the current password again', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        changePasswordPendingHash: 'pending-hash',
      });

      const result = await service.resendChangePasswordCode('agent-1');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({ changePasswordCodeHash: expect.any(String), changePasswordCodeExpiresAt: expect.any(Date) }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
      expect(result).toEqual({ sent: true, devCode: undefined });
    });
  });
```

(`hashToken` is already imported at the top of this spec file — `import { hashToken } from '../../common/opaque-token.util';` — confirmed during plan-writing, so no new import is needed for the `confirmChangePassword` tests above.)

- [ ] **Step 8: Run the spec to verify it passes**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS (all existing tests + the rewritten/new ones — the `devCode: undefined` assertions pass because the spec's mocked `configService` doesn't set `EMAIL_CODE_DEV_ECHO`, matching the util's documented default-off behavior).

- [ ] **Step 9: Verify the app compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/auth/agent/agent-auth.service.ts src/auth/agent/agent-auth.controller.ts src/auth/agent/dto/confirm-change-password.dto.ts src/auth/agent/agent-auth.service.spec.ts
git commit -m "feat(agent-auth): add OTP confirmation to the default-password change flow"
```

---

### Task 6: Admin 2FA devCode echo

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`

**Interfaces:**
- Consumes: `devCodeEcho` (Task 1).

- [ ] **Step 1: Add the import**

Add near the other imports in `src/auth/admin/admin-auth.service.ts`:

```typescript
import { devCodeEcho } from '../../common/dev-code-echo.util';
```

- [ ] **Step 2: Add `devCode` to `setupTwoFactor`'s EMAIL branch**

Change:

```typescript
    await this.emailService.send({ to: admin.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL };
```

to:

```typescript
    await this.emailService.send({ to: admin.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL, devCode: devCodeEcho(this.configService, code) };
```

- [ ] **Step 3: Add `devCode` to `beginTwoFactorLogin`**

Find the private `beginTwoFactorLogin` method (same shape as the agent one in Task 5 Step 3) and apply the identical transformation: introduce a `let devCode: string | undefined;` before the `if (admin.twoFactorMethod === TwoFactorMethod.EMAIL)` branch, set `devCode = devCodeEcho(this.configService, code);` at the end of that branch (right after the `emailService.send` call), and add `devCode` to the final returned object (`{ twoFactorRequired: true, method: admin.twoFactorMethod, pendingToken, devCode }`).

- [ ] **Step 4: Run the existing spec to verify it still passes**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS (all existing tests unchanged — the `toEqual({ method: 'EMAIL' })`/`toEqual({ twoFactorRequired: true, method: ..., pendingToken: ... })` assertions still pass since `devCode` is `undefined` in these tests and Jest's `toEqual` ignores `undefined`-valued keys).

- [ ] **Step 5: Verify the app compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts
git commit -m "feat(admin-auth): echo the 2FA email code in dev mode via devCode"
```

---

### Task 7: Agent-recruitment devCode echo

**Files:**
- Modify: `src/agent-recruitment/agent-recruitment.service.ts`
- Modify: `src/agent-recruitment/agent-recruitment.controller.ts`

**Interfaces:**
- Consumes: `devCodeEcho` (Task 1).

- [ ] **Step 1: Update `requestCode`'s return type**

In `src/agent-recruitment/agent-recruitment.service.ts`, add the import:

```typescript
import { devCodeEcho } from '../common/dev-code-echo.util';
```

Change:

```typescript
  async requestCode(email: string): Promise<void> {
    const existingAgent = await this.prisma.agent.findUnique({ where: { email } });
    if (existingAgent) {
      throw new ConflictException('An agent application with this email already exists');
    }

    const length = Number(this.configService.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    const emailCodeHash = hashToken(code);
    const emailCodeExpiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);

    await this.prisma.agentApplication.upsert({
      where: { email },
      update: { emailCodeHash, emailCodeExpiresAt },
      create: { email, emailCodeHash, emailCodeExpiresAt },
    });

    await this.emailService.send({
      to: email,
      ...agentRecruitmentVerificationCodeEmail({ code, ttlMinutes: EMAIL_CODE_TTL_MS / 60000 }),
    });
```

to:

```typescript
  async requestCode(email: string): Promise<{ devCode?: string }> {
    const existingAgent = await this.prisma.agent.findUnique({ where: { email } });
    if (existingAgent) {
      throw new ConflictException('An agent application with this email already exists');
    }

    const length = Number(this.configService.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    const emailCodeHash = hashToken(code);
    const emailCodeExpiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);

    await this.prisma.agentApplication.upsert({
      where: { email },
      update: { emailCodeHash, emailCodeExpiresAt },
      create: { email, emailCodeHash, emailCodeExpiresAt },
    });

    await this.emailService.send({
      to: email,
      ...agentRecruitmentVerificationCodeEmail({ code, ttlMinutes: EMAIL_CODE_TTL_MS / 60000 }),
    });

    return { devCode: devCodeEcho(this.configService, code) };
```

(This is the exact current body of `requestCode`, verified by reading the live file during plan-writing — the closing `}` of the method itself is unchanged, only the signature's return type and the final `return` statement are new.)

- [ ] **Step 2: Update the controller**

In `src/agent-recruitment/agent-recruitment.controller.ts`, change:

```typescript
  async requestCode(@Body() dto: RequestRecruitmentCodeDto) {
    await this.agentRecruitmentService.requestCode(dto.email);
    return { sent: true };
  }
```

to:

```typescript
  async requestCode(@Body() dto: RequestRecruitmentCodeDto) {
    const result = await this.agentRecruitmentService.requestCode(dto.email);
    return { sent: true, ...result };
  }
```

- [ ] **Step 3: Confirm the existing spec still passes**

Run: `npx jest src/agent-recruitment/agent-recruitment.service.spec.ts`
Expected: PASS, no test changes needed — confirmed during plan-writing that both existing `requestCode` tests call `await service.requestCode(...)` without capturing or asserting its return value at all, so the signature/return-shape change is invisible to them.

- [ ] **Step 4: Verify the app compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent-recruitment/agent-recruitment.service.ts src/agent-recruitment/agent-recruitment.controller.ts
git commit -m "feat(agent-recruitment): echo the verification code in dev mode via devCode"
```

---

### Task 8: e2e tests

**Files:**
- Create: `test/agent-change-password-otp.e2e-spec.ts`
- Modify: `test/client-onboarding.e2e-spec.ts` or create `test/client-profile.e2e-spec.ts` additions (see Step 3)

**Interfaces:**
- Consumes: all routes/behavior from Tasks 2-7.

- [ ] **Step 1: Write the agent change-password-OTP e2e spec**

```typescript
// test/agent-change-password-otp.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password-hash.util';

describe('Agent change-password with OTP confirmation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let accessToken: string;
  const email = `e2e-change-pw-${Date.now()}@example.com`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const passwordHash = await hashPassword('Original-Password-123!');
    const agent = await prisma.agent.create({
      data: {
        email,
        phone: '+2348012399988',
        fullName: 'E2E Change Password Agent',
        address: '1 Example Street',
        cvKey: '',
        status: 'APPROVED',
        passwordHash,
      },
    });
    agentId = agent.id;

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: 'Original-Password-123!' })
      .expect(200);
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  // Runs first, deliberately, before any other test puts a change into a
  // pending state — this test's whole premise is that nothing is pending yet.
  it('rejects confirm/resend when no change is pending', async () => {
    await request(app.getHttpServer())
      .post('/auth/agent/change-password/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: '123456' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/agent/change-password/resend')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it(
    'initiating stores a pending code but does not change the password until confirmed',
    async () => {
      const initiateRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'Original-Password-123!', newPassword: 'New-Password-456!' })
        .expect(200);
      expect(initiateRes.body.sent).toBe(true);

      const updatedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(updatedAgent.changePasswordPendingHash).toBeTruthy();
      expect(updatedAgent.changePasswordCodeHash).toBeTruthy();

      // Wrong code is rejected, and the original password still logs in --
      // proving the change hasn't been applied yet.
      await request(app.getHttpServer())
        .post('/auth/agent/change-password/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: '000000' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Original-Password-123!' })
        .expect(200);
    },
    20000,
  );

  it(
    'resend issues a fresh code; with EMAIL_CODE_DEV_ECHO on, confirming it completes the change and clears the pending state',
    async () => {
      const resendRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password/resend')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(resendRes.body.sent).toBe(true);

      if (!resendRes.body.devCode) {
        // EMAIL_CODE_DEV_ECHO isn't set in this environment -- there's no way
        // to read the real code back out (it's hashed), so this test can only
        // verify the request succeeded, not the full confirm path. See this
        // task's note on setting EMAIL_CODE_DEV_ECHO=true locally to exercise
        // the complete flow.
        return;
      }

      const confirmRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: resendRes.body.devCode })
        .expect(200);
      expect(confirmRes.body.accessToken).toEqual(expect.any(String));

      const updatedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(updatedAgent.changePasswordPendingHash).toBeNull();
      expect(updatedAgent.mustChangePassword).toBe(false);

      // The new password now works; the old one no longer does.
      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'New-Password-456!' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Original-Password-123!' })
        .expect(401);
    },
    20000,
  );
});
```

This file's full confirm-success path (the last test) only runs when
`EMAIL_CODE_DEV_ECHO=true` is set in the environment this e2e run executes
under — add that to the project's local `.env` (gitignored, not committed)
before running, matching the same one-off local-env-setup pattern already
used for `JWT_AGENT_APPLICATION_SECRET` and `ADMIN_DASHBOARD_URL` earlier
in this project's history. If it's unset, that last test still passes (it
returns early right after asserting the resend itself succeeded) — it just
can't exercise the confirm step, since the real code is only ever stored
hashed and there's no way to read it back out otherwise.

- [ ] **Step 2: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json agent-change-password-otp`
Expected: PASS (3 tests). Re-run in isolation if it fails on the first attempt before concluding there's a real regression — this is a shared UAT database with known DB-contention flakiness under concurrent load.

- [ ] **Step 3: Add a `GET client/me` e2e check**

In `test/client-profile.e2e-spec.ts`, add a new test right after the existing `"returns the client's own profile fields"` test (its fixture client has `status: 'VERIFIED'` and no onboarding row, created directly via `prisma.client.create` in this file's `beforeAll` — so `onboarding` is expected to be `null` for it):

```typescript
  it('returns the extended profile shape: wallet, hasActiveLoan, activeSessionCount, and null onboarding', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        id: clientId,
        phone,
        wallet: { balance: expect.any(Number) },
        hasActiveLoan: expect.any(Boolean),
        activeSessionCount: expect.any(Number),
      }),
    );
    expect(res.body.onboarding).toBeNull();
  });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json client-profile`
Expected: PASS (all existing tests + 1 new).

- [ ] **Step 5: Commit**

```bash
git add test/agent-change-password-otp.e2e-spec.ts test/client-profile.e2e-spec.ts
git commit -m "test(e2e): cover agent change-password OTP flow and extended client/me"
```

---

### Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Re-run any failing suite in isolation before treating it as a regression (known pre-existing DB-contention flakiness under full-suite concurrent load).

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint "{src,apps,libs,test}/**/*.ts" --rule '{"prettier/prettier":"off"}'` (note: **without** `--fix`) — expect no new errors beyond the established pre-existing baseline.

- [ ] **Step 4: Confirm the app boots live**

Run `npm run start:dev`, confirm clean startup and that `/auth/agent/change-password/confirm` and `/auth/agent/change-password/resend` resolve in the startup log.

- [ ] **Step 5: Live sanity check of `GET client/me` and the change-password-OTP flow**

With `EMAIL_CODE_DEV_ECHO=true` set locally, hit `POST /auth/agent/change-password` for a real approved agent and confirm the response includes a `devCode`; confirm the password actually changes only after calling `/confirm` with that code, not before.

- [ ] **Step 6: Confirm no stray debug artifacts remain**

Run: `git status --short` — expect clean.
