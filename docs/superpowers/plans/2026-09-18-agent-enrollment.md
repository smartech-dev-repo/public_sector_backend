# Agent Enrollment (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire, previously-unbuilt Phase 2 — public agent registration with document uploads, admin review (approve/reject/resend-credentials), forced password change on first login, and the `POST /auth/refresh` fix needed so a stalled agent can't dodge the forced change by refreshing.

**Architecture:** Two new top-level modules mirroring existing conventions exactly — `agent-enrollment` (public registration, parallel to `client-onboarding`) and `admin-agent-review` (admin review actions, parallel to `admin-client-review`). Two new small guards (`AgentOnlyGuard`, `RequirePasswordChangedGuard`) parallel to `ClientOnlyGuard`. The existing `src/auth/agent/` files (login) and `src/auth/session/session-auth.controller.ts` (the shared refresh endpoint) are extended, not replaced.

**Tech Stack:** NestJS 10, Prisma 7, Jest, `@nestjs/platform-express` (`FileFieldsInterceptor`).

**Spec:** `docs/superpowers/specs/2026-09-17-agent-enrollment-design.md`

## Global Constraints

- `Agent.email` is unique — registration checks explicitly and returns `409` rather than surfacing a raw DB constraint error (spec §3).
- `cv` is required (one file); `supportingDocuments` is optional, capped at 5 files (spec §3) — a provisional cap, easy to raise later.
- Approving generates a temporary password via `generateOpaqueToken()` (the same generator already used for admin invite tokens), hashes it into `passwordHash`, sets `mustChangePassword = true`, and emails the plaintext password once — it is never persisted or logged in plaintext (spec §4).
- `resend-credentials` is only valid while `status === APPROVED` **and** `hasLoggedIn === false` — once an agent has logged in even once, resending is permanently disabled (`409`), by design (spec §1, §4).
- `AGENT_APP_DOWNLOAD_URL` is optional — if unset, that line is simply omitted from the credentials email rather than blocking approval (spec §4).
- Rejection requires a `reason` (`400` if missing/empty) and sends no email (spec §1, §4, §6).
- A freshly-issued or freshly-refreshed agent JWT carries `mustChangePassword` accurately — `POST /auth/refresh` (shared across all three principal types) must re-derive it fresh from the `Agent` table for agent tokens, exactly parallel to how it already re-derives `permissions` fresh for admin tokens (spec §5). Without this fix, a stalled agent could strip the flag just by calling refresh once.
- `RequirePasswordChangedGuard` is built and tested but not wired to any route besides being available — there is no other Agent-JWT-protected business endpoint yet to gate (spec §1, §5).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example (the standing rule as of the just-completed full-collection retrofit).

---

### Task 1: Schema changes

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/auth/jwt-payload.interface.ts`

**Interfaces:**
- Produces: the extended `Agent` model fields and `JwtPayload.mustChangePassword` — every later task depends on these exact field names.

- [ ] **Step 1: Extend the `Agent` model**

In `prisma/schema.prisma`, replace the existing `Agent` model with:

```prisma
model Agent {
  id                     String      @id @default(uuid())
  email                  String      @unique
  phone                  String
  fullName               String
  address                String
  passwordHash           String?
  status                 AgentStatus @default(PENDING_REVIEW)
  cvKey                  String
  supportingDocumentKeys String[]    @default([])
  mustChangePassword     Boolean     @default(true)
  hasLoggedIn            Boolean     @default(false)
  reviewedBy             String?
  reviewedAt             DateTime?
  rejectionReason        String?
  createdAt              DateTime    @default(now())
  updatedAt              DateTime    @updatedAt
}
```

(`AgentStatus` is unchanged — `PENDING_REVIEW | APPROVED | REJECTED` already exists.)

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name extend_agent_for_enrollment`
Expected: creates and applies a new migration adding `address`, `cvKey`, `supportingDocumentKeys`, `mustChangePassword`, `hasLoggedIn`, `reviewedBy`, `reviewedAt`, `rejectionReason` to the existing `Agent` table. Since `address` and `cvKey` are non-nullable with no default and the table may already have rows (from any manually-created test agents), if `prisma migrate dev` prompts about data loss/required-without-default on a non-empty table, that's expected on a dev DB with no real agent rows yet — accept it. If it fails outright because rows exist, add temporary defaults in the migration SQL (`DEFAULT ''`) and note it in the commit message; do not fabricate this scenario if it doesn't actually occur.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the generated client**

Run: `grep -n "supportingDocumentKeys\|mustChangePassword\|hasLoggedIn" src/generated/prisma/models/Agent.ts`
Expected: all three field names present in the generated model file.

- [ ] **Step 5: Add `mustChangePassword` to `JwtPayload`**

In `src/auth/jwt-payload.interface.ts`, change to:

```typescript
export type PrincipalType = 'admin' | 'agent' | 'client';

export interface JwtPayload {
  sub: string;
  type: PrincipalType;
  permissions?: string[];
  mustChangePassword?: boolean;
}
```

- [ ] **Step 6: Type-check the project**

