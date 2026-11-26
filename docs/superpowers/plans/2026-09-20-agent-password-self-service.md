# Agent Password Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Agent `forgot-password` → `reset-password` — the third of four plans implementing the Admin & Agent Self-Service Auth design. `change-password` already exists from the enrollment work, so it's not rebuilt here.

**Architecture:** Extends the existing `AgentAuthService`/`AgentAuthController` with two new methods/routes, reusing the exact same pattern already shipped for Admin (`docs/superpowers/plans/2026-09-18-admin-password-self-service.md`) — same opaque-token mechanism, same "always 200" forgot-password behavior, same force-revoke-sessions-on-reset behavior. `AgentOnlyGuard` already exists (built during the enrollment work), so no new guard is needed this time.

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-18-admin-agent-self-service-auth-design.md` (§2 "Forgot password / reset password", §5 Agent endpoints table, §8 item 3)

## Global Constraints

- `forgot-password` **always returns `200`**, regardless of whether the email matches a real, `APPROVED` agent — never leak account existence (spec §2, §6). Gated on `status === APPROVED` (the Agent equivalent of Admin's `isActive` check) — a `PENDING_REVIEW` or `REJECTED` agent has no real credentials to reset.
- `reset-password` force-revokes every existing session for that agent via `SessionService.revokeAllForPrincipal`, and also clears `mustChangePassword` — resetting via a verified email token is itself "establishing a real password of the agent's own choosing," so it shouldn't leave them still forced through the separate change-password flow afterward.
- The reset token uses the same `generateOpaqueToken()`/`hashToken()` utilities already used for `AdminInvite` and Admin's own password reset, with a 1-hour expiry.
- Both new routes get the same sensitive-route rate limit (`@Throttle({ default: { limit: 5, ttl: 900000 } })`) as `login`/`change-password` already have on this controller.
- Password hashing goes through the shared `hashPassword()` util (`src/common/password-hash.util.ts`), not raw `bcrypt.hash(x, 12)` — matches every other password-hashing call site in this codebase as of the recent bcrypt-cost hardening work.
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example.
- This project does not want a `Co-Authored-By: Claude` trailer on any commit (saved memory `feedback_no_claude_commit_attribution.md`) — every commit in this plan omits it.

---

### Task 1: Schema — password reset token fields on `Agent`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Agent.passwordResetTokenHash`/`.passwordResetTokenExpiresAt` — Task 2 depends on these exact field names.

- [ ] **Step 1: Add the fields**

In `prisma/schema.prisma`, add two fields inside the existing `Agent` model (same names/types as `AdminUser`'s equivalent fields, added in the Admin password self-service plan):

```prisma
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_agent_password_reset_token`
Expected: creates and applies `prisma/migrations/<timestamp>_add_agent_password_reset_token/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add password reset token fields to Agent"
```

(No `Co-Authored-By` trailer — this project's standing preference.)

---

### Task 2: `AgentAuthService` extensions

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`

**Interfaces:**
- Consumes: `EmailService` (already imported into `AuthModule` — no module wiring change needed this time), `generateOpaqueToken`/`hashToken` (`src/common/opaque-token.util.ts`), `hashPassword` (`src/common/password-hash.util.ts`), `SessionService.revokeAllForPrincipal` (all existing).
- Produces: `AgentAuthService.forgotPassword(email): Promise<void>`, `.resetPassword(token, newPassword): Promise<void>` — Task 3's controller consumes both.

- [ ] **Step 1: Update the tests**

Read `src/auth/agent/agent-auth.service.spec.ts` in full first (it currently has 7 tests, and its mocked `prisma.agent` only has `findUnique`/`findUniqueOrThrow`/`update` — no `findFirst` yet — and its mocked `sessionService` only has `createSession` — no `revokeAllForPrincipal` yet). Add `EmailService` to the constructor mock, add `findFirst: jest.fn()` to the mocked `prisma.agent`, add `revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined)` to the mocked `sessionService`, and add these `describe` blocks:

```typescript
import { EmailService } from '../../email/email.service';

// ...inside the existing beforeEach, add:
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      emailService as unknown as EmailService,
    );

