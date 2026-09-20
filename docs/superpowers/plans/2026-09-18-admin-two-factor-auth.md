# Admin Two-Factor Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin enable 2FA (TOTP authenticator app or email code, their choice) and require it at login — the second of four plans implementing the Admin & Agent Self-Service Auth design.

**Architecture:** Extends `AdminAuthService`/`AdminAuthController` further (building on the password self-service work already shipped) with `setup`/`confirm`/`disable` and a modified `login` that branches into a short-lived pending-token flow when 2FA is active. `TokenService` gains two new methods signing/verifying against a **separate secret** from the normal access token, so a pending token is cryptographically incapable of being used as a real Bearer token anywhere. Uses `otplib`'s modern functional API (`generateSecret`/`generateURI`/`verify`) for TOTP.

**Tech Stack:** NestJS 10, Prisma 7, `otplib@^13.5.0`, Jest.

**Spec:** `docs/superpowers/specs/2026-09-18-admin-agent-self-service-auth-design.md` (§2 "2FA setup"/"2FA at login", §3 schema/`TokenService`, §4 Admin endpoints table, §8 item 2)

## Global Constraints

- The pending token is signed with `JWT_TWO_FACTOR_PENDING_SECRET`, a **different** secret from `JWT_ACCESS_SECRET`. This is the core security property of this whole plan: `JwtStrategy` only ever validates against `JWT_ACCESS_SECRET`, so a pending token can never be accepted by any guarded route, even by accident (spec §2, §3).
- `2fa/setup` while already enabled → `409` (must `disable` first). `2fa/confirm` with no pending setup in progress → `409`. `2fa/disable` requires re-confirming the current password (spec §2, §6).
- 2FA only becomes active once `2fa/confirm` succeeds — a botched TOTP scan or a lost email never leaves an admin in a half-enabled state (spec §2).
- When `twoFactorEnabled` is `false` (everyone's default), `login` behaves exactly as it does today — zero behavior change for anyone who hasn't opted in (spec §2).
- The API uses the `TwoFactorMethod` enum's own casing (`'TOTP'`/`'EMAIL'`) directly in request/response bodies — matching how this codebase already exposes other Prisma enums (e.g. `VarianceStatus`, `AgentStatus`) directly in API responses, rather than introducing a separate lowercase convention.
- A wrong code at `2fa/login-verify` does **not** invalidate the pending token — retryable within its 5-minute window (spec §6).
- `POST /auth/admin/2fa/login-verify` gets the same sensitive-route rate limit (`@Throttle({ default: { limit: 5, ttl: 900000 } })`) as every other admin auth endpoint in this codebase, per the Hardening work and the fix already applied to the other four admin auth routes.
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example.
- This project does not want a `Co-Authored-By: Claude` trailer on any commit (saved memory `feedback_no_claude_commit_attribution.md`) — every commit in this plan omits it.

---

### Task 1: Schema and dependency

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `package.json`, `package-lock.json` (via `npm install`)
- Modify: `.env.example`

**Interfaces:**
- Produces: `TwoFactorMethod` enum, `AdminUser`'s 2FA fields — every later task depends on these exact names.

- [ ] **Step 1: Install `otplib`**

Run: `npm install otplib@^13.5.0`
Expected: installs cleanly (no peer-dependency declarations to conflict with this project's NestJS 10 — `otplib` has none).

- [ ] **Step 2: Add the enum and fields**

In `prisma/schema.prisma`, add:

```prisma
enum TwoFactorMethod {
  TOTP
  EMAIL
}
```

Add these fields inside the existing `AdminUser` model:

```prisma
  twoFactorMethod             TwoFactorMethod?
  twoFactorEnabled            Boolean          @default(false)
  twoFactorSecret             String?
  twoFactorPendingSecret      String?
  twoFactorPendingMethod      TwoFactorMethod?
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
```

- [ ] **Step 3: Generate and run the migration**

Run: `npx prisma migrate dev --name add_admin_two_factor_auth`
Expected: creates and applies `prisma/migrations/<timestamp>_add_admin_two_factor_auth/migration.sql`.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 5: Add the new env var**

Append to `.env.example`:

```
JWT_TWO_FACTOR_PENDING_SECRET=change-me-two-factor-pending
```

Check whether a real (gitignored) `.env` file exists in this repo; if it does, add a real value for `JWT_TWO_FACTOR_PENDING_SECRET` to it too (any distinct random string — it must differ from `JWT_ACCESS_SECRET`'s value, that's the entire point of this secret existing).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations package.json package-lock.json .env.example
git commit -m "feat: add TwoFactorMethod schema and otplib dependency for Admin 2FA"
```

(No `Co-Authored-By` trailer — this project's standing preference.)

---

### Task 2: Shared email-code util and `TokenService`'s pending-token methods

**Files:**
- Create: `src/common/generate-email-code.util.ts`
- Test: `src/common/generate-email-code.util.spec.ts`
- Modify: `src/auth/token.service.ts`
- Create: `src/auth/token.service.spec.ts`

**Interfaces:**
- Produces: `generateEmailCode(): string`, `TokenService.signTwoFactorPendingToken(sub: string): string`, `.verifyTwoFactorPendingToken(token: string): { sub: string }` — Task 3/4 consume all three.

`generateEmailCode` is a small shared utility (like `generateOpaqueToken`/`hashToken` already are), not a duplicated "implementation" — Admin's email-2FA path and the later Agent 2FA plan both need a 6-digit code generator, and this is exactly the kind of tiny pure-formatting helper this codebase already shares across principal types.

- [ ] **Step 1: Write the failing tests**

`src/common/generate-email-code.util.spec.ts`:

```typescript
import { generateEmailCode } from './generate-email-code.util';

describe('generateEmailCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateEmailCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('produces different codes across calls (not a constant)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateEmailCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
```

`src/auth/token.service.spec.ts`:

```typescript
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

describe('TokenService', () => {
  let tokenService: TokenService;
  let jwtService: JwtService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'JWT_TWO_FACTOR_PENDING_SECRET') return 'pending-secret';
        if (key === 'JWT_ACCESS_SECRET') return 'access-secret';
        throw new Error(`unexpected config key: ${key}`);
      }),
      get: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;
    jwtService = new JwtService({});
    tokenService = new TokenService(jwtService, configService);
  });

  describe('two-factor pending token', () => {
    it('signs a token that verifies back to the same sub', () => {
      const token = tokenService.signTwoFactorPendingToken('admin-1');
      const payload = tokenService.verifyTwoFactorPendingToken(token);
      expect(payload.sub).toBe('admin-1');
    });

    it('rejects a token signed with a different secret (e.g. a real access token)', () => {
      const accessToken = tokenService.signAccessToken({ sub: 'admin-1', type: 'admin' });
      expect(() => tokenService.verifyTwoFactorPendingToken(accessToken)).toThrow();
    });

    it('rejects an expired pending token', () => {
      const expiredToken = jwtService.sign({ sub: 'admin-1' }, { secret: 'pending-secret', expiresIn: '-10s' });
      expect(() => tokenService.verifyTwoFactorPendingToken(expiredToken)).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/common/generate-email-code.util.spec.ts src/auth/token.service.spec.ts`
Expected: FAIL — `Cannot find module './generate-email-code.util'`, and `TokenService.signTwoFactorPendingToken is not a function`.

- [ ] **Step 3: Implement**

`src/common/generate-email-code.util.ts`:

```typescript
export function generateEmailCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
```

Replace `src/auth/token.service.ts` with:

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_TTL', '15m'),
    });
  }

  signTwoFactorPendingToken(sub: string): string {
    return this.jwtService.sign(
      { sub },
      {
        secret: this.configService.getOrThrow<string>('JWT_TWO_FACTOR_PENDING_SECRET'),
        expiresIn: '5m',
      },
    );
  }

  verifyTwoFactorPendingToken(token: string): { sub: string } {
    return this.jwtService.verify(token, {
      secret: this.configService.getOrThrow<string>('JWT_TWO_FACTOR_PENDING_SECRET'),
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/common/generate-email-code.util.spec.ts src/auth/token.service.spec.ts`
Expected: PASS — 5 tests (2 + 3).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/common/generate-email-code.util.ts src/common/generate-email-code.util.spec.ts src/auth/token.service.ts src/auth/token.service.spec.ts
git commit -m "feat: add generateEmailCode util and TokenService two-factor pending token methods"
```

---

### Task 3: `AdminAuthService` — 2FA setup/confirm/disable

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`

**Interfaces:**
- Consumes: `generateEmailCode` (Task 2), `otplib`'s `generateSecret`/`generateURI`/`verify`.
- Produces: `AdminAuthService.setupTwoFactor(adminId, method): Promise<{ method: TwoFactorMethod; secret?: string; otpauthUrl?: string }>`, `.confirmTwoFactor(adminId, code): Promise<void>`, `.disableTwoFactor(adminId, currentPassword): Promise<void>` — Task 5's controller consumes all three.

- [ ] **Step 1: Add the failing tests**

Read `src/auth/admin/admin-auth.service.spec.ts` in full first (it currently has 14 tests from the password self-service plan). Add these `describe` blocks to the end of the file, and add `otplib` mocking at the top — since `otplib`'s `generateSecret`/`generateURI`/`verify` are real crypto/formatting functions with no network I/O, mock only `verify` (the one call whose result needs to be deterministic per test case) via `jest.mock('otplib', ...)`, letting `generateSecret`/`generateURI` run for real (they're pure and fast):

```typescript
import { verify as otplibVerify } from 'otplib';

jest.mock('otplib', () => ({
  ...jest.requireActual('otplib'),
  verify: jest.fn(),
}));

// ...inside the existing describe('AdminAuthService', () => { ... }) block, add:

  describe('setupTwoFactor', () => {
    it('throws ConflictException when 2FA is already enabled', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', twoFactorEnabled: true });
      await expect(service.setupTwoFactor('admin-1', 'TOTP')).rejects.toThrow(ConflictException);
    });

    it('generates a TOTP secret and otpauth URL, storing the secret as pending', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('admin-1', 'TOTP');

      expect(result.method).toBe('TOTP');
      expect(result.secret).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({ twoFactorPendingMethod: 'TOTP', twoFactorPendingSecret: result.secret }),
        }),
      );
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates and emails a code for the email method, without returning a secret', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('admin-1', 'EMAIL');

      expect(result).toEqual({ method: 'EMAIL' });
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({
            twoFactorPendingMethod: 'EMAIL',
            twoFactorEmailCodeHash: expect.any(String),
            twoFactorEmailCodeExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com' }));
    });
  });

  describe('confirmTwoFactor', () => {
    it('throws ConflictException when no setup is in progress', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', twoFactorPendingMethod: null });
      await expect(service.confirmTwoFactor('admin-1', '123456')).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid TOTP code without enabling 2FA', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.confirmTwoFactor('admin-1', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('activates TOTP on a valid code', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      await service.confirmTwoFactor('admin-1', '123456');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: 'TOTP',
          twoFactorSecret: 'SOMESECRET',
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
    });

    it('rejects an invalid/expired email code', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: 'a-different-hash',
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await expect(service.confirmTwoFactor('admin-1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('activates email 2FA on a matching code', async () => {
      const { hashToken } = jest.requireActual('../../common/opaque-token.util');
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: hashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await service.confirmTwoFactor('admin-1', '123456');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: 'EMAIL',
          twoFactorPendingMethod: null,
          twoFactorEmailCodeHash: null,
          twoFactorEmailCodeExpiresAt: null,
        },
      });
    });
  });

  describe('disableTwoFactor', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: true });

      await expect(service.disableTwoFactor('admin-1', 'wrong-password')).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when 2FA is not enabled', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: false });

      await expect(service.disableTwoFactor('admin-1', 'correct-password')).rejects.toThrow(ConflictException);
    });

    it('clears all two-factor fields on success', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: true });

      await service.disableTwoFactor('admin-1', 'correct-password');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: false,
          twoFactorMethod: null,
          twoFactorSecret: null,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
          twoFactorEmailCodeHash: null,
          twoFactorEmailCodeExpiresAt: null,
        },
      });
    });
  });
```

Add `ConflictException` to the existing `@nestjs/common` import line at the top of the file (alongside `UnauthorizedException`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: FAIL — `service.setupTwoFactor is not a function` and similarly for the other two new methods.

- [ ] **Step 3: Implement the three methods**

In `src/auth/admin/admin-auth.service.ts`, add these imports:

```typescript
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import { generateEmailCode } from '../../common/generate-email-code.util';
import { TwoFactorMethod } from '../../generated/prisma/client';
```

Add this constant near the existing `PASSWORD_RESET_TTL_MS`:

```typescript
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
```

Add these three methods to the class (after `changePassword`, before the private `issueTokens`):

```typescript
  async setupTwoFactor(adminId: string, method: TwoFactorMethod) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (admin.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is already enabled');
    }

    if (method === TwoFactorMethod.TOTP) {
      const secret = generateSecret();
      await this.prisma.adminUser.update({
        where: { id: adminId },
        data: { twoFactorPendingMethod: TwoFactorMethod.TOTP, twoFactorPendingSecret: secret },
      });
      const otpauthUrl = generateURI({ issuer: 'Public Sector Backend', label: admin.email, secret });
      return { method: TwoFactorMethod.TOTP, secret, otpauthUrl };
    }

    const code = generateEmailCode();
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({
      to: admin.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
    return { method: TwoFactorMethod.EMAIL };
  }

  async confirmTwoFactor(adminId: string, code: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    if (!admin.twoFactorPendingMethod) {
      throw new ConflictException('No two-factor setup in progress');
    }

    if (admin.twoFactorPendingMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: admin.twoFactorPendingSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }

      await this.prisma.adminUser.update({
        where: { id: adminId },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: TwoFactorMethod.TOTP,
          twoFactorSecret: admin.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
      return;
    }

    if (
      !admin.twoFactorEmailCodeHash ||
      !admin.twoFactorEmailCodeExpiresAt ||
      admin.twoFactorEmailCodeExpiresAt < new Date() ||
      admin.twoFactorEmailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: TwoFactorMethod.EMAIL,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
  }

  async disableTwoFactor(adminId: string, currentPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    const passwordMatches = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (!admin.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is not enabled');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — 25 tests (14 existing + 3 setupTwoFactor + 5 confirmTwoFactor + 3 disableTwoFactor — recount against the literal test code above before treating any other number as correct).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts src/auth/admin/admin-auth.service.spec.ts
git commit -m "feat: add Admin 2FA setup/confirm/disable to AdminAuthService"
```

---

### Task 4: `AdminAuthService` — 2FA at login

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`

**Interfaces:**
- Consumes: `TokenService.signTwoFactorPendingToken`/`.verifyTwoFactorPendingToken` (Task 2).
- Produces: `login`'s new branch (returns `{ twoFactorRequired, method, pendingToken }` when 2FA is enabled), `AdminAuthService.verifyTwoFactorLogin(pendingToken, code, meta?): Promise<{accessToken, refreshToken}>` — Task 5's controller consumes `verifyTwoFactorLogin`.

- [ ] **Step 1: Add the failing tests**

Add to `src/auth/admin/admin-auth.service.spec.ts` (extending the existing `describe('AdminAuthService', ...)` block once more):

```typescript
  describe('login with 2FA enabled', () => {
    it('returns a pending token instead of real tokens for a TOTP admin, without sending email', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        passwordHash,
        isActive: true,
        twoFactorEnabled: true,
        twoFactorMethod: 'TOTP',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('admin@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'TOTP', pendingToken: 'pending-token' });
      expect(emailService.send).not.toHaveBeenCalled();
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });

    it('emails a code and returns a pending token for an EMAIL admin', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        passwordHash,
        isActive: true,
        twoFactorEnabled: true,
        twoFactorMethod: 'EMAIL',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('admin@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'EMAIL', pendingToken: 'pending-token' });
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com' }));
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({ twoFactorEmailCodeHash: expect.any(String) }),
        }),
      );
    });
  });

  describe('verifyTwoFactorLogin', () => {
    it('rejects an invalid or expired pending token', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockImplementation(() => {
          throw new Error('expired');
        });

      await expect(service.verifyTwoFactorLogin('bad-token', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an invalid TOTP code', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'admin-1' });
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorMethod: 'TOTP',
        twoFactorSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.verifyTwoFactorLogin('good-pending-token', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });

    it('issues real tokens on a valid TOTP code', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'admin-1' });
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorMethod: 'TOTP',
        twoFactorSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        roles: [{ role: { permissions: [] } }],
      });

      const result = await service.verifyTwoFactorLogin('good-pending-token', '123456', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: 'admin-1' }),
      );
    });

    it('rejects an invalid or expired email code, and clears it on a valid one', async () => {
      const { hashToken: realHashToken } = jest.requireActual('../../common/opaque-token.util');
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'admin-1' });
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorMethod: 'EMAIL',
        twoFactorEmailCodeHash: realHashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        roles: [{ role: { permissions: [] } }],
      });

      await service.verifyTwoFactorLogin('good-pending-token', '123456');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: FAIL — `login` doesn't check `twoFactorEnabled` yet, and `service.verifyTwoFactorLogin` doesn't exist.

