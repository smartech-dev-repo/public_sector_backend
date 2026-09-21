# Agent Two-Factor Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Agent enable 2FA (TOTP authenticator app or email code, their choice) and require it at login — the fourth and final plan implementing the Admin & Agent Self-Service Auth design. Per a 2026-09-21 design revision, this fully mirrors Admin's 2FA (`docs/superpowers/plans/2026-09-18-admin-two-factor-auth.md`), not the originally-planned email-only reduced version — Agent gets the same TOTP-or-email choice Admin has.

**Architecture:** Extends `AgentAuthService`/`AgentAuthController` (building on the password self-service work already shipped) with `setup`/`confirm`/`disable` and a modified `login` that branches into the pending-token flow when 2FA is active — the exact same shape as Admin's. `TokenService`'s `signTwoFactorPendingToken`/`verifyTwoFactorPendingToken` already exist (built in the Admin 2FA plan) and are principal-agnostic (`{ sub }` only) — **no changes needed there**, just reuse. `otplib` is already an installed dependency.

**Tech Stack:** NestJS 10, Prisma 7, `otplib` (already installed), Jest.

**Spec:** `docs/superpowers/specs/2026-09-18-admin-agent-self-service-auth-design.md` (§2 "2FA setup"/"2FA at login", §3 schema, §5 Agent endpoints table, §8 item 4 — see the 2026-09-21 revision notes throughout)

## Global Constraints