// ...declare alongside the other `let` variables at the top of the describe block:
  let emailService: { send: jest.Mock };

// ...add these describe blocks at the end of the file, before the closing `});` of the outer describe:

  describe('forgotPassword', () => {
    it('does nothing observable when the email does not match an approved agent', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await service.forgotPassword('nobody@example.com');

      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does nothing observable for a non-approved agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', email: 'a@example.com', status: 'PENDING_REVIEW' });

      await service.forgotPassword('a@example.com');

      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates a reset token, stores its hash, and emails it', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', email: 'a@example.com', status: 'APPROVED' });

      await service.forgotPassword('a@example.com');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
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
      prisma.agent.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token past its expiry', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('expired-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('hashes the new password, clears mustChangePassword and the token, and revokes all sessions', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });

      await service.resetPassword('good-token', 'new-password-123');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: {
          passwordHash: expect.any(String),
          mustChangePassword: false,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('AGENT', 'agent-1', 'password_reset');
    });
  });
```

Also add `findFirst: jest.fn()` to the existing mocked `prisma.agent` object if it isn't already there (check the file's current shape first — it likely has `findUnique`/`findUniqueOrThrow`/`update` already from prior work, but not `findFirst`), and add `revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined)` to the existing mocked `sessionService` object if it isn't already there.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — constructor arity mismatch (4 args now, not 3), and `forgotPassword`/`resetPassword` don't exist yet.

- [ ] **Step 3: Update `AgentAuthService`**

Read `src/auth/agent/agent-auth.service.ts` in full first. Add these imports:

```typescript
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { hashPassword } from '../../common/password-hash.util';
import { AgentStatus } from '../../generated/prisma/client';
```

Add `private readonly emailService: EmailService,` to the constructor parameter list (after `sessionService`).

Add this constant near the top of the file (module scope, alongside any existing constants — there are none yet in this file, so add it just above the `@Injectable()` class):

```typescript
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
```

Add these two methods to the class, after the existing `changePassword`:

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — 13 tests (7 existing + 3 `forgotPassword` + 3 `resetPassword`).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/agent/agent-auth.service.ts src/auth/agent/agent-auth.service.spec.ts
git commit -m "feat: add forgotPassword/resetPassword to AgentAuthService"
```

---

### Task 3: Controller endpoints and DTOs

**Files:**
- Create: `src/auth/agent/dto/forgot-password.dto.ts`
- Create: `src/auth/agent/dto/reset-password.dto.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`

**Interfaces:**
- Consumes: `AgentAuthService.forgotPassword`/`.resetPassword` (Task 2).
- Produces: `POST /auth/agent/forgot-password`, `POST /auth/agent/reset-password`.

- [ ] **Step 1: Add the DTOs**

`src/auth/agent/dto/forgot-password.dto.ts`:

```typescript
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}
```

`src/auth/agent/dto/reset-password.dto.ts`:

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

- [ ] **Step 2: Update the controller**

Read `src/auth/agent/agent-auth.controller.ts` in full first (it currently has `login`/`change-password`, both `@Throttle`-decorated). Add these imports:

```typescript
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
```

Add these two methods to the class, after `login` and before `change-password` (or after `change-password` — exact ordering doesn't matter, just keep both new methods together and consistent with the file's existing style):

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.agentAuthService.forgotPassword(dto.email);
    return { sent: true };
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.agentAuthService.resetPassword(dto.token, dto.newPassword);
    return { reset: true };
  }
```

- [ ] **Step 3: Type-check and run the auth unit suite**

Run: `npx jest src/auth && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/auth/agent/dto src/auth/agent/agent-auth.controller.ts
git commit -m "feat: add forgot-password/reset-password endpoints for Agent"
```

---

### Task 4: e2e test, README, and Postman

**Files:**
- Test: `test/agent-password-self-service.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-3.