- [ ] **Step 3: Update `login` and add `verifyTwoFactorLogin`**

Replace the existing `login` method in `src/auth/admin/admin-auth.service.ts` with:

```typescript
  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (admin.twoFactorEnabled) {
      return this.beginTwoFactorLogin(admin);
    }

    return this.issueTokens(admin.id, meta);
  }
```

Add these two methods (one private, one public) after `disableTwoFactor`:

```typescript
  private async beginTwoFactorLogin(admin: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    if (admin.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const code = generateEmailCode();
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({
        to: admin.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(admin.id);
    return { twoFactorRequired: true, method: admin.twoFactorMethod, pendingToken };
  }

  async verifyTwoFactorLogin(pendingToken: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    let payload: { sub: string };
    try {
      payload = this.tokenService.verifyTwoFactorPendingToken(pendingToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired pending token');
    }

    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: payload.sub } });

    if (admin.twoFactorMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: admin.twoFactorSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }
    } else {
      if (
        !admin.twoFactorEmailCodeHash ||
        !admin.twoFactorEmailCodeExpiresAt ||
        admin.twoFactorEmailCodeExpiresAt < new Date() ||
        admin.twoFactorEmailCodeHash !== hashToken(code)
      ) {
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

    return this.issueTokens(admin.id, meta);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — 31 tests (25 from Task 3 + 2 login-with-2FA + 4 verifyTwoFactorLogin — recount against the literal test code above before treating any other number as correct).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts src/auth/admin/admin-auth.service.spec.ts
git commit -m "feat: gate Admin login behind 2FA when enabled"
```