Run: `npx tsc --noEmit`
Expected: no errors (the `Agent` type change and `JwtPayload` addition are both purely additive/optional, so nothing existing should break).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/auth/jwt-payload.interface.ts
git commit -m "feat: extend Agent schema for enrollment and add mustChangePassword to JwtPayload"
```

---

### Task 2: `AgentOnlyGuard` and `RequirePasswordChangedGuard`

**Files:**
- Create: `src/auth/agent-only.guard.ts`
- Test: `src/auth/agent-only.guard.spec.ts`
- Create: `src/auth/require-password-changed.guard.ts`
- Test: `src/auth/require-password-changed.guard.spec.ts`

**Interfaces:**
- Consumes: `JwtPayload` (Task 1).
- Produces: `AgentOnlyGuard`, `RequirePasswordChangedGuard` — Task 5's change-password endpoint consumes `AgentOnlyGuard`.

- [ ] **Step 1: Write the failing tests**

`src/auth/agent-only.guard.spec.ts` (mirrors the existing `client-only.guard.spec.ts` exactly):

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AgentOnlyGuard } from './agent-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AgentOnlyGuard', () => {
  const guard = new AgentOnlyGuard();

  it('allows an agent-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1' }))).toBe(true);
  });

  it('rejects a non-agent principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'client', sub: 'c1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
```

`src/auth/require-password-changed.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequirePasswordChangedGuard } from './require-password-changed.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RequirePasswordChangedGuard', () => {
  const guard = new RequirePasswordChangedGuard();

  it('allows a principal whose mustChangePassword is false', () => {
    expect(guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1', mustChangePassword: false }))).toBe(true);
  });

  it('allows a principal with no mustChangePassword claim at all', () => {
    expect(guard.canActivate(contextWithUser({ type: 'admin', sub: 'ad1' }))).toBe(true);
  });

  it('rejects a principal whose mustChangePassword is true', () => {
    expect(() =>
      guard.canActivate(contextWithUser({ type: 'agent', sub: 'a1', mustChangePassword: true })),
    ).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/auth/agent-only.guard.spec.ts src/auth/require-password-changed.guard.spec.ts`
Expected: FAIL — `Cannot find module './agent-only.guard'` (and similarly for the other).

- [ ] **Step 3: Implement both guards**

`src/auth/agent-only.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AgentOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.type !== 'agent') {
      throw new ForbiddenException('This endpoint is only available to Agent accounts');
    }
    return true;
  }
}
```

`src/auth/require-password-changed.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class RequirePasswordChangedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.mustChangePassword === true) {
      throw new ForbiddenException('Password must be changed before this action is allowed');
    }
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/agent-only.guard.spec.ts src/auth/require-password-changed.guard.spec.ts`
Expected: PASS — 6 tests (3 + 3).

- [ ] **Step 5: Commit**

```bash
git add src/auth/agent-only.guard.ts src/auth/agent-only.guard.spec.ts src/auth/require-password-changed.guard.ts src/auth/require-password-changed.guard.spec.ts
git commit -m "feat: add AgentOnlyGuard and RequirePasswordChangedGuard"
```

---

### Task 3: Agent registration (public)