- [ ] **Step 1: Write the e2e test**

Read `test/admin-password-self-service.e2e-spec.ts` first — this test mirrors it almost exactly, adapted for `Agent` (which needs `address`/`cvKey` on creation, per its schema, and `status: 'APPROVED'` instead of `isActive: true`) and using `hashPassword` (per this repo's shared util, not raw bcrypt) for the fixture.

`test/agent-password-self-service.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password-hash.util';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent password self-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-agent-pw-${Date.now()}@example.com`;
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

    const passwordHash = await hashPassword(originalPassword);
    const agent = await prisma.agent.create({
      data: {
        email,
        phone: '+2348012345678',
        fullName: 'E2E Password Test Agent',
        address: '1 Example Street, Lagos',
        cvKey: 'agent-documents/e2e-password-test/cv.pdf',
        status: 'APPROVED',
        passwordHash,
        mustChangePassword: false,
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  it(
    'resets the password via forgot-password and revokes existing sessions',
    async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: originalPassword })
        .expect(200);
      const refreshToken = loginRes.body.refreshToken;

      await request(app.getHttpServer())
        .post('/auth/agent/forgot-password')
        .send({ email })
        .expect(200)
        .expect({ sent: true });

      expect(capturedEmail?.to).toBe(email);
      const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
      const resetToken = tokenMatch?.[1];
      expect(resetToken).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password')
        .send({ token: resetToken, newPassword: 'Reset-Password-789!' })
        .expect(200)
        .expect({ reset: true });

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      const newLoginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Reset-Password-789!' })
        .expect(200);
      const decoded = JSON.parse(Buffer.from(newLoginRes.body.accessToken.split('.')[1], 'base64url').toString());
      expect(decoded.mustChangePassword).toBe(false);
    },
    30000,
  );

  it('forgot-password returns 200 even for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/agent/forgot-password')
      .send({ email: 'definitely-not-a-real-agent@example.com' })
      .expect(200)
      .expect({ sent: true });
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/agent-password-self-service.e2e-spec.ts --runInBand`
Expected: PASS — 2 tests.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Agent enrollment` section (grep for the exact heading first to confirm placement):

```markdown
## Agent password self-service

`POST /auth/agent/forgot-password` (`{ email }`, always `200`, gated on
`status === APPROVED`) emails a one-hour opaque reset token via the same
mechanism Admin's own password reset uses. `POST /auth/agent/reset-password`
(`{ token, newPassword }`) consumes it, clears `mustChangePassword` (a
reset via a verified email token counts as establishing a real password
of the agent's own choosing), and force-revokes every existing session
for that agent. `POST /auth/agent/change-password` (the voluntary,
already-authenticated path) already existed from the enrollment work and
is unchanged.
```

- [ ] **Step 4: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the top-level **Agent** folder's existing **Auth** sub-folder, add requests for:
- `POST /auth/agent/forgot-password - Success (200, always)`
- `POST /auth/agent/reset-password - Success`
- `POST /auth/agent/reset-password - Invalid/expired token (401)`

Every request needs a saved response example per the standing `CLAUDE.md` rule (Nest's default exception shape: `{statusCode, message, error}`; reuse the already-established `401` shapes elsewhere in the collection, e.g. Admin's own `reset-password - Invalid/expired token` example). Use a surgical text-based insert, not a full JSON re-parse/re-dump.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this repo has known pre-existing environmental e2e flakiness under machine load, not a code defect.

- [ ] **Step 7: Commit**

```bash
git add test/agent-password-self-service.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add agent password self-service e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] `forgot-password` never reveals whether an email is registered (always `200`) — proven by both the unit and e2e tests.
- [ ] Completing a password reset immediately invalidates all of that agent's existing sessions (a stale refresh token stops working) — proven by the e2e test.
- [ ] A reset via a verified token clears `mustChangePassword`, so the agent isn't forced through a second, separate change-password step right after — proven by the e2e test decoding the post-reset login's JWT.
- [ ] Postman has coverage for both new endpoints.