---

### Task 5: Controller endpoints, DTOs, and module wiring

**Files:**
- Create: `src/auth/admin/dto/setup-two-factor.dto.ts`
- Create: `src/auth/admin/dto/confirm-two-factor.dto.ts`
- Create: `src/auth/admin/dto/disable-two-factor.dto.ts`
- Create: `src/auth/admin/dto/two-factor-login-verify.dto.ts`
- Modify: `src/auth/admin/admin-auth.controller.ts`

**Interfaces:**
- Consumes: `AdminAuthService.setupTwoFactor`/`.confirmTwoFactor`/`.disableTwoFactor`/`.verifyTwoFactorLogin` (Tasks 3-4), `AdminOnlyGuard` (already exists).
- Produces: `POST /auth/admin/2fa/setup`, `POST /auth/admin/2fa/confirm`, `POST /auth/admin/2fa/disable`, `POST /auth/admin/2fa/login-verify`.

- [ ] **Step 1: Add the DTOs**

`src/auth/admin/dto/setup-two-factor.dto.ts`:

```typescript
import { IsEnum } from 'class-validator';
import { TwoFactorMethod } from '../../../generated/prisma/client';

export class SetupTwoFactorDto {
  @IsEnum(TwoFactorMethod)
  method: TwoFactorMethod;
}
```