- Agent's 2FA is **not** a reduced version of Admin's — full `{ method: 'TOTP' | 'EMAIL' }` choice at setup, identical schema field set, identical error handling. Only the controller/service files differ (separate implementation per principal type, same pattern — matches how forgot-password/reset-password were already done).
- The pending token reuses `TokenService.signTwoFactorPendingToken`/`.verifyTwoFactorPendingToken` **as-is** — these already exist from the Admin 2FA plan and take/return only `{ sub }`, with no principal-type-specific logic. Do not add a second pair of methods.
- `2fa/setup` while already enabled → `409`. `2fa/confirm` with no pending setup in progress → `409`. `2fa/disable` requires re-confirming the current password (spec §2, §6).
- 2FA only becomes active once `2fa/confirm` succeeds (spec §2).
- When `twoFactorEnabled` is `false` (everyone's default), `login` behaves exactly as it does today — zero behavior change for anyone who hasn't opted in (spec §2). This includes the existing `hasLoggedIn: true` update and `mustChangePassword` forced-change interaction, both of which happen **before** the 2FA branch — an agent's password is confirmed correct (and thus `resend-credentials` becomes permanently disabled) the moment they enter the right password, regardless of whether 2FA subsequently succeeds.
- The API uses the `TwoFactorMethod` enum's own casing (`'TOTP'`/`'EMAIL'`) directly, matching Admin's convention and this codebase's existing pattern of exposing Prisma enums directly in API responses.
- `POST /auth/agent/2fa/login-verify` gets the same sensitive-route rate limit (`@Throttle({ default: { limit: 5, ttl: 900000 } })`) as every other route on this controller.
- Password hashing goes through the shared `hashPassword()` util, not raw `bcrypt.hash(x, 12)` — matches every other password-hashing call site in this codebase.
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example.
- This project does not want a `Co-Authored-By: Claude` trailer on any commit (saved memory `feedback_no_claude_commit_attribution.md`) — every commit in this plan omits it.

---

### Task 1: Schema — 2FA fields on `Agent`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Agent`'s 2FA fields — every later task depends on these exact names.

- [ ] **Step 1: Add the fields**

In `prisma/schema.prisma`, add these fields inside the existing `Agent` model (identical set to `AdminUser`'s equivalent fields, already shipped in the Admin 2FA plan — `Agent.passwordResetTokenHash`/`.passwordResetTokenExpiresAt` already exist from the Agent password self-service plan, so only the 2FA fields below are new). The `TwoFactorMethod` enum itself already exists (added in the Admin 2FA plan) — do not redefine it.

```prisma
  twoFactorMethod             TwoFactorMethod?
  twoFactorEnabled            Boolean          @default(false)
  twoFactorSecret             String?
  twoFactorPendingSecret      String?
  twoFactorPendingMethod      TwoFactorMethod?
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_agent_two_factor_auth`
Expected: creates and applies `prisma/migrations/<timestamp>_add_agent_two_factor_auth/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add TwoFactorMethod fields to Agent"
```

(No `Co-Authored-By` trailer — this project's standing preference.)

---

### Task 2: `AgentAuthService` — 2FA setup/confirm/disable

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`

**Interfaces:**
- Consumes: `generateEmailCode` (`src/common/generate-email-code.util.ts`, already exists), `otplib`'s `generateSecret`/`generateURI`/`verify` (already used by `AdminAuthService`).
- Produces: `AgentAuthService.setupTwoFactor(agentId, method): Promise<{ method: TwoFactorMethod; secret?: string; otpauthUrl?: string }>`, `.confirmTwoFactor(agentId, code): Promise<void>`, `.disableTwoFactor(agentId, currentPassword): Promise<void>` — Task 4's controller consumes all three.

This mirrors `docs/superpowers/plans/2026-09-18-admin-two-factor-auth.md`'s Task 3 exactly, adapted for the `Agent` model (`this.prisma.agent` instead of `this.prisma.adminUser`, `agent.passwordHash!` — nullable on `Agent`, unlike `AdminUser` — in the `disableTwoFactor` password check).

- [ ] **Step 1: Add the failing tests**

Read `src/auth/agent/agent-auth.service.spec.ts` in full first (it currently has 13 tests: 3 `login`, 2 `getMustChangePasswordForAgent`, 2 `changePassword`, 3 `forgotPassword`, 3 `resetPassword`). Add `import { verify as otplibVerify } from 'otplib';` and the mock `jest.mock('otplib', () => ({ ...jest.requireActual('otplib'), verify: jest.fn() }));` at the top of the file (module level, alongside the other imports), and add these `describe` blocks at the end of the file, before the closing `});` of the outer `describe('AgentAuthService', ...)`:

```typescript
  describe('setupTwoFactor', () => {
    it('throws ConflictException when 2FA is already enabled', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', twoFactorEnabled: true });
      await expect(service.setupTwoFactor('agent-1', 'TOTP')).rejects.toThrow(ConflictException);
    });

    it('generates a TOTP secret and otpauth URL, storing the secret as pending', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('agent-1', 'TOTP');

      expect(result.method).toBe('TOTP');
      expect(result.secret).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({ twoFactorPendingMethod: 'TOTP', twoFactorPendingSecret: result.secret }),
        }),
      );
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates and emails a code for the email method, without returning a secret', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('agent-1', 'EMAIL');

      expect(result).toEqual({ method: 'EMAIL' });
      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({
            twoFactorPendingMethod: 'EMAIL',
            twoFactorEmailCodeHash: expect.any(String),
            twoFactorEmailCodeExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
    });
  });

  describe('confirmTwoFactor', () => {
    it('throws ConflictException when no setup is in progress', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', twoFactorPendingMethod: null });
      await expect(service.confirmTwoFactor('agent-1', '123456')).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid TOTP code without enabling 2FA', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.confirmTwoFactor('agent-1', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('activates TOTP on a valid code', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      await service.confirmTwoFactor('agent-1', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: 'a-different-hash',
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await expect(service.confirmTwoFactor('agent-1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('activates email 2FA on a matching code', async () => {
      const { hashToken: realHashToken } = jest.requireActual('../../common/opaque-token.util');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: realHashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await service.confirmTwoFactor('agent-1', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: true });

      await expect(service.disableTwoFactor('agent-1', 'wrong-password')).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when 2FA is not enabled', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: false });

      await expect(service.disableTwoFactor('agent-1', 'correct-password')).rejects.toThrow(ConflictException);
    });

    it('clears all two-factor fields on success', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: true });

      await service.disableTwoFactor('agent-1', 'correct-password');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — `service.setupTwoFactor is not a function` and similarly for the other two new methods.

- [ ] **Step 3: Implement the three methods**

In `src/auth/agent/agent-auth.service.ts`, add these imports:

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

Add these three methods to the class (after `resetPassword`):

```typescript
  async setupTwoFactor(agentId: string, method: TwoFactorMethod) {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    if (agent.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is already enabled');
    }

    if (method === TwoFactorMethod.TOTP) {
      const secret = generateSecret();
      await this.prisma.agent.update({
        where: { id: agentId },
        data: { twoFactorPendingMethod: TwoFactorMethod.TOTP, twoFactorPendingSecret: secret },
      });
      const otpauthUrl = generateURI({ issuer: 'Public Sector Backend', label: agent.email, secret });
      return { method: TwoFactorMethod.TOTP, secret, otpauthUrl };
    }

    const code = generateEmailCode();
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({
      to: agent.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
    return { method: TwoFactorMethod.EMAIL };
  }

  async confirmTwoFactor(agentId: string, code: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    if (!agent.twoFactorPendingMethod) {
      throw new ConflictException('No two-factor setup in progress');
    }

    if (agent.twoFactorPendingMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: agent.twoFactorPendingSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }

      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: TwoFactorMethod.TOTP,
          twoFactorSecret: agent.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
      return;
    }

    if (
      !agent.twoFactorEmailCodeHash ||
      !agent.twoFactorEmailCodeExpiresAt ||
      agent.twoFactorEmailCodeExpiresAt < new Date() ||
      agent.twoFactorEmailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: TwoFactorMethod.EMAIL,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
  }

  async disableTwoFactor(agentId: string, currentPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (!agent.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is not enabled');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
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

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — 24 tests (13 existing + 3 setupTwoFactor + 5 confirmTwoFactor + 3 disableTwoFactor — recount against the literal test code above before treating any other number as correct).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/agent/agent-auth.service.ts src/auth/agent/agent-auth.service.spec.ts
git commit -m "feat: add Agent 2FA setup/confirm/disable to AgentAuthService"
```

---

### Task 3: `AgentAuthService` — 2FA at login

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`

**Interfaces:**
- Consumes: `TokenService.signTwoFactorPendingToken`/`.verifyTwoFactorPendingToken` (already exist, built in the Admin 2FA plan — no changes to `TokenService` in this plan at all).
- Produces: `login`'s new branch (returns `{ twoFactorRequired, method, pendingToken }` when 2FA is enabled), `AgentAuthService.verifyTwoFactorLogin(pendingToken, code, meta?): Promise<{accessToken, refreshToken}>` — Task 4's controller consumes `verifyTwoFactorLogin`.

Unlike `AdminAuthService` (which already had a private `issueTokens` helper before the 2FA plan touched it), `AgentAuthService.login` currently inlines its token-issuing logic directly. This task extracts that into a private `issueTokens` helper first — a small, behavior-preserving refactor — so `login` and the new `verifyTwoFactorLogin` can both call it without duplicating the session-creation/token-signing logic.

- [ ] **Step 1: Add the failing tests**

Add to `src/auth/agent/agent-auth.service.spec.ts` (extending the existing `describe('AgentAuthService', ...)` block once more, after the `disableTwoFactor` block added in Task 2):

```typescript
  describe('login with 2FA enabled', () => {
    it('returns a pending token instead of real tokens for a TOTP agent, without sending email', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        twoFactorEnabled: true,
        twoFactorMethod: 'TOTP',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('agent@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'TOTP', pendingToken: 'pending-token' });
      expect(emailService.send).not.toHaveBeenCalled();
      expect(sessionService.createSession).not.toHaveBeenCalled();
      expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'agent-1' }, data: { hasLoggedIn: true } });
    });

    it('emails a code and returns a pending token for an EMAIL agent', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        twoFactorEnabled: true,
        twoFactorMethod: 'EMAIL',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('agent@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'EMAIL', pendingToken: 'pending-token' });
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
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
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
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
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorMethod: 'TOTP',
        twoFactorSecret: 'SOMESECRET',
        mustChangePassword: false,
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      const result = await service.verifyTwoFactorLogin('good-pending-token', '123456', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: 'agent-1' }),
      );
    });

    it('rejects an invalid or expired email code, and clears it on a valid one', async () => {
      const { hashToken: realHashToken } = jest.requireActual('../../common/opaque-token.util');
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorMethod: 'EMAIL',
        twoFactorEmailCodeHash: realHashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
        mustChangePassword: false,
      });

      await service.verifyTwoFactorLogin('good-pending-token', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — `login` doesn't check `twoFactorEnabled` yet, and `service.verifyTwoFactorLogin` doesn't exist.

- [ ] **Step 3: Extract `issueTokens`, update `login`, and add `verifyTwoFactorLogin`**

Replace the existing `login` method in `src/auth/agent/agent-auth.service.ts` with:

```typescript
  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.status !== 'APPROVED' || !agent.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.agent.update({ where: { id: agent.id }, data: { hasLoggedIn: true } });

    if (agent.twoFactorEnabled) {
      return this.beginTwoFactorLogin(agent);
    }

    return this.issueTokens(agent, meta);
  }
```

Add these three methods (two private, one public) after the existing `disableTwoFactor` (added in Task 2):

```typescript
  private async beginTwoFactorLogin(agent: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    if (agent.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const code = generateEmailCode();
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({
        to: agent.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(agent.id);
    return { twoFactorRequired: true, method: agent.twoFactorMethod, pendingToken };
  }

  async verifyTwoFactorLogin(pendingToken: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    let payload: { sub: string };
    try {
      payload = this.tokenService.verifyTwoFactorPendingToken(pendingToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired pending token');
    }

    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: payload.sub } });

    if (agent.twoFactorMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: agent.twoFactorSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }
    } else {
      if (
        !agent.twoFactorEmailCodeHash ||
        !agent.twoFactorEmailCodeExpiresAt ||
        agent.twoFactorEmailCodeExpiresAt < new Date() ||
        agent.twoFactorEmailCodeHash !== hashToken(code)
      ) {
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

    return this.issueTokens(agent, meta);
  }

  private async issueTokens(agent: { id: string; mustChangePassword: boolean }, meta?: { userAgent?: string; ip?: string }) {
    const payload = { sub: agent.id, type: 'agent' as const, mustChangePassword: agent.mustChangePassword };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.AGENT,
      principalId: agent.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — 30 tests (24 from Task 2 + 2 login-with-2FA + 4 verifyTwoFactorLogin — recount against the literal test code above before treating any other number as correct). The pre-existing `login` tests (from before this plan) must still pass unchanged, since a 2FA-disabled agent's login behavior is identical to before.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/agent/agent-auth.service.ts src/auth/agent/agent-auth.service.spec.ts
git commit -m "feat: gate Agent login behind 2FA when enabled"
```

---

### Task 4: Controller endpoints, DTOs, and module wiring

**Files:**
- Create: `src/auth/agent/dto/setup-two-factor.dto.ts`
- Create: `src/auth/agent/dto/confirm-two-factor.dto.ts`
- Create: `src/auth/agent/dto/disable-two-factor.dto.ts`
- Create: `src/auth/agent/dto/two-factor-login-verify.dto.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`

**Interfaces:**
- Consumes: `AgentAuthService.setupTwoFactor`/`.confirmTwoFactor`/`.disableTwoFactor`/`.verifyTwoFactorLogin` (Tasks 2-3), `AgentOnlyGuard` (already exists).
- Produces: `POST /auth/agent/2fa/setup`, `POST /auth/agent/2fa/confirm`, `POST /auth/agent/2fa/disable`, `POST /auth/agent/2fa/login-verify`.

- [ ] **Step 1: Add the DTOs**

`src/auth/agent/dto/setup-two-factor.dto.ts`:

```typescript
import { IsEnum } from 'class-validator';
import { TwoFactorMethod } from '../../../generated/prisma/client';

export class SetupTwoFactorDto {
  @IsEnum(TwoFactorMethod)
  method: TwoFactorMethod;
}
```

`src/auth/agent/dto/confirm-two-factor.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class ConfirmTwoFactorDto {
  @IsString()
  code: string;
}
```

`src/auth/agent/dto/disable-two-factor.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class DisableTwoFactorDto {
  @IsString()
  currentPassword: string;
}
```

`src/auth/agent/dto/two-factor-login-verify.dto.ts`:

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

Read `src/auth/agent/agent-auth.controller.ts` in full first (it currently has `login`/`change-password`/`forgot-password`/`reset-password`, all `@Throttle`-decorated). Add these imports:

```typescript
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import { ConfirmTwoFactorDto } from './dto/confirm-two-factor.dto';
import { DisableTwoFactorDto } from './dto/disable-two-factor.dto';
import { TwoFactorLoginVerifyDto } from './dto/two-factor-login-verify.dto';
```

Add these four methods to the class, after `change-password`:

```typescript
  @Post('2fa/setup')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  setupTwoFactor(@Body() dto: SetupTwoFactorDto, @Req() req: { user: JwtPayload }) {
    return this.agentAuthService.setupTwoFactor(req.user.sub, dto.method);
  }

  @Post('2fa/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async confirmTwoFactor(@Body() dto: ConfirmTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.confirmTwoFactor(req.user.sub, dto.code);
    return { enabled: true };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async disableTwoFactor(@Body() dto: DisableTwoFactorDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.disableTwoFactor(req.user.sub, dto.currentPassword);
    return { disabled: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('2fa/login-verify')
  @HttpCode(200)
  verifyTwoFactorLogin(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
    return this.agentAuthService.verifyTwoFactorLogin(dto.pendingToken, dto.code, getRequestMetadata(req));
  }
```

- [ ] **Step 3: Type-check and run the auth unit suite**

Run: `npx jest src/auth && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/auth/agent/dto src/auth/agent/agent-auth.controller.ts
git commit -m "feat: add Agent 2FA setup/confirm/disable/login-verify endpoints"
```

---

### Task 5: e2e tests, README, and Postman

**Files:**
- Test: `test/agent-two-factor-auth.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Write the e2e test**

Read `test/admin-two-factor-auth.e2e-spec.ts` and `test/agent-password-self-service.e2e-spec.ts` first — this test mirrors the Admin 2FA e2e test almost exactly, adapted for `Agent`'s fixture shape (`address`/`cvKey`/`status: 'APPROVED'`, matching the Agent password self-service e2e test's fixture creation).

`test/agent-two-factor-auth.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { generateSecret, generate } from 'otplib';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password-hash.util';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent two-factor authentication (e2e)', () => {
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

  async function createAgentAndLogin(email: string) {
    const passwordHash = await hashPassword(password);
    const agent = await prisma.agent.create({
      data: {
        email,
        phone: '+2348012345678',
        fullName: 'E2E 2FA Test Agent',
        address: '1 Example Street, Lagos',
        cvKey: 'agent-documents/e2e-2fa-test/cv.pdf',
        status: 'APPROVED',
        passwordHash,
        mustChangePassword: false,
      },
    });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password })
      .expect(200);
    return { agentId: agent.id, accessToken: loginRes.body.accessToken };
  }

  it(
    'completes a full TOTP setup, login, and disable round-trip',
    async () => {
      const email = `e2e-agent-2fa-totp-${Date.now()}@example.com`;
      const { agentId, accessToken } = await createAgentAndLogin(email);

      const setupRes = await request(app.getHttpServer())
        .post('/auth/agent/2fa/setup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ method: 'TOTP' })
        .expect(200);
      const secret = setupRes.body.secret;
      expect(secret).toBeTruthy();

      const validCode = await generate({ secret });
      await request(app.getHttpServer())
        .post('/auth/agent/2fa/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: validCode })
        .expect(200)
        .expect({ enabled: true });

      const loginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password })
        .expect(200);
      expect(loginRes.body.twoFactorRequired).toBe(true);
      expect(loginRes.body.method).toBe('TOTP');
      const pendingToken = loginRes.body.pendingToken;

      const loginCode = await generate({ secret });
      const verifyRes = await request(app.getHttpServer())
        .post('/auth/agent/2fa/login-verify')
        .send({ pendingToken, code: loginCode })
        .expect(200);
      expect(verifyRes.body.accessToken).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/2fa/disable')
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .send({ currentPassword: password })
        .expect(200)
        .expect({ disabled: true });

      const finalLoginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password })
        .expect(200);
      expect(finalLoginRes.body.twoFactorRequired).toBeUndefined();
      expect(finalLoginRes.body.accessToken).toBeTruthy();

      await prisma.agent.deleteMany({ where: { id: agentId } });
    },
    30000,
  );

  it(
    'completes a full email-OTP setup and login round-trip',
    async () => {
      const email = `e2e-agent-2fa-email-${Date.now()}@example.com`;
      const { agentId, accessToken } = await createAgentAndLogin(email);

      await request(app.getHttpServer())
        .post('/auth/agent/2fa/setup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ method: 'EMAIL' })
        .expect(200)
        .expect({ method: 'EMAIL' });

      expect(capturedEmail?.to).toBe(email);
      let codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
      const setupCode = codeMatch?.[1];
      expect(setupCode).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/2fa/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: setupCode })
        .expect(200)
        .expect({ enabled: true });

      const loginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password })
        .expect(200);
      expect(loginRes.body.twoFactorRequired).toBe(true);
      expect(loginRes.body.method).toBe('EMAIL');

      codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
      const loginCode = codeMatch?.[1];

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/agent/2fa/login-verify')
        .send({ pendingToken: loginRes.body.pendingToken, code: loginCode })
        .expect(200);
      expect(verifyRes.body.accessToken).toBeTruthy();

      await prisma.agent.deleteMany({ where: { id: agentId } });
    },
    30000,
  );

  it(
    'rejects a login-verify call with a wrong code without invalidating the pending token',
    async () => {
      const email = `e2e-agent-2fa-retry-${Date.now()}@example.com`;
      const { agentId, accessToken } = await createAgentAndLogin(email);

      const setupRes = await request(app.getHttpServer())
        .post('/auth/agent/2fa/setup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ method: 'TOTP' })
        .expect(200);
      const secret = setupRes.body.secret;
      const setupCode = await generate({ secret });
      await request(app.getHttpServer())
        .post('/auth/agent/2fa/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: setupCode })
        .expect(200);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password })
        .expect(200);
      const pendingToken = loginRes.body.pendingToken;

      await request(app.getHttpServer())
        .post('/auth/agent/2fa/login-verify')
        .send({ pendingToken, code: '000000' })
        .expect(401);

      const validCode = await generate({ secret });
      await request(app.getHttpServer())
        .post('/auth/agent/2fa/login-verify')
        .send({ pendingToken, code: validCode })
        .expect(200);

      await prisma.agent.deleteMany({ where: { id: agentId } });
    },
    30000,
  );
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/agent-two-factor-auth.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Agent password self-service` section:

```markdown
## Agent two-factor authentication

