# Admin Password Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Admin the self-service password capabilities it's missing entirely today — `forgot-password` → `reset-password`, and a voluntary `change-password` — the first of four plans implementing the Admin & Agent Self-Service Auth design. No 2FA in this plan.

**Architecture:** Extends the existing `AdminAuthService`/`AdminAuthController` (which today only has `login`/`accept-invite`) with three new methods/routes, reusing the exact opaque-token mechanism `AdminInviteService` already established. A new `AdminOnlyGuard`, mirroring the existing `ClientOnlyGuard`/`AgentOnlyGuard` exactly, protects `change-password`.

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-18-admin-agent-self-service-auth-design.md` (§2 "Forgot password / reset password" and "Change password", §4 Admin endpoints table, §8 item 1)

## Global Constraints

- `forgot-password` **always returns `200`**, regardless of whether the email matches a real, active admin — never leak account existence (spec §2, §6).
- `reset-password` force-revokes every existing session for that admin via `SessionService.revokeAllForPrincipal` — a reset implies the old password may be compromised (spec §2).
- `change-password` does **not** revoke other sessions — it's a voluntary action, not an incident response (spec §2), matching `AgentAuthService.changePassword`'s existing behavior exactly.
- The reset token uses the same `generateOpaqueToken()`/`hashToken()` utilities already used for `AdminInvite`, with a 1-hour expiry (spec §2).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example.
- This project does not want a `Co-Authored-By: Claude` trailer on any commit (saved memory `feedback_no_claude_commit_attribution.md`) — every commit in this plan omits it.

---

### Task 1: Schema — password reset token fields on `AdminUser`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `AdminUser.passwordResetTokenHash`/`.passwordResetTokenExpiresAt` — Task 3 depends on these exact field names.

- [ ] **Step 1: Add the fields**

In `prisma/schema.prisma`, add two fields inside the existing `AdminUser` model:

```prisma
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_admin_password_reset_token`
Expected: creates and applies `prisma/migrations/<timestamp>_add_admin_password_reset_token/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add password reset token fields to AdminUser"
```

(No `Co-Authored-By` trailer — this project's standing preference.)

---

### Task 2: `AdminOnlyGuard`

**Files:**
- Create: `src/auth/admin-only.guard.ts`
- Test: `src/auth/admin-only.guard.spec.ts`

**Interfaces:**
- Produces: `AdminOnlyGuard` — Task 4's `change-password` route consumes it.

This mirrors `src/auth/client-only.guard.ts` and `src/auth/agent-only.guard.ts` exactly — both already exist for their respective principal types; `AdminOnlyGuard` is the one missing piece of that trio.

- [ ] **Step 1: Write the failing test**

`src/auth/admin-only.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminOnlyGuard } from './admin-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminOnlyGuard', () => {
  const guard = new AdminOnlyGuard();

  it('allows an admin-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'admin', sub: 'a1' }))).toBe(true);
  });

  it('rejects a non-admin principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'agent', sub: 'ag1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/auth/admin-only.guard.spec.ts`
Expected: FAIL — `Cannot find module './admin-only.guard'`.

- [ ] **Step 3: Implement the guard**

`src/auth/admin-only.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.type !== 'admin') {
      throw new ForbiddenException('This endpoint is only available to Admin accounts');
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/auth/admin-only.guard.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth/admin-only.guard.ts src/auth/admin-only.guard.spec.ts
git commit -m "feat: add AdminOnlyGuard"
```

---

### Task 3: `AdminAuthService` extensions

**Files:**
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `EmailService` (existing, from `EmailModule` — not yet imported into `AuthModule`), `generateOpaqueToken`/`hashToken` (existing, `src/common/opaque-token.util.ts`), `SessionService.revokeAllForPrincipal` (existing).
- Produces: `AdminAuthService.forgotPassword(email): Promise<void>`, `.resetPassword(token, newPassword): Promise<void>`, `.changePassword(adminId, currentPassword, newPassword): Promise<void>` — Task 4's controller consumes all three.

- [ ] **Step 1: Update the tests**

Read `src/auth/admin/admin-auth.service.spec.ts` in full first (shown in this plan's own investigation — it currently mocks `prisma = { adminUser: { findUnique, create } }` with 6 tests). Replace the whole file with:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock; revokeAllForPrincipal: jest.Mock };
  let adminInviteService: { findValidByToken: jest.Mock; markAccepted: jest.Mock };
  let emailService: { send: jest.Mock };

  beforeEach(() => {
    prisma = {
      adminUser: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = {
      createSession: jest.fn().mockResolvedValue('refresh-token'),
      revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined),
    };
    adminInviteService = { findValidByToken: jest.fn(), markAccepted: jest.fn() };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      adminInviteService as unknown as AdminInviteService,
      emailService as unknown as EmailService,
    );
  });

  it('rejects unknown emails', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
    });

    await expect(
      service.login('admin@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens via SessionService with flattened permissions on a correct login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', email: 'admin@example.com', passwordHash, isActive: true })
      .mockResolvedValueOnce({
        id: 'admin-1',
        roles: [{ role: { permissions: [{ permission: { key: 'agents:read' } }] } }],
      });

    const result = await service.login('admin@example.com', 'correct-password', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['agents:read'],
    });
    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'ADMIN',
      principalId: 'admin-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
  });

  it('getPermissionsForAdmin flattens and de-duplicates permission keys', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      roles: [
        { role: { permissions: [{ permission: { key: 'agents:read' } }] } },
        { role: { permissions: [{ permission: { key: 'agents:read' } }, { permission: { key: 'roles:manage' } }] } },
      ],
    });

    const permissions = await service.getPermissionsForAdmin('admin-1');

    expect(permissions.sort()).toEqual(['agents:read', 'roles:manage']);
  });

  it('getPermissionsForAdmin returns an empty array for an unknown admin', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    expect(await service.getPermissionsForAdmin('nobody')).toEqual([]);
  });

  it('acceptInvite creates the AdminUser, assigns the invited role, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      roles: [{ role: { permissions: [] } }],
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new-admin@example.com',
        fullName: 'New Admin',
        roles: { create: { roleId: 'role-1' } },
      }),
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });

  describe('forgotPassword', () => {
    it('does nothing observable when the email does not match an active admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);

      await service.forgotPassword('nobody@example.com');

      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does nothing observable for a deactivated admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', email: 'a@example.com', isActive: false });

      await service.forgotPassword('a@example.com');

      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates a reset token, stores its hash, and emails it', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', email: 'a@example.com', isActive: true });

      await service.forgotPassword('a@example.com');

      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({
            passwordResetTokenHash: expect.any(String),
            passwordResetTokenExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown or expired token', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token past its expiry', async () => {
      prisma.adminUser.findFirst.mockResolvedValue({
        id: 'admin-1',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('expired-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('hashes the new password, clears the token, and revokes all sessions', async () => {
      prisma.adminUser.findFirst.mockResolvedValue({
        id: 'admin-1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });

      await service.resetPassword('good-token', 'new-password-123');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          passwordHash: expect.any(String),
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-1', 'password_reset');
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash });

      await expect(
        service.changePassword('admin-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });

    it('hashes the new password without revoking sessions', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash });

      await service.changePassword('admin-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.adminUser.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'admin-1' });
      expect(updateCall.data.passwordHash).not.toBe(passwordHash);
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: FAIL — the existing tests fail on constructor arity (5 args now, not 4), and `forgotPassword`/`resetPassword`/`changePassword` don't exist yet.

- [ ] **Step 3: Update `AdminAuthService`**

Replace `src/auth/admin/admin-auth.service.ts` with:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { JwtPayload } from '../jwt-payload.interface';
import { SessionPrincipalType } from '../../generated/prisma/client';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly adminInviteService: AdminInviteService,
    private readonly emailService: EmailService,
  ) {}

  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        roles: {
          include: {
            role: { include: { permissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!admin) {
      return [];
    }

    return Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );
  }

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokens(admin.id, meta);
  }

  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await bcrypt.hash(password, 12);

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roles: { create: { roleId: invite.roleId } },
      },
    });

    await this.adminInviteService.markAccepted(invite.id);

    return this.issueTokens(admin.id, meta);
  }

  async forgotPassword(email: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!admin || !admin.isActive) {
      return;
    }

    const token = generateOpaqueToken();
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetTokenExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.emailService.send({
      to: admin.email,
      subject: 'Reset your password',
      html: `<p>Use this token to reset your password: ${token}</p>`,
      text: `Use this token to reset your password: ${token}`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { passwordResetTokenHash: hashToken(token) },
    });

    if (!admin || !admin.passwordResetTokenExpiresAt || admin.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, admin.id, 'password_reset');
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    const passwordMatches = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash },
    });
  }

  private async issueTokens(adminId: string, meta?: { userAgent?: string; ip?: string }) {
    const permissions = await this.getPermissionsForAdmin(adminId);
    const payload: JwtPayload = { sub: adminId, type: 'admin', permissions };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.ADMIN,
      principalId: adminId,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}
```

- [ ] **Step 4: Wire `EmailModule` into `AuthModule`**

In `src/auth/auth.module.ts`, add `import { EmailModule } from '../email/email.module';` and add `EmailModule` to the `imports` array (alongside `OtpModule`, `SessionModule`, `AdminInviteModule`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — 14 tests (6 existing + 3 forgotPassword + 3 resetPassword + 2 changePassword — recount against the literal test file above before treating any other number as correct).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/auth/admin/admin-auth.service.ts src/auth/admin/admin-auth.service.spec.ts src/auth/auth.module.ts
git commit -m "feat: add forgotPassword/resetPassword/changePassword to AdminAuthService"
```

---

### Task 4: Controller endpoints and DTOs

**Files:**
- Create: `src/auth/admin/dto/forgot-password.dto.ts`
- Create: `src/auth/admin/dto/reset-password.dto.ts`
- Create: `src/auth/admin/dto/change-password.dto.ts`
- Modify: `src/auth/admin/admin-auth.controller.ts`

**Interfaces:**
- Consumes: `AdminAuthService.forgotPassword`/`.resetPassword`/`.changePassword` (Task 3), `AdminOnlyGuard` (Task 2).
- Produces: `POST /auth/admin/forgot-password`, `POST /auth/admin/reset-password`, `POST /auth/admin/change-password`.

- [ ] **Step 1: Add the DTOs**

`src/auth/admin/dto/forgot-password.dto.ts`:

```typescript
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}
```

`src/auth/admin/dto/reset-password.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
```

`src/auth/admin/dto/change-password.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
```

- [ ] **Step 2: Update the controller**

Replace `src/auth/admin/admin-auth.controller.ts` with:

```typescript
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { AdminOnlyGuard } from '../admin-only.guard';
import { JwtPayload } from '../jwt-payload.interface';

@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.adminAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.adminAuthService.acceptInvite(
      dto.token,
      dto.password,
      dto.fullName,
      getRequestMetadata(req),
    );
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.adminAuthService.forgotPassword(dto.email);
    return { sent: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.adminAuthService.resetPassword(dto.token, dto.newPassword);
    return { reset: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.adminAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    return { changed: true };
  }
}
```

- [ ] **Step 3: Type-check and run the auth unit suite**

Run: `npx jest src/auth && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/auth/admin/dto src/auth/admin/admin-auth.controller.ts
git commit -m "feat: add forgot-password/reset-password/change-password endpoints for Admin"
```

---

### Task 5: e2e test, README, and Postman

**Files:**
- Test: `test/admin-password-self-service.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Write the e2e test**

Read `test/agent-enrollment.e2e-spec.ts` first for this repo's exact `EMAIL_PROVIDERS` override convention (used to capture a sent email's plaintext content in a test without a real mailbox).