`src/auth/admin/dto/confirm-two-factor.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class ConfirmTwoFactorDto {
  @IsString()
  code: string;
}
```

`src/auth/admin/dto/disable-two-factor.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class DisableTwoFactorDto {
  @IsString()
  currentPassword: string;
}
```

`src/auth/admin/dto/two-factor-login-verify.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class TwoFactorLoginVerifyDto {
  @IsString()
  pendingToken: string;

  @IsString()
  code: string;
}
```

- [ ] **Step 2: Update the controller**

Read `src/auth/admin/admin-auth.controller.ts` in full first (it currently has `login`/`accept-invite`/`forgot-password`/`reset-password`/`change-password`, with `@Throttle({ default: { limit: 5, ttl: 900000 } })` on `login`/`forgot-password`/`reset-password`/`change-password`). Add these imports:

```typescript
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import { ConfirmTwoFactorDto } from './dto/confirm-two-factor.dto';
import { DisableTwoFactorDto } from './dto/disable-two-factor.dto';
import { TwoFactorLoginVerifyDto } from './dto/two-factor-login-verify.dto';
```

Add these four methods to the class, after `changePassword`:

```typescript
  @Post('2fa/setup')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  setupTwoFactor(@Body() dto: SetupTwoFactorDto, @Req() req: { user: JwtPayload }) {
    return this.adminAuthService.setupTwoFactor(req.user.sub, dto.method);
  }

  @Post('2fa/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async confirmTwoFactor(@Body() dto: ConfirmTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.confirmTwoFactor(req.user.sub, dto.code);
    return { enabled: true };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async disableTwoFactor(@Body() dto: DisableTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.disableTwoFactor(req.user.sub, dto.currentPassword);
    return { disabled: true };
  }

  @Post('2fa/login-verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  verifyTwoFactorLogin(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
    return this.adminAuthService.verifyTwoFactorLogin(dto.pendingToken, dto.code, getRequestMetadata(req));
  }
```