**Files:**
- Create: `src/agent-enrollment/dto/register-agent.dto.ts`
- Create: `src/agent-enrollment/agent-enrollment.service.ts`
- Test: `src/agent-enrollment/agent-enrollment.service.spec.ts`
- Create: `src/agent-enrollment/agent-enrollment.controller.ts`
- Create: `src/agent-enrollment/agent-enrollment.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `FILE_STORAGE_PROVIDER`/`FileStorageProvider` (existing, from `FileStorageModule`), `PrismaService`.
- Produces: `POST /agents/register` (public) → the created `Agent` row. `AgentEnrollmentService.register(dto, cv, supportingDocuments): Promise<Agent>`.

- [ ] **Step 1: Write the failing unit tests**

`src/agent-enrollment/agent-enrollment.service.spec.ts`:

```typescript
import { ConflictException } from '@nestjs/common';
import { AgentEnrollmentService } from './agent-enrollment.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AgentEnrollmentService', () => {
  let service: AgentEnrollmentService;
  let prisma: { agent: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };
    service = new AgentEnrollmentService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  const dto = {
    fullName: 'Jane Agent',
    email: 'jane.agent@example.com',
    phone: '+2348012345678',
    address: '1 Example Street, Lagos',
  };
  const cv = { originalname: 'cv.pdf', buffer: Buffer.from('cv-content') } as Express.Multer.File;

  it('rejects registration when the email is already taken', async () => {
    prisma.agent.findUnique.mockResolvedValue({ id: 'existing-agent' });

    await expect(service.register(dto, cv, [])).rejects.toThrow(ConflictException);
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('creates the agent, stores the cv, and stores each supporting document under a namespaced key', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
    prisma.agent.update.mockResolvedValue({ id: 'agent-1', cvKey: 'stored', supportingDocumentKeys: ['stored'] });

    const supportingDocuments = [
      { originalname: 'id-card.png', buffer: Buffer.from('id-card') } as Express.Multer.File,
    ];

    await service.register(dto, cv, supportingDocuments);

    expect(prisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: dto.email,
          phone: dto.phone,
          fullName: dto.fullName,
          address: dto.address,
        }),
      }),
    );
    expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
    expect(fileStorageProvider.putObject.mock.calls[0][0]).toContain('agent-documents/agent-1/cv-');
    expect(fileStorageProvider.putObject.mock.calls[0][0]).toContain('.pdf');
    expect(fileStorageProvider.putObject.mock.calls[1][0]).toContain('agent-documents/agent-1/supporting-0-');
    expect(fileStorageProvider.putObject.mock.calls[1][0]).toContain('.png');

    const updateCall = prisma.agent.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'agent-1' });
    expect(updateCall.data.cvKey).toContain('agent-documents/agent-1/cv-');
    expect(updateCall.data.supportingDocumentKeys).toHaveLength(1);
  });

  it('registers successfully with no supporting documents', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    prisma.agent.create.mockResolvedValue({ id: 'agent-2' });
    prisma.agent.update.mockResolvedValue({ id: 'agent-2' });

    await service.register(dto, cv, []);

    expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(1);
    const updateCall = prisma.agent.update.mock.calls[0][0];
    expect(updateCall.data.supportingDocumentKeys).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/agent-enrollment/agent-enrollment.service.spec.ts`
Expected: FAIL — `Cannot find module './agent-enrollment.service'`.

- [ ] **Step 3: Implement the DTO and service**

`src/agent-enrollment/dto/register-agent.dto.ts`:

```typescript
import { IsEmail, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class RegisterAgentDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber()
  phone: string;

  @IsString()
  @MinLength(1)
  address: string;
}
```

`src/agent-enrollment/agent-enrollment.service.ts`:

```typescript
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { RegisterAgentDto } from './dto/register-agent.dto';

const MAX_SUPPORTING_DOCUMENTS = 5;

@Injectable()
export class AgentEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async register(
    dto: RegisterAgentDto,
    cv: Express.Multer.File,
    supportingDocuments: Express.Multer.File[],
  ) {
    const existing = await this.prisma.agent.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const agent = await this.prisma.agent.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        fullName: dto.fullName,
        address: dto.address,
        cvKey: '',
      },
    });

    const cvKey = `agent-documents/${agent.id}/cv-${randomUUID()}${extname(cv.originalname)}`;
    await this.fileStorageProvider.putObject(cvKey, cv.buffer);

    const supportingDocumentKeys: string[] = [];
    for (const [index, file] of supportingDocuments.slice(0, MAX_SUPPORTING_DOCUMENTS).entries()) {
      const key = `agent-documents/${agent.id}/supporting-${index}-${randomUUID()}${extname(file.originalname)}`;
      await this.fileStorageProvider.putObject(key, file.buffer);
      supportingDocumentKeys.push(key);
    }

    return this.prisma.agent.update({
      where: { id: agent.id },
      data: { cvKey, supportingDocumentKeys },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/agent-enrollment/agent-enrollment.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Implement the controller and module, wire into `AppModule`**

`src/agent-enrollment/agent-enrollment.controller.ts`:

```typescript
import { BadRequestException, Body, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { AgentEnrollmentService } from './agent-enrollment.service';
import { RegisterAgentDto } from './dto/register-agent.dto';

@Controller('agents')
export class AgentEnrollmentController {
  constructor(private readonly agentEnrollmentService: AgentEnrollmentService) {}

  @Post('register')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cv', maxCount: 1 },
      { name: 'supportingDocuments', maxCount: 5 },
    ]),
  )
  register(
    @Body() dto: RegisterAgentDto,
    @UploadedFiles()
    files: { cv?: Express.Multer.File[]; supportingDocuments?: Express.Multer.File[] },
  ) {
    const cv = files.cv?.[0];
    if (!cv) {
      throw new BadRequestException('cv is required');
    }
    return this.agentEnrollmentService.register(dto, cv, files.supportingDocuments ?? []);
  }
}
```

`src/agent-enrollment/agent-enrollment.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AgentEnrollmentController } from './agent-enrollment.controller';
import { AgentEnrollmentService } from './agent-enrollment.service';

@Module({
  imports: [FileStorageModule],
  controllers: [AgentEnrollmentController],
  providers: [AgentEnrollmentService],
})
export class AgentEnrollmentModule {}
```

Modify `src/app.module.ts`: add `import { AgentEnrollmentModule } from './agent-enrollment/agent-enrollment.module';` and add `AgentEnrollmentModule` to the `imports` array.

- [ ] **Step 6: Run the full unit suite and type-check**

Run: `npx jest src/agent-enrollment && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent-enrollment src/app.module.ts
git commit -m "feat: add public agent registration endpoint"
```

---

### Task 4: Admin agent review

**Files:**
- Create: `src/admin-agent-review/dto/reject-agent.dto.ts`
- Create: `src/admin-agent-review/admin-agent-review.service.ts`
- Test: `src/admin-agent-review/admin-agent-review.service.spec.ts`
- Create: `src/admin-agent-review/admin-agent-review.controller.ts`
- Create: `src/admin-agent-review/admin-agent-review.module.ts`
- Modify: `src/app.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `PrismaService`, `EmailService` (existing, from `EmailModule`), `ConfigService`.
- Produces: `GET /admin/agents`, `GET /admin/agents/:id`, `POST /admin/agents/:id/approve`, `POST /admin/agents/:id/reject`, `POST /admin/agents/:id/resend-credentials`.

- [ ] **Step 1: Write the failing unit tests**

`src/admin-agent-review/admin-agent-review.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

describe('AdminAgentReviewService', () => {
  let service: AdminAgentReviewService;
  let prisma: { agent: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };
  let emailService: { send: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue(undefined) };
    service = new AdminAgentReviewService(
      prisma as unknown as PrismaService,
      emailService as unknown as EmailService,
      configService as unknown as ConfigService,
    );
  });

  describe('approve', () => {
    it('throws NotFoundException when the agent does not exist', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.approve('missing-id', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the agent is not PENDING_REVIEW', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED', email: 'a@example.com' });
      await expect(service.approve('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('generates credentials, sets APPROVED, and emails the agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'a1' },
          data: expect.objectContaining({
            mustChangePassword: true,
            status: 'APPROVED',
            reviewedBy: 'admin-1',
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@example.com', subject: expect.any(String) }),
      );
    });

    it('omits the app download link when AGENT_APP_DOWNLOAD_URL is not configured', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      const sentMessage = emailService.send.mock.calls[0][0];
      expect(sentMessage.text).not.toMatch(/Download the app/);
    });

    it('includes the app download link when AGENT_APP_DOWNLOAD_URL is configured', async () => {
      configService.get.mockReturnValue('https://example.com/download');
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      const sentMessage = emailService.send.mock.calls[0][0];
      expect(sentMessage.text).toContain('https://example.com/download');
    });
  });

  describe('reject', () => {
    it('throws ConflictException when the agent is not PENDING_REVIEW', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'REJECTED' });
      await expect(service.reject('a1', 'admin-1', 'Incomplete CV')).rejects.toThrow(ConflictException);
    });

    it('sets REJECTED with the reason and reviewer, and sends no email', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.reject('a1', 'admin-1', 'Incomplete CV');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: {
          status: 'REJECTED',
          rejectionReason: 'Incomplete CV',
          reviewedBy: 'admin-1',
          reviewedAt: expect.any(Date),
        },
      });
      expect(emailService.send).not.toHaveBeenCalled();
    });
  });

  describe('resendCredentials', () => {
    it('throws ConflictException when the agent is not APPROVED', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', hasLoggedIn: false });
      await expect(service.resendCredentials('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the agent has already logged in', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED', hasLoggedIn: true });
      await expect(service.resendCredentials('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('regenerates credentials and re-sends the email when still unused', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
        hasLoggedIn: false,
        email: 'a@example.com',
      });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.resendCredentials('a1', 'admin-1');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true }) }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-agent-review.service'`.

- [ ] **Step 3: Implement the DTO and service**

`src/admin-agent-review/dto/reject-agent.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class RejectAgentDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
```

`src/admin-agent-review/admin-agent-review.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { generateOpaqueToken } from '../common/opaque-token.util';
import { Agent, AgentStatus } from '../generated/prisma/client';

@Injectable()
export class AdminAgentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async list(status?: AgentStatus) {
    return this.prisma.agent.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return agent;
  }

  async approve(id: string, reviewerId: string): Promise<void> {
    const agent = await this.loadPendingReview(id);
    await this.issueCredentials(agent, { reviewerId });
  }

  async reject(id: string, reviewerId: string, reason: string): Promise<void> {
    await this.loadPendingReview(id);

    await this.prisma.agent.update({
      where: { id },
      data: {
        status: AgentStatus.REJECTED,
        rejectionReason: reason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });
  }

  async resendCredentials(id: string, reviewerId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.status !== AgentStatus.APPROVED) {
      throw new ConflictException(`Agent is not APPROVED (currently ${agent.status})`);
    }
    if (agent.hasLoggedIn) {
      throw new ConflictException('Credentials have already been used and can no longer be resent');
    }

    await this.issueCredentials(agent, {});
  }

  private async loadPendingReview(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.status !== AgentStatus.PENDING_REVIEW) {
      throw new ConflictException(`Agent is not PENDING_REVIEW (currently ${agent.status})`);
    }
    return agent;
  }

  private async issueCredentials(agent: Agent, options: { reviewerId?: string }): Promise<void> {
    const temporaryPassword = generateOpaqueToken();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        status: AgentStatus.APPROVED,
        ...(options.reviewerId ? { reviewedBy: options.reviewerId, reviewedAt: new Date() } : {}),
      },
    });

    const downloadUrl = this.configService.get<string>('AGENT_APP_DOWNLOAD_URL');
    const downloadHtml = downloadUrl ? `<p>Download the app: ${downloadUrl}</p>` : '';
    const downloadText = downloadUrl ? `Download the app: ${downloadUrl}\n` : '';

    await this.emailService.send({
      to: agent.email,
      subject: 'Your agent account has been approved',
      html: `<p>Email: ${agent.email}</p><p>Temporary password: ${temporaryPassword}</p>${downloadHtml}<p>You will be required to change this password on first login.</p>`,
      text: `Email: ${agent.email}\nTemporary password: ${temporaryPassword}\n${downloadText}You will be required to change this password on first login.`,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS — 10 tests (5 approve + 2 reject + 3 resendCredentials — recount against the literal test file above before treating any other number as correct).

- [ ] **Step 5: Implement the controller and module, wire into `AppModule`**

`src/admin-agent-review/admin-agent-review.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { RejectAgentDto } from './dto/reject-agent.dto';
import { AgentStatus, AuditActorType } from '../generated/prisma/client';

@Controller('admin/agents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminAgentReviewController {
  constructor(
    private readonly adminAgentReviewService: AdminAgentReviewService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('agents:read')
  list(@Query('status') status?: AgentStatus) {
    return this.adminAgentReviewService.list(status);
  }

  @Get(':id')
  @RequirePermissions('agents:read')
  findById(@Param('id') id: string) {
    return this.adminAgentReviewService.findById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async approve(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.approve(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.approved',
      targetType: 'Agent',
      targetId: id,
    });
    return { approved: true };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async reject(@Param('id') id: string, @Body() dto: RejectAgentDto, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.reject(id, req.user.sub, dto.reason);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.rejected',
      targetType: 'Agent',
      targetId: id,
      metadata: { reason: dto.reason },
    });
    return { rejected: true };
  }

  @Post(':id/resend-credentials')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async resendCredentials(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.resendCredentials(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.credentials_resent',
      targetType: 'Agent',
      targetId: id,
    });
    return { resent: true };
  }
}
```

`src/admin-agent-review/admin-agent-review.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminAgentReviewController } from './admin-agent-review.controller';
import { AdminAgentReviewService } from './admin-agent-review.service';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminAgentReviewController],
  providers: [AdminAgentReviewService],
})
export class AdminAgentReviewModule {}
```

Modify `src/app.module.ts`: add `import { AdminAgentReviewModule } from './admin-agent-review/admin-agent-review.module';` and add `AdminAgentReviewModule` to the `imports` array.

- [ ] **Step 6: Document the new env var**

Add to `.env.example`:

```
# Optional — if unset, the approval/resend-credentials email simply omits
# the app download line.
AGENT_APP_DOWNLOAD_URL=
```

- [ ] **Step 7: Run the full unit suite and type-check**

Run: `npx jest src/admin-agent-review && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/admin-agent-review src/app.module.ts .env.example
git commit -m "feat: add admin agent review (approve/reject/resend-credentials)"
```

---

### Task 5: Forced password change — `AgentAuthService` and `POST /auth/agent/change-password`

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`
- Create: `src/auth/agent/dto/change-password.dto.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`

