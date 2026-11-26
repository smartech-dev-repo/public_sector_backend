# OTP / Verification Code Length Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change phone-login OTP codes to 4 digits and Admin/Agent 2FA-via-email codes to a configurable 6-8 digit length (default 6), consolidate the two duplicated code generators into one crypto-secure shared utility, and give Agent forgot-password a second, code-based reset option alongside its existing link.

**Architecture:** One new shared `generateNumericCode(length)` utility (using `crypto.randomInt`, not `Math.random()`) replaces both `OtpService`'s local `generateCode()` and `src/common/generate-email-code.util.ts`'s `generateEmailCode()`. Two new env vars (`PHONE_OTP_LENGTH` default `4`, `EMAIL_CODE_LENGTH` default `6`) control the lengths at each call site. `Agent` gains two new columns so its forgot-password flow can store a code alongside its existing reset token.

**Tech Stack:** NestJS, Prisma, `class-validator`, Node's built-in `crypto` module, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-otp-code-length-design.md`

## Global Constraints

- Phone OTP: 4 digits, via new env var `PHONE_OTP_LENGTH` (default `4`).
- Email codes (Admin/Agent 2FA setup+login, and the new Agent password-reset code): 6-8 digits, via new env var `EMAIL_CODE_LENGTH` (default `6`).
- Both env vars documented in `.env.example` following the existing `ENABLE_MOCK_OTP` comment-block style.
- Admin forgot-password is explicitly untouched — stays a link-only flow.
- The new shared generator uses `crypto.randomInt`, not `Math.random()` — this was called out and approved during brainstorming as a low-risk security improvement to the exact lines being touched anyway.
- No `Co-Authored-By: Claude` trailer on any commit.
- This plan is its own complete phase (not part of a larger multi-plan roadmap) — its closing task runs the full unit + e2e suite, per this project's scoped-test-runs convention (full suite at the true end of a phase).

---

### Task 1: Shared `generateNumericCode` utility

**Files:**
- Create: `src/common/generate-numeric-code.util.ts`
- Test: `src/common/generate-numeric-code.util.spec.ts`

**Interfaces:**
- Produces: `generateNumericCode(length: number): string` — returns a numeric string of exactly `length` digits, no leading-zero collapse, using `crypto.randomInt`.

- [ ] **Step 1: Write the failing test**

Create `src/common/generate-numeric-code.util.spec.ts`:

```typescript
import { generateNumericCode } from './generate-numeric-code.util';

describe('generateNumericCode', () => {
  it('returns a string of exactly 4 digits when length is 4', () => {
    expect(generateNumericCode(4)).toMatch(/^\d{4}$/);
  });

  it('returns a string of exactly 6 digits when length is 6', () => {
    expect(generateNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('returns a string of exactly 8 digits when length is 8', () => {
    expect(generateNumericCode(8)).toMatch(/^\d{8}$/);
  });

  it('never collapses a small random value into a shorter string', () => {
    const codes = Array.from({ length: 200 }, () => generateNumericCode(4));
    expect(codes.every((code) => code.length === 4)).toBe(true);
  });

  it('produces different codes across calls', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateNumericCode(6)));
    expect(codes.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/generate-numeric-code.util.spec.ts`
Expected: FAIL — `Cannot find module './generate-numeric-code.util'`.

- [ ] **Step 3: Implement the utility**

Create `src/common/generate-numeric-code.util.ts`:

```typescript
import { randomInt } from 'crypto';

export function generateNumericCode(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return randomInt(min, max + 1).toString();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/generate-numeric-code.util.spec.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/common/generate-numeric-code.util.ts src/common/generate-numeric-code.util.spec.ts
git commit -m "feat: add shared crypto-secure numeric code generator"
```

---

### Task 2: Phone OTP → 4 digits, configurable

**Files:**
- Modify: `src/otp/otp.service.ts`
- Modify: `src/auth/client/dto/verify-otp.dto.ts`
- Modify: `src/otp/otp.service.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `generateNumericCode(length: number): string` (Task 1).

- [ ] **Step 1: Update the existing unit tests**

Read `src/otp/otp.service.spec.ts` in full first. Replace the first test:

```typescript
  it('generates a 6-digit code, stores its hash, and sends it via the first provider', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.otpCode.create.mock.calls[0][0];
    expect(createArgs.data.phone).toBe('+2348000000000');
    expect(createArgs.data.purpose).toBe('CLIENT_LOGIN');
    expect(typeof createArgs.data.codeHash).toBe('string');
    expect(primarySend).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(secondarySend).not.toHaveBeenCalled();
  });