`test/admin-password-self-service.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin password self-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-admin-pw-${Date.now()}@example.com`;
  const originalPassword = 'Original-Password-123!';

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

    const passwordHash = await bcrypt.hash(originalPassword, 12);
    const admin = await prisma.adminUser.create({
      data: { email, passwordHash, fullName: 'E2E Password Test Admin' },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('changes the password via the authenticated change-password endpoint', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: originalPassword })
      .expect(200);
    const accessToken = loginRes.body.accessToken;

    await request(app.getHttpServer())
      .post('/auth/admin/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: originalPassword, newPassword: 'Changed-Password-456!' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: originalPassword })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Changed-Password-456!' })
      .expect(200);
  });

  it('resets the password via forgot-password and revokes existing sessions', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Changed-Password-456!' })
      .expect(200);
    const refreshToken = loginRes.body.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/admin/forgot-password')
      .send({ email })
      .expect(200)
      .expect({ sent: true });

    expect(capturedEmail?.to).toBe(email);
    const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
    const resetToken = tokenMatch?.[1];
    expect(resetToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/reset-password')
      .send({ token: resetToken, newPassword: 'Reset-Password-789!' })
      .expect(200)
      .expect({ reset: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Reset-Password-789!' })
      .expect(200);
  });

  it('forgot-password returns 200 even for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/admin/forgot-password')
      .send({ email: 'definitely-not-a-real-admin@example.com' })
      .expect(200)
      .expect({ sent: true });
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-password-self-service.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Login endpoints` section (grep for the exact heading first to confirm placement):

```markdown
## Admin password self-service

`POST /auth/admin/forgot-password` (`{ email }`, always `200` — never reveals
whether the email exists) emails a one-hour opaque reset token via the
same mechanism `AdminInvite` already uses. `POST /auth/admin/reset-password`
(`{ token, newPassword }`) consumes it and force-revokes every existing
session for that admin, since a reset implies the old password may be
compromised. `POST /auth/admin/change-password` (Admin JWT,
`{ currentPassword, newPassword }`) is the voluntary path — it does not
revoke other sessions.
```

- [ ] **Step 4: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the top-level **Admin** folder's existing **Auth** sub-folder (alongside `login`/`accept-invite`), add requests for:
- `POST /auth/admin/forgot-password - Success (200, always)`
- `POST /auth/admin/reset-password - Success`
- `POST /auth/admin/reset-password - Invalid/expired token (401)`
- `POST /auth/admin/change-password - Success`
- `POST /auth/admin/change-password - Wrong current password (401)`

Every request needs a saved response example per the standing `CLAUDE.md` rule (Nest's default exception shape: `{statusCode, message, error}`; reuse the already-established `401` shapes elsewhere in the collection). Use a surgical text-based insert, not a full JSON re-parse/re-dump.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this repo has known pre-existing environmental e2e flakiness under load.

- [ ] **Step 7: Commit**

```bash
git add test/admin-password-self-service.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add admin password self-service e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] An admin can change their own password while logged in, and their old password stops working immediately — proven by the e2e test.
- [ ] `forgot-password` never reveals whether an email is registered (always `200`) — proven by both the unit and e2e tests.
- [ ] Completing a password reset immediately invalidates all of that admin's existing sessions (a stale refresh token stops working) — proven by the e2e test.
- [ ] Postman has coverage for all three new endpoints.