Identical shape to Admin's 2FA (see "Admin two-factor authentication"
above) — `POST /auth/agent/2fa/setup` (`{ method: 'TOTP' | 'EMAIL' }`),
`POST /auth/agent/2fa/confirm` (`{ code }`), `POST /auth/agent/2fa/disable`
(`{ currentPassword }`), and `POST /auth/agent/login` returning
`{ twoFactorRequired: true, method, pendingToken }` when enabled, completed
via `POST /auth/agent/2fa/login-verify` (`{ pendingToken, code }`). Agent
was originally scoped to email-OTP-only given its mobile-app context, but
that was revised to give Agent the same TOTP option Admin has.
```

- [ ] **Step 4: Add Postman coverage**

Under the top-level Agent folder's existing Auth sub-folder, add requests for:
- `POST /auth/agent/2fa/setup - TOTP`
- `POST /auth/agent/2fa/setup - EMAIL`
- `POST /auth/agent/2fa/setup - Already enabled (409)`
- `POST /auth/agent/2fa/confirm - Success`
- `POST /auth/agent/2fa/confirm - Invalid code (401)`
- `POST /auth/agent/2fa/disable - Success`
- `POST /auth/agent/login - Two-factor required` (a variant of the existing login-success request, showing the `twoFactorRequired` response shape)
- `POST /auth/agent/2fa/login-verify - Success`
- `POST /auth/agent/2fa/login-verify - Invalid code (401)`

Every request needs a saved response example per the standing `CLAUDE.md` rule, authored from the actual controller/service code — reuse Admin's own 2FA request examples as a direct template (same shapes, different route prefix). Use a surgical text-based insert, not a full JSON re-parse/re-dump.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this repo has known pre-existing environmental e2e flakiness under machine load, not a code defect.

- [ ] **Step 7: Commit**

```bash
git add test/agent-two-factor-auth.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add agent two-factor auth e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] An agent can enable TOTP 2FA, log in through the two-step pending-token flow using a real authenticator-generated code, and disable it again — proven by the e2e test.
- [ ] The same round-trip works for email-based 2FA, reading the code from a captured email exactly like the agent-enrollment e2e test already does.
- [ ] A pending token can never be used as a real Bearer token on any guarded route — already proven once by `TokenService`'s own unit test in the Admin 2FA plan (this plan reuses that same mechanism unchanged).
- [ ] An agent who never enables 2FA sees zero change in their login flow — proven by every pre-existing login-related unit/e2e test continuing to pass unchanged.
- [ ] Postman has coverage for all four new endpoints plus the changed `login` response shape.