```

with:

```typescript
  it('generates a 4-digit code, stores its hash, and sends it via the first provider', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.otpCode.create.mock.calls[0][0];
    expect(createArgs.data.phone).toBe('+2348000000000');
    expect(createArgs.data.purpose).toBe('CLIENT_LOGIN');
    expect(typeof createArgs.data.codeHash).toBe('string');
    expect(primarySend).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringMatching(/^\d{4}$/),
    );
    expect(secondarySend).not.toHaveBeenCalled();
  });

  it('respects PHONE_OTP_LENGTH when configured', async () => {
    const configService = {
      get: jest.fn((key: string) => (key === 'PHONE_OTP_LENGTH' ? '8' : undefined)),
    } as unknown as ConfigService;
    const primarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(
      prisma as unknown as PrismaService,
      [fakeProvider('primary', primarySend)],
      configService,
    );

    await service.request('+2348000000000');

    expect(primarySend).toHaveBeenCalledWith('+2348000000000', expect.stringMatching(/^\d{8}$/));
  });
```

In the `describe('mock OTP support', ...)` block, replace every `'000000'` literal with `'0000'`, and change the "echoes the real generated code back as mockCode" test's regex from `/^\d{6}$/` to `/^\d{4}$/`:

```typescript
  describe('mock OTP support', () => {
    it('does not short-circuit verify() when ENABLE_MOCK_OTP is not configured', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn()),
      ]);
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+2348000000000', '0000');

      expect(result).toBe(false);
      expect(prisma.otpCode.findFirst).toHaveBeenCalled();
    });

    it('short-circuits verify() to true for the mock code without querying prisma when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '0000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn())],
        configService,
      );

      const result = await service.verify('+2348000000000', '0000');

      expect(result).toBe(true);
      expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    });

    it('echoes the real generated code back as mockCode when enabled', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_MOCK_OTP') return 'true';
          if (key === 'MOCK_OTP_CODE') return '0000';
          return undefined;
        }),
      } as unknown as ConfigService;
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        configService,
      );

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toEqual(expect.stringMatching(/^\d{4}$/));
    });

    it('omits mockCode from request() when disabled', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn().mockResolvedValue(undefined)),
      ]);

      const result = await service.request('+2348000000000');

      expect(result.mockCode).toBeUndefined();
    });
  });