- [ ] **Step 3: Type-check and run the auth unit suite**

Run: `npx jest src/auth && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/auth/admin/dto src/auth/admin/admin-auth.controller.ts
git commit -m "feat: add Admin 2FA setup/confirm/disable/login-verify endpoints"
```

---

### Task 6: e2e tests, README, and Postman

**Files:**
- Test: `test/admin-two-factor-auth.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Write the e2e test**

Read `test/agent-enrollment.e2e-spec.ts` and `test/admin-password-self-service.e2e-spec.ts` first for the `EMAIL_PROVIDERS` override convention already established.

`test/admin-two-factor-auth.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { generateSecret, generate } from 'otplib';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin two-factor authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capturedEmail: EmailMessage | undefined;
  const password = 'Original-Password-123!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmail = message;
          },
        },
      ])
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createAdminAndLogin(email: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.create({
      data: { email, passwordHash, fullName: 'E2E 2FA Test Admin' },
    });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    return { adminId: admin.id, accessToken: loginRes.body.accessToken };
  }

  it('completes a full TOTP setup, login, and disable round-trip', async () => {
    const email = `e2e-2fa-totp-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    const setupRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'TOTP' })
      .expect(200);
    const secret = setupRes.body.secret;
    expect(secret).toBeTruthy();

    const validCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: validCode })
      .expect(200)
      .expect({ enabled: true });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(loginRes.body.twoFactorRequired).toBe(true);
    expect(loginRes.body.method).toBe('TOTP');
    const pendingToken = loginRes.body.pendingToken;

    const loginCode = await generate({ secret });
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: loginCode })
      .expect(200);
    expect(verifyRes.body.accessToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/disable')
      .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
      .send({ currentPassword: password })
      .expect(200)
      .expect({ disabled: true });

    const finalLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(finalLoginRes.body.twoFactorRequired).toBeUndefined();
    expect(finalLoginRes.body.accessToken).toBeTruthy();

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  });

  it('completes a full email-OTP setup and login round-trip', async () => {
    const email = `e2e-2fa-email-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'EMAIL' })
      .expect(200)
      .expect({ method: 'EMAIL' });

    expect(capturedEmail?.to).toBe(email);
    let codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
    const setupCode = codeMatch?.[1];
    expect(setupCode).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: setupCode })
      .expect(200)
      .expect({ enabled: true });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(loginRes.body.twoFactorRequired).toBe(true);
    expect(loginRes.body.method).toBe('EMAIL');

    codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
    const loginCode = codeMatch?.[1];

    const verifyRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken: loginRes.body.pendingToken, code: loginCode })
      .expect(200);
    expect(verifyRes.body.accessToken).toBeTruthy();

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  });

  it('rejects a login-verify call with a wrong code without invalidating the pending token', async () => {
    const email = `e2e-2fa-retry-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    const setupRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'TOTP' })
      .expect(200);
    const secret = setupRes.body.secret;
    const setupCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: setupCode })
      .expect(200);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    const pendingToken = loginRes.body.pendingToken;

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: '000000' })
      .expect(401);

    const validCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: validCode })
      .expect(200);

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  });
});
```

Note the explicit `30000`ms would not be needed here since each test does a modest number of requests, but if the full-suite run shows this file's tests approaching the default 5000ms timeout, add a third `it()` argument the same way `test/reconciliation.e2e-spec.ts` already does — check the actual run time first before adding one preemptively.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-two-factor-auth.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Admin password self-service` section (added by the previous plan):

```markdown
## Admin two-factor authentication

An admin can enable 2FA via `POST /auth/admin/2fa/setup` (`{ method: 'TOTP' | 'EMAIL' }`,
`409` if already enabled), confirm it via `POST /auth/admin/2fa/confirm`
(`{ code }` — only activates on a real, successfully-verified code, so a
botched setup never locks anyone out), and turn it off via
`POST /auth/admin/2fa/disable` (`{ currentPassword }`, requires
re-confirming the password). Once enabled, `POST /auth/admin/login`
returns `{ twoFactorRequired: true, method, pendingToken }` instead of
real tokens — `pendingToken` is signed with a **separate secret**
(`JWT_TWO_FACTOR_PENDING_SECRET`), so it's cryptographically incapable of
being used as a real Bearer token anywhere. `POST /auth/admin/2fa/login-verify`
(`{ pendingToken, code }`) completes the login and issues real tokens.
```

- [ ] **Step 4: Add Postman coverage**

Under the top-level Admin folder's existing Auth sub-folder, add requests for:
- `POST /auth/admin/2fa/setup - TOTP`
- `POST /auth/admin/2fa/setup - EMAIL`
- `POST /auth/admin/2fa/setup - Already enabled (409)`
- `POST /auth/admin/2fa/confirm - Success`
- `POST /auth/admin/2fa/confirm - Invalid code (401)`
- `POST /auth/admin/2fa/disable - Success`
- `POST /auth/admin/login - Two-factor required` (a variant of the existing login-success request, showing the `twoFactorRequired` response shape)
- `POST /auth/admin/2fa/login-verify - Success`
- `POST /auth/admin/2fa/login-verify - Invalid code (401)`

Every request needs a saved response example per the standing `CLAUDE.md` rule, authored from the actual controller/service code. Use a surgical text-based insert, not a full JSON re-parse/re-dump.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this repo has known pre-existing environmental e2e flakiness under load (bcrypt-heavy app bootstraps under machine load, not a code defect).

- [ ] **Step 7: Commit**

```bash
git add test/admin-two-factor-auth.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add admin two-factor auth e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] An admin can enable TOTP 2FA, log in through the two-step pending-token flow using a real authenticator-generated code, and disable it again — proven by the e2e test.
- [ ] The same round-trip works for email-based 2FA, reading the code from a captured email exactly like the agent-enrollment e2e test already does.
- [ ] A pending token can never be used as a real Bearer token on any guarded route — proven by `TokenService`'s own unit test (a real access token is rejected by `verifyTwoFactorPendingToken`, and by construction the reverse also holds since they're signed with different secrets).
- [ ] An admin who never enables 2FA sees zero change in their login flow — proven by every pre-existing login-related unit/e2e test continuing to pass unchanged.
- [ ] Postman has coverage for all four new endpoints plus the changed `login` response shape.