**Interfaces:**
- Consumes: `AgentOnlyGuard` (Task 2).
- Produces: `AgentAuthService.getMustChangePasswordForAgent(agentId): Promise<boolean>`, `AgentAuthService.changePassword(agentId, currentPassword, newPassword): Promise<void>` — Task 6 consumes `getMustChangePasswordForAgent`.

- [ ] **Step 1: Update the existing service tests and add new ones**

Read `src/auth/agent/agent-auth.service.spec.ts` in full first (shown in the Task 4 investigation — it currently mocks `prisma = { agent: { findUnique: jest.fn() } }` with 3 tests). Replace the whole file with:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: { agent: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  describe('login', () => {
    it('rejects an agent that is still PENDING_REVIEW', async () => {
      const passwordHash = await bcrypt.hash('secret-password', 12);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'PENDING_REVIEW',
      });

      await expect(
        service.login('agent@example.com', 'secret-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an approved agent with no password set yet', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash: null,
        status: 'APPROVED',
      });

      await expect(
        service.login('agent@example.com', 'secret-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('issues tokens, marks hasLoggedIn, and includes mustChangePassword in the payload', async () => {
      const passwordHash = await bcrypt.hash('secret-password', 12);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        mustChangePassword: true,
      });

      const result = await service.login('agent@example.com', 'secret-password', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { hasLoggedIn: true },
      });
      expect(tokenService.signAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'agent-1', type: 'agent', mustChangePassword: true }),
      );
      expect(sessionService.createSession).toHaveBeenCalledWith({
        principalType: 'AGENT',
        principalId: 'agent-1',
        userAgent: 'jest',
        ip: '127.0.0.1',
      });
      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });
  });

  describe('getMustChangePasswordForAgent', () => {
    it('returns the agent\'s current flag', async () => {
      prisma.agent.findUnique.mockResolvedValue({ mustChangePassword: false });
      await expect(service.getMustChangePasswordForAgent('agent-1')).resolves.toBe(false);
    });

    it('returns false when the agent no longer exists', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.getMustChangePasswordForAgent('missing')).resolves.toBe(false);
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await expect(
        service.changePassword('agent-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('hashes the new password and clears mustChangePassword', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await service.changePassword('agent-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.agent.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'agent-1' });
      expect(updateCall.data.mustChangePassword).toBe(false);
      expect(updateCall.data.passwordHash).not.toBe(passwordHash);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — the `login` tests fail because `prisma.agent.update` isn't called yet and the payload lacks `mustChangePassword`; `getMustChangePasswordForAgent`/`changePassword` fail with `service.getMustChangePasswordForAgent is not a function` etc.

- [ ] **Step 3: Update `AgentAuthService`**

Replace `src/auth/agent/agent-auth.service.ts` with:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

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

  async getMustChangePasswordForAgent(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    return agent?.mustChangePassword ?? false;
  }

  async changePassword(agentId: string, currentPassword: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { passwordHash, mustChangePassword: false },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — 7 tests (3 login + 2 getMustChangePasswordForAgent + 2 changePassword).

- [ ] **Step 5: Add the change-password DTO and controller route**

`src/auth/agent/dto/change-password.dto.ts`:

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

Replace `src/auth/agent/agent-auth.controller.ts` with:

```typescript
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { AgentOnlyGuard } from '../agent-only.guard';
import { JwtPayload } from '../jwt-payload.interface';
import { TokenService } from '../token.service';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(
    private readonly agentAuthService: AgentAuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto, @Req() req: Request) {
    return this.agentAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AgentOnlyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { user: JwtPayload }) {
    await this.agentAuthService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
    const payload: JwtPayload = { sub: req.user.sub, type: 'agent', mustChangePassword: false };
    return { accessToken: this.tokenService.signAccessToken(payload) };
  }
}
```

Modify `src/auth/auth.module.ts`: add `import { AgentOnlyGuard } from './agent-only.guard';` and add `AgentOnlyGuard` to the `providers` array (it's a plain `@Injectable()`, referenced directly by class in `@UseGuards`, but Nest still needs it in a module's providers if it were ever injected elsewhere — since `@UseGuards(AgentOnlyGuard)` with a class reference lets Nest instantiate it via its own DI container automatically even without an explicit provider entry, this step is only needed if `npx tsc --noEmit`/tests reveal a DI resolution error; if the app boots and tests pass without adding it, skip this addition rather than adding an unnecessary provider entry).

- [ ] **Step 6: Run the full unit suite and type-check**

Run: `npx jest src/auth/agent && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/auth/agent src/auth/auth.module.ts
git commit -m "feat: add forced password change for agents"
```

---

### Task 6: `POST /auth/refresh` re-derives `mustChangePassword` for agents

**Files:**
- Modify: `src/auth/session/session-auth.controller.ts`
- Create: `src/auth/session/session-auth.controller.spec.ts`

**Interfaces:**
- Consumes: `AgentAuthService.getMustChangePasswordForAgent` (Task 5).

- [ ] **Step 1: Write the failing tests**

`src/auth/session/session-auth.controller.spec.ts` (this controller currently has no dedicated unit test file — this is a new one, scoped to the `refresh` behavior relevant to this plan):

```typescript
import { SessionAuthController } from './session-auth.controller';
import { SessionService } from '../../session/session.service';
import { TokenService } from '../token.service';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AgentAuthService } from '../agent/agent-auth.service';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { Request } from 'express';

describe('SessionAuthController', () => {
  let controller: SessionAuthController;
  let sessionService: { rotate: jest.Mock };
  let tokenService: { signAccessToken: jest.Mock };
  let adminAuthService: { getPermissionsForAdmin: jest.Mock };
  let agentAuthService: { getMustChangePasswordForAgent: jest.Mock };

  beforeEach(() => {
    sessionService = { rotate: jest.fn() };
    tokenService = { signAccessToken: jest.fn().mockReturnValue('new-access-token') };
    adminAuthService = { getPermissionsForAdmin: jest.fn().mockResolvedValue(['roles:manage']) };
    agentAuthService = { getMustChangePasswordForAgent: jest.fn().mockResolvedValue(true) };

    controller = new SessionAuthController(
      sessionService as unknown as SessionService,
      tokenService as unknown as TokenService,
      adminAuthService as unknown as AdminAuthService,
      agentAuthService as unknown as AgentAuthService,
    );
  });

  it('re-derives permissions fresh for an admin refresh, leaving mustChangePassword unset', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.ADMIN,
      principalId: 'admin-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, {} as Request);

    expect(adminAuthService.getPermissionsForAdmin).toHaveBeenCalledWith('admin-1');
    expect(agentAuthService.getMustChangePasswordForAgent).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['roles:manage'],
      mustChangePassword: undefined,
    });
  });

  it('re-derives mustChangePassword fresh for an agent refresh, leaving permissions unset', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.AGENT,
      principalId: 'agent-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, {} as Request);

    expect(agentAuthService.getMustChangePasswordForAgent).toHaveBeenCalledWith('agent-1');
    expect(adminAuthService.getPermissionsForAdmin).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'agent-1',
      type: 'agent',
      permissions: undefined,
      mustChangePassword: true,
    });
  });

  it('leaves both permissions and mustChangePassword unset for a client refresh', async () => {
    sessionService.rotate.mockResolvedValue({
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      refreshToken: 'new-refresh',
    });

    await controller.refresh({ refreshToken: 'old-refresh' }, {} as Request);

    expect(adminAuthService.getPermissionsForAdmin).not.toHaveBeenCalled();
    expect(agentAuthService.getMustChangePasswordForAgent).not.toHaveBeenCalled();
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'client-1',
      type: 'client',
      permissions: undefined,
      mustChangePassword: undefined,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/auth/session/session-auth.controller.spec.ts`
Expected: FAIL — `SessionAuthController` currently takes only 3 constructor args, so this compiles/runs with the 4th (`agentAuthService`) simply ignored, and `mustChangePassword` is never in the signed payload, so all 3 `expect(tokenService.signAccessToken).toHaveBeenCalledWith(...)` assertions fail (missing key) and the agent-specific `expect(agentAuthService.getMustChangePasswordForAgent).toHaveBeenCalledWith(...)` assertion fails (never called).

- [ ] **Step 3: Update `SessionAuthController`**

Replace `src/auth/session/session-auth.controller.ts`'s imports, constructor, and `refresh` method with:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from '../../session/session.service';
import { TokenService } from '../token.service';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AgentAuthService } from '../agent/agent-auth.service';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { JwtPayload } from '../jwt-payload.interface';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { toJwtPrincipalType, toSessionPrincipalType } from '../../session/session-principal-type.mapper';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth')
export class SessionAuthController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly tokenService: TokenService,
    private readonly adminAuthService: AdminAuthService,
    private readonly agentAuthService: AgentAuthService,
  ) {}

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const result = await this.sessionService.rotate(dto.refreshToken, getRequestMetadata(req));

    const permissions =
      result.principalType === SessionPrincipalType.ADMIN
        ? await this.adminAuthService.getPermissionsForAdmin(result.principalId)
        : undefined;

    const mustChangePassword =
      result.principalType === SessionPrincipalType.AGENT
        ? await this.agentAuthService.getMustChangePasswordForAgent(result.principalId)
        : undefined;

    const payload: JwtPayload = {
      sub: result.principalId,
      type: toJwtPrincipalType(result.principalType),
      permissions,
      mustChangePassword,
    };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: result.refreshToken,
    };
  }

  // ...logout, logout-all, listSessions, revokeSession unchanged below...
}
```

Keep every method below `refresh` (`logout`, `logout-all`, `GET sessions`, `DELETE sessions/:id`) exactly as they already are in the file — only the imports, constructor, and `refresh` method change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/auth/session/session-auth.controller.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the full unit suite and type-check**

Run: `npx jest src/auth && npx tsc --noEmit`
Expected: PASS, no type errors (`AuthModule` already provides `AgentAuthService` as a provider, so the new constructor dependency resolves without any module wiring change).

- [ ] **Step 6: Commit**

```bash
git add src/auth/session/session-auth.controller.ts src/auth/session/session-auth.controller.spec.ts
git commit -m "fix: re-derive mustChangePassword fresh on agent token refresh"
```

---

### Task 7: e2e test, README, and Postman

**Files:**
- Test: `test/agent-enrollment.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-6.