```

(The two earlier tests in this file — `'rejects verification when no matching unconsumed code exists'` and `'accepts a correct, unexpired code and marks it consumed'` — use `'123456'` as an arbitrary stored/submitted code value. `bcrypt.compare`/`hashPassword` are length-agnostic, so these pass unchanged regardless of digit count; leave them as-is.)

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: FAIL — `generateCode()` still produces 6 digits, `PHONE_OTP_LENGTH` isn't read yet, `MOCK_OTP_CODE` default is still `000000`.

- [ ] **Step 3: Update `OtpService`**

In `src/otp/otp.service.ts`, remove the local generator function:

```typescript
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
```

Add the import `import { generateNumericCode } from '../common/generate-numeric-code.util';` alongside the existing imports.

Replace the start of `request()`:

```typescript
  async request(phone: string): Promise<{ mockCode?: string }> {
    const code = generateCode();
```

with:

```typescript
  async request(phone: string): Promise<{ mockCode?: string }> {
    const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
    const code = generateNumericCode(length);
```

In `verify()`, replace:

```typescript
    if (
      this.configService?.get('ENABLE_MOCK_OTP') === 'true' &&
      code === (this.configService?.get('MOCK_OTP_CODE') ?? '000000')
    ) {
      return true;
    }
```

with:

```typescript
    if (
      this.configService?.get('ENABLE_MOCK_OTP') === 'true' &&
      code === (this.configService?.get('MOCK_OTP_CODE') ?? '0000')
    ) {
      return true;
    }
```

- [ ] **Step 4: Update `VerifyOtpDto`**

Replace the full contents of `src/auth/client/dto/verify-otp.dto.ts`:

```typescript
import { IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsPhoneNumber()
  phone: string;

  // Must track PHONE_OTP_LENGTH's default (4) — class-validator DTOs
  // validate before any service code runs, so this can't read the env
  // var at request time. Keep this literal in sync if the default changes.
  @IsString()
  @Length(4, 4)
  code: string;
}
```

- [ ] **Step 5: Update `.env.example`**

Find the existing `OTP_TTL_SECONDS`/`ENABLE_MOCK_OTP`/`MOCK_OTP_CODE` block and update it:

```
OTP_TTL_SECONDS=300

# Length of the numeric code sent via SMS for client phone login.
PHONE_OTP_LENGTH=4

# Dev-only convenience: when enabled, OtpService.verify() accepts
# MOCK_OTP_CODE as valid for any phone number without touching the real
# stored OTP row, and OtpService.request()/the request-OTP response
# additionally echo back the real generated code as `mockCode`. No
# production-boot guard is enforced — this flag is trusted as configured.
ENABLE_MOCK_OTP=false
MOCK_OTP_CODE=0000
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 7: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/otp/otp.service.ts src/otp/otp.service.spec.ts src/auth/client/dto/verify-otp.dto.ts .env.example
git commit -m "feat: change phone OTP to 4 digits, configurable via PHONE_OTP_LENGTH"
```

---

### Task 3: Admin/Agent 2FA-via-email codes → configurable 6-8 digits, default 6

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`
- Delete: `src/common/generate-email-code.util.ts`
- Delete: `src/common/generate-email-code.util.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `generateNumericCode(length: number): string` (Task 1).
- Produces: `AdminAuthService`/`AgentAuthService` constructors gain an optional trailing `configService?: ConfigService` parameter (appended last, so every existing positional-argument call site in tests keeps working unchanged).

- [ ] **Step 1: Delete the old shared email-code generator**

Run: `rm src/common/generate-email-code.util.ts src/common/generate-email-code.util.spec.ts`

- [ ] **Step 2: Update `AdminAuthService`**

In `src/auth/admin/admin-auth.service.ts`, replace the import line:

```typescript
import { generateEmailCode } from '../../common/generate-email-code.util';
```

with:

```typescript
import { ConfigService } from '@nestjs/config';
import { generateNumericCode } from '../../common/generate-numeric-code.util';
```

Add `configService` as a new, optional, last constructor parameter:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly adminInviteService: AdminInviteService,
    private readonly emailService: EmailService,
    private readonly configService?: ConfigService,
  ) {}
```

In `setupTwoFactor`, replace:

```typescript
    const code = generateEmailCode();
```

with:

```typescript
    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
```

In the private `beginTwoFactorLogin`, replace:

```typescript
      const code = generateEmailCode();
```

with:

```typescript
      const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
      const code = generateNumericCode(length);
```

- [ ] **Step 3: Update `AgentAuthService`**

Apply the identical change to `src/auth/agent/agent-auth.service.ts`: replace the `generateEmailCode` import with the `ConfigService` and `generateNumericCode` imports (same paths, adjusted for this file's location — `'../../common/generate-numeric-code.util'`), add the optional trailing `configService?: ConfigService` constructor parameter, and apply the same `const length = ...; const code = generateNumericCode(length);` replacement at both the `setupTwoFactor` and `beginTwoFactorLogin` call sites.

- [ ] **Step 4: Add tests confirming `EMAIL_CODE_LENGTH` is respected**

In `src/auth/admin/admin-auth.service.spec.ts`, find the `describe('setupTwoFactor', ...)` block and add a new test inside it:

```typescript
    it('respects EMAIL_CODE_LENGTH when generating an EMAIL setup code', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', twoFactorEnabled: false });
      const configService = {
        get: jest.fn((key: string) => (key === 'EMAIL_CODE_LENGTH' ? '8' : undefined)),
      } as unknown as ConfigService;
      const configuredService = new AdminAuthService(
        prisma as unknown as PrismaService,
        tokenService,
        sessionService as unknown as SessionService,
        adminInviteService as unknown as AdminInviteService,
        emailService as unknown as EmailService,
        configService,
      );

      await configuredService.setupTwoFactor('admin-1', 'EMAIL' as never);

      const sentEmail = emailService.send.mock.calls[0][0];
      const match = /Your verification code is: (\d+)/.exec(sentEmail.text);
      expect(match?.[1]).toHaveLength(8);
    });
```

Add the import `import { ConfigService } from '@nestjs/config';` to this spec file's imports if not already present.

In `src/auth/agent/agent-auth.service.spec.ts`, find the `describe('setupTwoFactor', ...)` block (if the block doesn't exist under that exact name, find wherever `setupTwoFactor` is tested) and add the equivalent test, substituting `AgentAuthService`/`prisma.agent`/the agent constructor's 4 positional args (`prisma, tokenService, sessionService, emailService`) plus the new trailing `configService`:

```typescript
    it('respects EMAIL_CODE_LENGTH when generating an EMAIL setup code', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', email: 'agent@example.com', twoFactorEnabled: false });
      const configService = {
        get: jest.fn((key: string) => (key === 'EMAIL_CODE_LENGTH' ? '8' : undefined)),
      } as unknown as ConfigService;
      const configuredService = new AgentAuthService(
        prisma as unknown as PrismaService,
        tokenService,
        sessionService as unknown as SessionService,
        emailService as unknown as EmailService,
        configService,
      );

      await configuredService.setupTwoFactor('agent-1', 'EMAIL' as never);

      const sentEmail = emailService.send.mock.calls[0][0];
      const match = /Your verification code is: (\d+)/.exec(sentEmail.text);
      expect(match?.[1]).toHaveLength(8);
    });
```

Add the import `import { ConfigService } from '@nestjs/config';` to this spec file's imports if not already present.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — full files, including every pre-existing test (they construct these services without a `configService` argument, so `this.configService?.get(...)` evaluates to `undefined`, falling back to the default `?? 6` — identical generated-code shape to before this change, so nothing else should need updating).

- [ ] **Step 6: Update `.env.example`**

Add, right after the `MOCK_OTP_CODE` line from Task 2:

```

# Length of the numeric code emailed for Admin/Agent 2FA-via-email setup
# and login, and for the Agent forgot-password code option.
EMAIL_CODE_LENGTH=6
```

- [ ] **Step 7: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts src/auth/agent/agent-auth.service.ts src/auth/admin/admin-auth.service.spec.ts src/auth/agent/agent-auth.service.spec.ts .env.example
git rm src/common/generate-email-code.util.ts src/common/generate-email-code.util.spec.ts
git commit -m "feat: make Admin/Agent 2FA-email code length configurable via EMAIL_CODE_LENGTH"
```

---

### Task 4: Agent forgot-password gains a code-based reset option

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/auth/agent/agent-auth.service.ts`
- Create: `src/auth/agent/dto/reset-password-by-code.dto.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`
- Modify: `test/agent-password-self-service.e2e-spec.ts`

**Interfaces:**
- Consumes: `generateNumericCode(length: number): string` (Task 1); `AgentAuthService`'s `configService?: ConfigService` constructor param (Task 3).
- Produces: `AgentAuthService.resetPasswordByCode(email: string, code: string, newPassword: string): Promise<void>`. `forgotPassword`'s and `resetPassword`'s external signatures are unchanged; only their internal behavior changes.

- [ ] **Step 1: Add the new Prisma fields**

In `prisma/schema.prisma`, find the `Agent` model and add two new fields right after the existing `twoFactorEmailCodeExpiresAt` line:

```prisma
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
  passwordResetCodeHash       String?
  passwordResetCodeExpiresAt  DateTime?
}
```

Run: `npx prisma migrate dev --name add_agent_password_reset_code`
Expected: a new migration folder appears under `prisma/migrations/`, and the generated Prisma client picks up the two new `Agent` fields.

- [ ] **Step 2: Write the failing unit tests**

Read `src/auth/agent/agent-auth.service.spec.ts` in full first. Find the `describe('forgotPassword', ...)` block (or wherever `forgotPassword` is currently tested) and add:

```typescript
    it('stores both a reset token and a reset code with the same expiry, and emails both', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', email: 'agent@example.com', status: 'APPROVED' });

      await service.forgotPassword('agent@example.com');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({
            passwordResetTokenHash: expect.any(String),
            passwordResetTokenExpiresAt: expect.any(Date),
            passwordResetCodeHash: expect.any(String),
            passwordResetCodeExpiresAt: expect.any(Date),
          }),
        }),
      );
      const updateData = prisma.agent.update.mock.calls[0][0].data;
      expect(updateData.passwordResetTokenExpiresAt).toEqual(updateData.passwordResetCodeExpiresAt);

      const sentEmail = emailService.send.mock.calls[0][0];
      expect(sentEmail.text).toMatch(/reset your password:/);
      expect(sentEmail.text).toMatch(/enter this code: \d{6,8}/);
    });
```

Find the `describe('resetPassword', ...)` block and add:

```typescript
    it('clears the reset code alongside the reset token on success', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
      });

      await service.resetPassword('some-token', 'New-Password-123!');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            passwordResetTokenHash: null,
            passwordResetTokenExpiresAt: null,
            passwordResetCodeHash: null,
            passwordResetCodeExpiresAt: null,
          }),
        }),
      );
    });
```

Add a new top-level `describe` block for the new method:

```typescript
  describe('resetPasswordByCode', () => {
    it('throws UnauthorizedException when the email is unknown', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(service.resetPasswordByCode('nobody@example.com', '123456', 'New-Password-123!')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when there is no pending code', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', passwordResetCodeHash: null, passwordResetCodeExpiresAt: null });

      await expect(service.resetPasswordByCode('agent@example.com', '123456', 'New-Password-123!')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when the code has expired', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        passwordResetCodeHash: hashToken('123456'),
        passwordResetCodeExpiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.resetPasswordByCode('agent@example.com', '123456', 'New-Password-123!')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when the code does not match', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        passwordResetCodeHash: hashToken('654321'),
        passwordResetCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
      });

      await expect(service.resetPasswordByCode('agent@example.com', '123456', 'New-Password-123!')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('resets the password, clears both token and code fields, and revokes sessions on a correct code', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        passwordResetCodeHash: hashToken('123456'),
        passwordResetCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
      });

      await service.resetPasswordByCode('agent@example.com', '123456', 'New-Password-123!');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: expect.objectContaining({
          passwordHash: expect.any(String),
          mustChangePassword: false,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
          passwordResetCodeHash: null,
          passwordResetCodeExpiresAt: null,
        }),
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith(SessionPrincipalType.AGENT, 'agent-1', 'password_reset');
    });
  });
```

Add the imports `import { hashToken } from '../../common/opaque-token.util';` and `import { SessionPrincipalType } from '../../generated/prisma/client';` to this spec file if not already present (check first — `SessionPrincipalType` may already be imported for other tests in this file).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — `resetPasswordByCode` doesn't exist yet, `forgotPassword`/`resetPassword` don't touch the code fields yet.

- [ ] **Step 4: Rewrite `AgentAuthService.forgotPassword` and `resetPassword`, add `resetPasswordByCode`**

In `src/auth/agent/agent-auth.service.ts`, replace:

```typescript
  async forgotPassword(email: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.status !== AgentStatus.APPROVED) {
      return;
    }

    const token = generateOpaqueToken();
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetTokenExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.emailService.send({
      to: agent.email,
      subject: 'Reset your password',
      html: `<p>Use this token to reset your password: ${token}</p>`,
      text: `Use this token to reset your password: ${token}`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findFirst({
      where: { passwordResetTokenHash: hashToken(token) },
    });

    if (!agent || !agent.passwordResetTokenExpiresAt || agent.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, agent.id, 'password_reset');
  }
```

with:

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

    await this.emailService.send({
      to: agent.email,
      subject: 'Reset your password',
      html: `<p>Use this link to reset your password: ${token}</p><p>Or enter this code: ${code}</p>`,
      text: `Use this token to reset your password: ${token}\nOr enter this code: ${code}`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findFirst({
      where: { passwordResetTokenHash: hashToken(token) },
    });

    if (!agent || !agent.passwordResetTokenExpiresAt || agent.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
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

- [ ] **Step 5: Create `ResetPasswordByCodeDto`**

Create `src/auth/agent/dto/reset-password-by-code.dto.ts`:

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

- [ ] **Step 6: Add the new controller route**

In `src/auth/agent/agent-auth.controller.ts`, add the import `import { ResetPasswordByCodeDto } from './dto/reset-password-by-code.dto';`. Add a new route right after the existing `resetPassword` handler:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('reset-password/code')
  @HttpCode(200)
  async resetPasswordByCode(@Body() dto: ResetPasswordByCodeDto) {
    await this.agentAuthService.resetPasswordByCode(dto.email, dto.code, dto.newPassword);
    return { reset: true };
  }
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Extend the e2e test**

Read `test/agent-password-self-service.e2e-spec.ts` in full first. Add a new test at the end of the file, right before the closing `});` of the outer `describe`:

```typescript
  it(
    'resets the password via the forgot-password code and invalidates the token from the same request',
    async () => {
      const codeEmail = `e2e-agent-pw-code-${Date.now()}@example.com`;
      const passwordHash = await hashPassword(originalPassword);
      const codeAgent = await prisma.agent.create({
        data: {
          email: codeEmail,
          phone: '+2348012345679',
          fullName: 'E2E Password Code Test Agent',
          address: '1 Example Street, Lagos',
          cvKey: 'agent-documents/e2e-password-code-test/cv.pdf',
          status: 'APPROVED',
          passwordHash,
          mustChangePassword: false,
        },
      });

      await request(app.getHttpServer())
        .post('/auth/agent/forgot-password')
        .send({ email: codeEmail })
        .expect(200)
        .expect({ sent: true });

      expect(capturedEmail?.to).toBe(codeEmail);
      const codeMatch = capturedEmail?.text?.match(/enter this code: (\d+)/);
      const resetCode = codeMatch?.[1];
      expect(resetCode).toBeTruthy();
      const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
      const resetToken = tokenMatch?.[1];
      expect(resetToken).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password/code')
        .send({ email: codeEmail, code: resetCode, newPassword: 'Reset-By-Code-789!' })
        .expect(200)
        .expect({ reset: true });

      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email: codeEmail, password: 'Reset-By-Code-789!' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password')
        .send({ token: resetToken, newPassword: 'Should-Not-Work-123!' })
        .expect(401);

      await prisma.agent.deleteMany({ where: { id: codeAgent.id } });
    },
    30000,
  );
```

- [ ] **Step 9: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/agent-password-self-service.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/auth/agent/agent-auth.service.ts src/auth/agent/dto/reset-password-by-code.dto.ts src/auth/agent/agent-auth.controller.ts src/auth/agent/agent-auth.service.spec.ts test/agent-password-self-service.e2e-spec.ts
git commit -m "feat: add code-based forgot-password option for agents"
```

---

### Task 5: README, Postman, and the full test suite

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Update the README**

Find the existing documentation for client OTP request/verify and note it's now a 4-digit code (`PHONE_OTP_LENGTH`, default 4). Find the existing documentation for Admin/Agent 2FA setup/login and note the email code is now `EMAIL_CODE_LENGTH`-digit (default 6, configurable 6-8). Find (or add, if it doesn't exist) the Agent forgot-password documentation and note the email now contains both a reset link and a reset code, and document the new `POST /auth/agent/reset-password/code` endpoint (`{ email, code, newPassword }`).

- [ ] **Step 2: Update Postman**

Per this repo's `CLAUDE.md`:
- Find `POST /client/auth/otp/verify`'s saved example request bodies and change any 6-digit example code to a 4-digit one (e.g. `1234`).
- Find the Admin/Agent 2FA setup/login example bodies — no length constraint existed before or now, so these can stay as illustrative 6-digit examples, but add a one-line note in the request description that the code length is configurable (6-8, default 6).
- Add a new request under Agent's Auth folder: `POST /auth/agent/reset-password/code`, with a success example (`{ reset: true }`), a wrong-code failure example (`401`, matching `AgentAuthService.resetPasswordByCode`'s `UnauthorizedException('Invalid or expired reset code')` — Nest's default exception shape is `{ statusCode: 401, message: "Invalid or expired reset code", error: "Unauthorized" }`), and a validation-error example (`400`, `ValidationPipe`'s array-of-strings `message` shape) for a code outside the 6-8 length range. Update the existing `forgot-password` example's description to mention the email now contains both a link and a code.
- Use a surgical text-based/`Edit`-tool approach, never a full `json.load`/`json.dump` or `jq` whole-document rewrite (this has caused real, opposite-direction unicode-escaping regressions in past sessions — verify afterward with a byte-level em-dash/naira-sign check against `HEAD`).

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit**

```bash
git add README.md postman/public-sector-backend.postman_collection.json
git commit -m "docs: document OTP/verification code length changes"
```

- [ ] **Step 5: Run the full test suite**

This plan is its own complete phase — run the true full suite, not a scoped subset.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] Client phone-login OTP is 4 digits by default, configurable via `PHONE_OTP_LENGTH`.
- [ ] Admin/Agent 2FA-via-email codes are 6 digits by default, configurable (6-8) via `EMAIL_CODE_LENGTH`.
- [ ] Agent forgot-password emails both a reset link and a reset code; either resets the password and invalidates the other.
- [ ] Admin forgot-password is unchanged.
- [ ] The two duplicated `Math.random()`-based generators are gone, replaced by one `crypto.randomInt`-based shared utility.
- [ ] Full unit + e2e suite passes clean.