- [ ] **Step 1: Write the e2e test**

Read `test/admin-client-review.e2e-spec.ts` first for this codebase's exact `TestingModule`/`ValidationPipe`/`PrismaService` e2e boilerplate convention, and read `src/email/console-email.provider.ts` to confirm how the mock email provider logs/exposes its sent messages in this environment (since the e2e test needs to capture the temporary password from the "sent" email without a real mailbox — if `ConsoleEmailProvider` only logs and doesn't expose sent messages for a test to read, use direct `PrismaService` inspection instead: after calling `approve`, read the `Agent.passwordHash` is not retrievable in plaintext, so instead spy on `EmailService.send` via the Nest testing module's override mechanism, exactly as needed here — override the `EMAIL_PROVIDERS` provider with a test double that captures the sent message, following whatever override pattern, if any, an existing e2e test in this repo already uses for a similar mocked-vendor capture; if none exists, use `moduleFixture.overrideProvider(EMAIL_PROVIDERS).useValue([{ name: 'test', send: jest.fn().mockImplementation((msg) => { capturedEmail = msg; return Promise.resolve(); }) }])` before calling `.compile()`).

`test/agent-enrollment.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent enrollment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-agent-${Date.now()}@example.com`;
  let adminAccessToken: string;

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

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  it('registers, gets approved, logs in with a forced password change, and refresh reflects the change', async () => {
    const registerRes = await request(app.getHttpServer())
      .post('/agents/register')
      .field('fullName', 'E2E Agent')
      .field('email', email)
      .field('phone', '+2348012345678')
      .field('address', '1 Example Street, Lagos')
      .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
      .expect(201);
    agentId = registerRes.body.id;
    expect(registerRes.body.status).toBe('PENDING_REVIEW');

    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ approved: true });

    expect(capturedEmail?.to).toBe(email);
    const passwordMatch = capturedEmail?.text?.match(/Temporary password: (\S+)/);
    const temporaryPassword = passwordMatch?.[1];
    expect(temporaryPassword).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/resend-credentials`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ resent: true });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: temporaryPassword })
      .expect(200);
    const { accessToken, refreshToken } = loginRes.body;
    const decoded = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    expect(decoded.mustChangePassword).toBe(true);

    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/resend-credentials`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/agent/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: temporaryPassword, newPassword: 'a-brand-new-password' })
      .expect(200);

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const decodedAfterRefresh = JSON.parse(
      Buffer.from(refreshRes.body.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(decodedAfterRefresh.mustChangePassword).toBe(false);
  });

  it('rejects a second registration with the same email', async () => {
    await request(app.getHttpServer())
      .post('/agents/register')
      .field('fullName', 'Duplicate Agent')
      .field('email', email)
      .field('phone', '+2348012345679')
      .field('address', 'Somewhere else')
      .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
      .expect(409);
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/agent-enrollment.e2e-spec.ts --runInBand`
Expected: PASS — 2 tests. If the `EMAIL_PROVIDERS` override doesn't work as written (e.g. this codebase's Nest version needs a different override syntax, or `ConsoleEmailProvider` is hard-wired in a way that `overrideProvider` can't reach because of how `EmailModule`'s factory provider is structured), adapt the override to whatever actually works — the goal is just to capture the plaintext temporary password from the approval email without touching a real mailbox; do not weaken the test's actual assertions to work around a wiring problem instead of fixing the override.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Client loan dashboard` section:

```markdown
## Agent enrollment

`POST /agents/register` (public, multipart: `fullName`/`email`/`phone`/
`address` fields, `cv` file required, up to 5 `supportingDocuments` files
optional) creates an `Agent` at `PENDING_REVIEW`. Admins holding
`agents:read`/`agents:review` list/inspect/approve/reject submissions
(`GET /admin/agents`, `GET /admin/agents/:id`,
`POST /admin/agents/:id/approve`, `POST /admin/agents/:id/reject` with a
required `reason`). Approving generates a temporary password, emails it
to the agent (with an optional app-download link from
`AGENT_APP_DOWNLOAD_URL`) via the existing `EmailService`, and requires
the agent to change it before their JWT stops carrying
`mustChangePassword: true` — `POST /auth/agent/change-password` is the
one route reachable regardless of that flag.
`POST /admin/agents/:id/resend-credentials` regenerates and re-sends the
credentials, but only until the agent has logged in once
(`Agent.hasLoggedIn`), after which it's permanently disabled.
`POST /auth/refresh` re-derives `mustChangePassword` fresh from the
database on every agent token refresh, the same way it already
re-derives `permissions` fresh for admin tokens.
```

- [ ] **Step 4: Add Postman coverage**

Read `postman/README.md`'s "Folder structure" section first to confirm exactly how a new controller/module gets a new sub-folder within an existing top-level group (per this repo's `CLAUDE.md`, only a genuinely new principal type gets a new top-level group — Agent enrollment doesn't introduce one, since "Agent" already exists as a top-level group and "Admin" already exists for the review side).

In `postman/public-sector-backend.postman_collection.json`:
- Add a new sub-folder `"Enrollment"` under the top-level **Agent** folder (alongside its existing `Auth`/`Session` sub-folders) with requests for: `POST /agents/register - Success` (multipart form-data body matching the DTO fields plus a `cv` file field — Postman's `formdata` body mode, `type: "file"` for the file fields), `POST /agents/register - Duplicate email (409)`, `POST /agents/register - Missing cv (400)`, `POST /auth/agent/change-password - Success`, `POST /auth/agent/change-password - Wrong current password (401)`.
- Add a new sub-folder `"Review"` under the top-level **Admin** folder (alongside its existing sub-folders) with requests for: `GET /admin/agents - Success`, `GET /admin/agents/:id - Success`, `POST /admin/agents/:id/approve - Success`, `POST /admin/agents/:id/approve - Blocked, not PENDING_REVIEW (409)`, `POST /admin/agents/:id/reject - Success`, `POST /admin/agents/:id/reject - Missing reason (400)`, `POST /admin/agents/:id/resend-credentials - Success`, `POST /admin/agents/:id/resend-credentials - Blocked, already logged in (409)`.
- Every request needs a saved response example per the standing `CLAUDE.md` rule established during the just-completed full-collection retrofit — author each one from the actual controller/service/DTO code exactly as that retrofit's batches did (Nest's default exception shape: `{statusCode, message, error}`; `{statusCode, message: [...], error: "Bad Request"}` for `ValidationPipe` failures; reuse the already-established `401`/`403` shapes from the rest of the collection).
- Use a surgical text-based insert (not a full JSON re-parse/re-dump) to avoid disturbing this large file's existing unicode escaping, per this codebase's established practice.
- Add a new collection variable `target_agent_id` (empty default) if one doesn't already exist, for chaining the review requests together.

- [ ] **Step 5: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

Add "Enrollment" to the Agent bullet and "Review" (agents) to the Admin bullet in `postman/README.md`'s "Folder structure" section.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. (Use `--runInBand` for e2e — this codebase's default parallel e2e run has known pre-existing environmental flakiness unrelated to any single feature; serialized is the reliable signal. If any single pre-existing, unrelated suite flakes on a timeout, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this has happened before in this codebase and was never a real problem.)

- [ ] **Step 7: Commit**

```bash
git add test/agent-enrollment.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: add agent enrollment e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] A prospective agent can register with a CV and get reviewed by an admin (approve/reject/resend-credentials), all covered by unit tests.
- [ ] Approving an agent emails them a temporary password (never persisted in plaintext) that lets them log in with `mustChangePassword: true` on their JWT.
- [ ] `resend-credentials` is blocked (`409`) once the agent has logged in even once — proven by both the unit tests and the e2e test.
- [ ] `POST /auth/agent/change-password` is reachable even while `mustChangePassword` is true, and clears the flag on success.
- [ ] `POST /auth/refresh` re-derives `mustChangePassword` fresh for agent tokens (proven by the e2e test refreshing after a password change and seeing the flag flip to `false`), exactly parallel to how it already re-derives `permissions` for admin tokens.
- [ ] Postman has full coverage of every new endpoint under Agent > Enrollment and Admin > Review, each with a saved response example.
