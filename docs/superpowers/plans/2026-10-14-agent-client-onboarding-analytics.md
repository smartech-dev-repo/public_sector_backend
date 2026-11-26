# Agent Client Onboarding + Admin Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Agent onboard a client (gated by a new admin-granted `canOnboardClients` flag), track onboarding source (self/agent/admin) on every client, and expose that as a filterable field on the existing admin client list plus a new admin analytics summary endpoint and an agent-facing "clients I onboarded" list.

**Architecture:** A new nullable `ClientOnboarding.onboardedByAgentId` FK parallels the existing `onboardedById` (admin) FK — onboarding source is derived from which (if either) is set, never stored separately. A new `agentStartOnboarding` method on the existing `ClientOnboardingService` mirrors `adminStartOnboarding` but adds a same-agent-only resume restriction. The `canOnboardClients` flag is embedded in the Agent's JWT at login/refresh (same pattern as admin's `permissions` array), so the guard checking it never hits the DB.

**Tech Stack:** NestJS, Prisma, class-validator DTOs, Jest unit tests, supertest e2e tests.

**Spec:** `docs/superpowers/specs/2026-10-14-agent-client-onboarding-analytics-design.md`

## Global Constraints

- Onboarding source (`SELF`/`AGENT`/`ADMIN`) is never stored as its own column — always derived from `onboardedById`/`onboardedByAgentId` via the shared `deriveOnboardingSource` util, to avoid drift between a stored label and the two FKs it would duplicate.
- The agent restriction is exact: an agent may only start/resume onboarding when no `ClientOnboarding` exists yet, or when one exists with `onboardedByAgentId` equal to that same agent's id. Every other case (self-onboarded, admin-onboarded, a different agent) is a `409 Conflict`.
- `canOnboardClients` is carried in the JWT payload (login + refresh), not re-checked against the DB on every guarded request — matches this codebase's existing pattern for admin `permissions` and agent `mustChangePassword`.
- Every new/changed endpoint gets a Postman example authored from the actual DTO/controller/service code, per this repo's `CLAUDE.md`.

---

### Task 1: Schema — `Agent.canOnboardClients` + `ClientOnboarding.onboardedByAgentId`

**Files:**
- Modify: `prisma/schema.prisma` (`Agent` model, `ClientOnboarding` model)

**Interfaces:**
- Produces: `Agent.canOnboardClients: boolean` (default `false`), `ClientOnboarding.onboardedByAgentId: string | null` + `onboardedByAgent` relation — available via `../generated/prisma/client` after `prisma generate`.

- [ ] **Step 1: Add `canOnboardClients` to `Agent`**

In `prisma/schema.prisma`, in the `Agent` model, change:

```prisma
  mustChangePassword     Boolean     @default(true)
  hasLoggedIn            Boolean     @default(false)
  reviewedBy             String?
```

to:

```prisma
  mustChangePassword     Boolean     @default(true)
  hasLoggedIn            Boolean     @default(false)
  canOnboardClients      Boolean     @default(false)
  reviewedBy             String?
```

- [ ] **Step 2: Add `onboardedByAgentId` to `ClientOnboarding`**

In the `ClientOnboarding` model, change:

```prisma
  onboardedById String?
  onboardedByAdmin AdminUser? @relation("ClientOnboardingByAdmin", fields: [onboardedById], references: [id])
  reviewedAt DateTime?
```

to:

```prisma
  onboardedById String?
  onboardedByAdmin AdminUser? @relation("ClientOnboardingByAdmin", fields: [onboardedById], references: [id])
  onboardedByAgentId String?
  onboardedByAgent Agent? @relation(fields: [onboardedByAgentId], references: [id])
  reviewedAt DateTime?
```

Prisma requires the opposite side of this relation to be declared too — add a back-relation field to the `Agent` model (in the same model block as Step 1, anywhere after `canOnboardClients`):

```prisma
  onboardedClients ClientOnboarding[]
```

- [ ] **Step 3: Run the migration**

Run: `npx prisma migrate dev --name agent_client_onboarding_tracking`
Expected: completes without data loss (both new fields are nullable/defaulted — no existing row needs a value).

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add Agent.canOnboardClients and ClientOnboarding.onboardedByAgentId"
```

---

### Task 2: Onboarding-source util, JWT payload, and the new agent guard

**Files:**
- Create: `src/client-onboarding/onboarding-source.util.ts`
- Create: `src/client-onboarding/onboarding-source.util.spec.ts`
- Modify: `src/auth/jwt-payload.interface.ts`
- Create: `src/auth/agent-can-onboard-clients.guard.ts`
- Create: `src/auth/agent-can-onboard-clients.guard.spec.ts`

**Interfaces:**
- Produces: `OnboardingSource` type, `deriveOnboardingSource(onboarding)` (consumed by Tasks 7, 8, 9), `JwtPayload.canOnboardClients?: boolean` (consumed by Tasks 4, 5), `AgentCanOnboardClientsGuard` (consumed by Task 4).

- [ ] **Step 1: Write `deriveOnboardingSource`**

```typescript
// src/client-onboarding/onboarding-source.util.ts
export type OnboardingSource = 'SELF' | 'AGENT' | 'ADMIN';

export function deriveOnboardingSource(
  onboarding: { onboardedById: string | null; onboardedByAgentId: string | null } | null | undefined,
): OnboardingSource | null {
  if (!onboarding) return null;
  if (onboarding.onboardedByAgentId) return 'AGENT';
  if (onboarding.onboardedById) return 'ADMIN';
  return 'SELF';
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/client-onboarding/onboarding-source.util.spec.ts
import { deriveOnboardingSource } from './onboarding-source.util';

describe('deriveOnboardingSource', () => {
  it('returns null when there is no onboarding record at all', () => {
    expect(deriveOnboardingSource(null)).toBeNull();
    expect(deriveOnboardingSource(undefined)).toBeNull();
  });

  it('returns SELF when neither onboardedById nor onboardedByAgentId is set', () => {
    expect(deriveOnboardingSource({ onboardedById: null, onboardedByAgentId: null })).toBe('SELF');
  });

  it('returns AGENT when onboardedByAgentId is set', () => {
    expect(deriveOnboardingSource({ onboardedById: null, onboardedByAgentId: 'agent-1' })).toBe('AGENT');
  });

  it('returns ADMIN when onboardedById is set and onboardedByAgentId is not', () => {
    expect(deriveOnboardingSource({ onboardedById: 'admin-1', onboardedByAgentId: null })).toBe('ADMIN');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/client-onboarding/onboarding-source.util.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Extend `JwtPayload`**

In `src/auth/jwt-payload.interface.ts`, change:

```typescript
export interface JwtPayload {
  sub: string;
  type: PrincipalType;
  permissions?: string[];
  mustChangePassword?: boolean;
}
```

to:

```typescript
export interface JwtPayload {
  sub: string;
  type: PrincipalType;
  permissions?: string[];
  mustChangePassword?: boolean;
  canOnboardClients?: boolean;
}
```

- [ ] **Step 5: Write the guard**

```typescript
// src/auth/agent-can-onboard-clients.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AgentCanOnboardClientsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!request.user?.canOnboardClients) {
      throw new ForbiddenException('Not authorized to onboard clients');
    }
    return true;
  }
}
```

- [ ] **Step 6: Write its spec**

```typescript
// src/auth/agent-can-onboard-clients.guard.spec.ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AgentCanOnboardClientsGuard } from './agent-can-onboard-clients.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AgentCanOnboardClientsGuard', () => {
  const guard = new AgentCanOnboardClientsGuard();

  it('allows when canOnboardClients is true', () => {
    expect(guard.canActivate(contextWithUser({ canOnboardClients: true }))).toBe(true);
  });

  it('rejects when canOnboardClients is false', () => {
    expect(() => guard.canActivate(contextWithUser({ canOnboardClients: false }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `npx jest src/auth/agent-can-onboard-clients.guard.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add src/client-onboarding/onboarding-source.util.ts src/client-onboarding/onboarding-source.util.spec.ts src/auth/jwt-payload.interface.ts src/auth/agent-can-onboard-clients.guard.ts src/auth/agent-can-onboard-clients.guard.spec.ts
git commit -m "feat(auth): add onboarding-source derivation, canOnboardClients JWT field, and its guard"
```

---

### Task 3: `ClientOnboardingService` — `agentStartOnboarding`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`

**Interfaces:**
- Produces: `ClientOnboardingService.agentStartOnboarding(ippisNumber, agentId): Promise<ClientOnboarding>` — consumed by Task 4.

- [ ] **Step 1: Give `createOnboardingRecord` a 4th parameter**

In `src/client-onboarding/client-onboarding.service.ts`, change:

```typescript
  private async createOnboardingRecord(
    clientId: string,
    ippisRecord: {
      id: string;
      employeeName: string;
      agency: string;
      bankName: string | null;
      accountNumber: string | null;
      employeeStatus: string | null;
      legacyId: string | null;
      maritalStatus: string | null;
    },
    onboardedById?: string,
  ) {
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        maritalStatus: ippisRecord.maritalStatus,
        step: OnboardingStep.IPPIS_LINKED,
        onboardedById,
      },
    });
```

to:

```typescript
  private async createOnboardingRecord(
    clientId: string,
    ippisRecord: {
      id: string;
      employeeName: string;
      agency: string;
      bankName: string | null;
      accountNumber: string | null;
      employeeStatus: string | null;
      legacyId: string | null;
      maritalStatus: string | null;
    },
    onboardedById?: string,
    onboardedByAgentId?: string,
  ) {
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        maritalStatus: ippisRecord.maritalStatus,
        step: OnboardingStep.IPPIS_LINKED,
        onboardedById,
        onboardedByAgentId,
      },
    });
```

(The rest of the method — the `client.update` call and `return onboarding` — is unchanged.)

- [ ] **Step 2: Add `agentStartOnboarding`**

Immediately after the existing `adminStartOnboarding` method, add:

```typescript
  async agentStartOnboarding(ippisNumber: string, agentId: string) {
    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const existing = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (existing) {
      if (existing.onboardedByAgentId === agentId) {
        return existing;
      }
      throw new ConflictException('This client has already been onboarded');
    }

    if (!ippisRecord.phone) {
      throw new UnprocessableEntityException(
        'No phone number on file for this IPPIS record — cannot resolve a client',
      );
    }

    const client = await this.prisma.client.upsert({
      where: { phone: ippisRecord.phone },
      update: {},
      create: { phone: ippisRecord.phone },
    });

    return this.createOnboardingRecord(client.id, ippisRecord, undefined, agentId);
  }
```

Note the `Client.create` here deliberately omits `createdById` (that FK only ever points to an `AdminUser`) — an agent-onboarded `Client` row has `createdById: null`, same as a self-onboarded one.

- [ ] **Step 3: Add the `agentStartOnboarding` test block**

In `src/client-onboarding/client-onboarding.service.spec.ts`, immediately after the existing `describe('adminStartOnboarding', ...)` block, add:

```typescript
  describe('agentStartOnboarding', () => {
    it('rejects when the IPPIS number is not found', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('resumes its own prior attempt when onboardedByAgentId matches this agent', async () => {
      const existingOnboarding = { id: 'existing', step: 'DOCUMENTS_SUBMITTED', onboardedByAgentId: 'agent-1' };
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(result).toBe(existingOnboarding);
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('rejects when the client was already onboarded by a different agent', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing', onboardedByAgentId: 'other-agent' });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client was already self-onboarded', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'existing',
        onboardedById: null,
        onboardedByAgentId: null,
      });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client was already admin-onboarded', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'existing',
        onboardedById: 'admin-1',
        onboardedByAgentId: null,
      });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('rejects with UnprocessableEntityException when the IPPIS record has no phone number on file', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: null });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('resolves the client by phone and creates the onboarding with onboardedByAgentId', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '+2348000000000',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348000000000' },
        update: {},
        create: { phone: '+2348000000000' },
      });
      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          onboardedByAgentId: 'agent-1',
        }),
      });
    });
  });
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS (all existing tests plus the 7 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat(client-onboarding): add agentStartOnboarding with same-agent-only resume restriction"
```

---

### Task 4: Agent onboarding controller

**Files:**
- Create: `src/client-onboarding/agent-client-onboarding.controller.ts`
- Modify: `src/client-onboarding/client-onboarding.module.ts`

**Interfaces:**
- Consumes: `ClientOnboardingService.agentStartOnboarding` (Task 3), `AgentCanOnboardClientsGuard` (Task 2).
- Produces: `POST/GET agent/clients/onboarding/*` routes.

- [ ] **Step 1: Write the controller**

```typescript
// src/client-onboarding/agent-client-onboarding.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { AgentCanOnboardClientsGuard } from '../auth/agent-can-onboard-clients.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientOnboardingService } from './client-onboarding.service';
import { LinkIppisDto } from './dto/link-ippis.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { ClientDocumentType } from '../generated/prisma/client';

@Controller('agent/clients')
@UseGuards(JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard)
export class AgentClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('onboarding/ippis-lookup')
  startOnboarding(@Body() dto: LinkIppisDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.agentStartOnboarding(dto.ippisNumber, req.user.sub);
  }

  @Post(':clientId/onboarding/identity')
  submitIdentity(@Param('clientId') clientId: string, @Body() dto: SubmitIdentityDto) {
    return this.clientOnboardingService.submitIdentityVerified(clientId, dto.bvn, dto.nin);
  }

  @Post(':clientId/onboarding/documents/:type')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (
        _req: Express.Request,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG, PNG, or PDF files are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadDocument(
    @Param('clientId') clientId: string,
    @Param('type', new ParseEnumPipe(ClientDocumentType)) type: ClientDocumentType,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.clientOnboardingService.uploadDocument(clientId, type, file);
  }

  @Post(':clientId/onboarding/face-match')
  submitFaceMatch(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.submitFaceMatchFromPassportPhoto(clientId);
  }

  @Get(':clientId/onboarding/status')
  getStatus(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.getStatus(clientId);
  }
}
```

- [ ] **Step 2: Wire it into `ClientOnboardingModule`**

In `src/client-onboarding/client-onboarding.module.ts`, add the import:

```typescript
import { AgentClientOnboardingController } from './agent-client-onboarding.controller';
```

and add it to the `controllers` array:

```typescript
  controllers: [ClientOnboardingController, AdminClientOnboardingController, AgentClientOnboardingController],
```

- [ ] **Step 3: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/client-onboarding/agent-client-onboarding.controller.ts src/client-onboarding/client-onboarding.module.ts
git commit -m "feat(client-onboarding): add agent-facing onboarding controller"
```

---

### Task 5: Agent login/refresh — carry `canOnboardClients` in the JWT

**Files:**
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`
- Modify: `src/auth/session/session-auth.controller.ts`

**Interfaces:**
- Produces: `AgentAuthService.getCanOnboardClientsForAgent(agentId): Promise<boolean>` — consumed by `SessionAuthController.refresh`.

- [ ] **Step 1: Add `getCanOnboardClientsForAgent`**

In `src/auth/agent/agent-auth.service.ts`, immediately after `getMustChangePasswordForAgent`, add:

```typescript
  async getCanOnboardClientsForAgent(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    return agent?.canOnboardClients ?? false;
  }
```

- [ ] **Step 2: Include it in the issued JWT**

Change:

```typescript
  private async issueTokens(agent: { id: string; mustChangePassword: boolean }, meta?: { userAgent?: string; ip?: string }) {
    const payload = { sub: agent.id, type: 'agent' as const, mustChangePassword: agent.mustChangePassword };
```

to:

```typescript
  private async issueTokens(
    agent: { id: string; mustChangePassword: boolean; canOnboardClients: boolean },
    meta?: { userAgent?: string; ip?: string },
  ) {
    const payload = {
      sub: agent.id,
      type: 'agent' as const,
      mustChangePassword: agent.mustChangePassword,
      canOnboardClients: agent.canOnboardClients,
    };
```

(Both call sites — `login()` and `verifyTwoFactorLogin()` — already pass the full Prisma `Agent` row, which has `canOnboardClients` after Task 1's migration. No call-site changes needed.)

- [ ] **Step 3: Add tests**

In `src/auth/agent/agent-auth.service.spec.ts`, add a new test inside the existing `describe('login', ...)` block, right after the `'issues tokens, marks hasLoggedIn, and includes mustChangePassword in the payload'` test:

```typescript
    it('includes canOnboardClients in the payload when the agent has it enabled', async () => {
      const passwordHash = await hashPassword('secret-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        mustChangePassword: false,
        canOnboardClients: true,
      });

      await service.login('agent@example.com', 'secret-password');

      expect(tokenService.signAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ canOnboardClients: true }),
      );
    });
```

And add a new describe block, right after the existing `describe('getMustChangePasswordForAgent', ...)` block:

```typescript
  describe('getCanOnboardClientsForAgent', () => {
    it("returns the agent's current flag", async () => {
      prisma.agent.findUnique.mockResolvedValue({ canOnboardClients: true });
      await expect(service.getCanOnboardClientsForAgent('agent-1')).resolves.toBe(true);
    });

    it('returns false when the agent no longer exists', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.getCanOnboardClientsForAgent('missing')).resolves.toBe(false);
    });
  });
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS (all existing tests plus the 3 new ones)

- [ ] **Step 5: Carry it through token refresh**

In `src/auth/session/session-auth.controller.ts`, change:

```typescript
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
```

to:

```typescript
    const mustChangePassword =
      result.principalType === SessionPrincipalType.AGENT
        ? await this.agentAuthService.getMustChangePasswordForAgent(result.principalId)
        : undefined;

    const canOnboardClients =
      result.principalType === SessionPrincipalType.AGENT
        ? await this.agentAuthService.getCanOnboardClientsForAgent(result.principalId)
        : undefined;

    const payload: JwtPayload = {
      sub: result.principalId,
      type: toJwtPrincipalType(result.principalType),
      permissions,
      mustChangePassword,
      canOnboardClients,
    };
```

- [ ] **Step 6: Commit**

```bash
git add src/auth/agent/agent-auth.service.ts src/auth/agent/agent-auth.service.spec.ts src/auth/session/session-auth.controller.ts
git commit -m "feat(auth): carry canOnboardClients through agent login and token refresh"
```

---

### Task 6: Admin toggle for agent onboarding access

**Files:**
- Create: `src/admin-agent-review/dto/set-onboarding-access.dto.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.spec.ts`
- Modify: `src/admin-agent-review/admin-agent-review.controller.ts`

**Interfaces:**
- Produces: `PATCH admin/agents/:id/onboarding-access`, permission `agents:onboarding-access:manage` (seeded in Task 10).

- [ ] **Step 1: Write the DTO**

```typescript
// src/admin-agent-review/dto/set-onboarding-access.dto.ts
import { IsBoolean } from 'class-validator';

export class SetOnboardingAccessDto {
  @IsBoolean()
  canOnboardClients: boolean;
}
```

- [ ] **Step 2: Add the service method**

In `src/admin-agent-review/admin-agent-review.service.ts`, change the import line:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
```

to:

```typescript
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
```

Then add, right after `findById`:

```typescript
  async setOnboardingAccess(id: string, canOnboardClients: boolean): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (canOnboardClients && agent.status !== AgentStatus.APPROVED) {
      throw new UnprocessableEntityException('Agent must be APPROVED before granting client-onboarding access');
    }

    return this.prisma.agent.update({ where: { id }, data: { canOnboardClients } });
  }
```

- [ ] **Step 3: Add tests**

In `src/admin-agent-review/admin-agent-review.service.spec.ts`, change the import line:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
```

to:

```typescript
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
```

Then add, right after the closing of the `describe('approve', ...)` block:

```typescript
  describe('setOnboardingAccess', () => {
    it('throws NotFoundException when the agent does not exist', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.setOnboardingAccess('missing', true)).rejects.toThrow(NotFoundException);
    });

    it('rejects enabling access for a non-APPROVED agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      await expect(service.setOnboardingAccess('a1', true)).rejects.toThrow(UnprocessableEntityException);
    });

    it('allows disabling access regardless of status', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      prisma.agent.update.mockResolvedValue({ id: 'a1', canOnboardClients: false });

      await service.setOnboardingAccess('a1', false);

      expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { canOnboardClients: false } });
    });

    it('enables access for an APPROVED agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED' });
      prisma.agent.update.mockResolvedValue({ id: 'a1', canOnboardClients: true });

      const result = await service.setOnboardingAccess('a1', true);

      expect(result.canOnboardClients).toBe(true);
    });
  });
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire the controller route**

In `src/admin-agent-review/admin-agent-review.controller.ts`, change the import line:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
```

to:

```typescript
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
```

Add the import:

```typescript
import { SetOnboardingAccessDto } from './dto/set-onboarding-access.dto';
```

Then add, right after the `resendCredentials` method:

```typescript
  @Patch(':id/onboarding-access')
  @HttpCode(200)
  @RequirePermissions('agents:onboarding-access:manage')
  setOnboardingAccess(@Param('id') id: string, @Body() dto: SetOnboardingAccessDto) {
    return this.adminAgentReviewService.setOnboardingAccess(id, dto.canOnboardClients);
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/admin-agent-review/dto/set-onboarding-access.dto.ts src/admin-agent-review/admin-agent-review.service.ts src/admin-agent-review/admin-agent-review.service.spec.ts src/admin-agent-review/admin-agent-review.controller.ts
git commit -m "feat(admin-agent-review): add PATCH admin/agents/:id/onboarding-access toggle"
```

---

### Task 7: Admin client list — `onboardingSource` field + filter

**Files:**
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`
- Modify: `src/admin-client-review/dto/list-clients-query.dto.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`

**Interfaces:**
- Consumes: `deriveOnboardingSource`, `OnboardingSource` (Task 2).
- Produces: `onboardingSource` field on every `GET admin/clients`/`GET admin/clients/:id` response; `onboardingSource` query filter on the list.

- [ ] **Step 1: Update the service**

In `src/admin-client-review/admin-client-review.service.ts`, add the import:

```typescript
import { deriveOnboardingSource, OnboardingSource } from '../client-onboarding/onboarding-source.util';
```

Add `onboardingSource` to the filters interface:

```typescript
export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  onboardingSource?: OnboardingSource;
}
```

Replace the `list` method with:

```typescript
  async list(
    filters: ListClientsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientWhereInput = {
      status: filters.status,
      phone: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      onboarding: this.buildOnboardingSourceWhere(filters.onboardingSource),
    };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: { onboarding: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return buildPaginatedResult(
      data.map((client) => ({ ...client, onboardingSource: deriveOnboardingSource(client.onboarding) })),
      total,
      page,
      limit,
    );
  }

  private buildOnboardingSourceWhere(onboardingSource?: OnboardingSource) {
    if (!onboardingSource) return undefined;
    if (onboardingSource === 'AGENT') return { onboardedByAgentId: { not: null } };
    if (onboardingSource === 'ADMIN') return { onboardedById: { not: null } };
    return { onboardedById: null, onboardedByAgentId: null }; // SELF
  }
```

In `findById`, add `onboardedByAgent` to the `onboarding.include` block:

```typescript
        onboarding: {
          include: {
            documents: true,
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            onboardedByAdmin: { select: { id: true, fullName: true, email: true } },
            onboardedByAgent: { select: { id: true, fullName: true, email: true } },
          },
        },
```

Then change the two `return` statements. Replace:

```typescript
      return {
        ...client,
        onboarding: {
          ...client.onboarding,
          documents,
          lengthOfService,
          ippisRecord,
          bvnSelfieUrl,
          ninSelfieUrl,
          liveSelfieUrl,
        },
      };
    }

    return { ...client, onboarding: null };
```

with:

```typescript
      return {
        ...client,
        onboardingSource: deriveOnboardingSource(client.onboarding),
        onboarding: {
          ...client.onboarding,
          documents,
          lengthOfService,
          ippisRecord,
          bvnSelfieUrl,
          ninSelfieUrl,
          liveSelfieUrl,
        },
      };
    }

    return { ...client, onboardingSource: deriveOnboardingSource(client.onboarding), onboarding: null };
```

- [ ] **Step 2: Update the existing exact-match test**

In `src/admin-client-review/admin-client-review.service.spec.ts`, the `'lists all clients with their onboarding record, defaulting to page 1/limit 25'` test currently asserts:

```typescript
          where: { status: undefined, phone: undefined, createdAt: undefined },
```

Change it to:

```typescript
          where: { status: undefined, phone: undefined, createdAt: undefined, onboarding: undefined },
```

(Every other existing test in this file uses `expect.objectContaining` and needs no change.)

- [ ] **Step 3: Add new tests**

Add, right after the `'applies a createdAt date range'` test inside `describe('list', ...)`:

```typescript
    it('attaches a derived onboardingSource to each row', async () => {
      prisma.client.findMany.mockResolvedValue([
        { id: 'c1', onboarding: { onboardedById: null, onboardedByAgentId: null } },
        { id: 'c2', onboarding: { onboardedById: null, onboardedByAgentId: 'agent-1' } },
        { id: 'c3', onboarding: { onboardedById: 'admin-1', onboardedByAgentId: null } },
        { id: 'c4', onboarding: null },
      ]);
      prisma.client.count.mockResolvedValue(4);

      const result = await service.list();

      expect(result.data.map((c: { onboardingSource: string | null }) => c.onboardingSource)).toEqual([
        'SELF',
        'AGENT',
        'ADMIN',
        null,
      ]);
    });

    it('translates the onboardingSource filter into the matching where clause', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ onboardingSource: 'AGENT' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ onboarding: { onboardedByAgentId: { not: null } } }) }),
      );

      await service.list({ onboardingSource: 'ADMIN' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ onboarding: { onboardedById: { not: null } } }) }),
      );

      await service.list({ onboardingSource: 'SELF' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedById: null, onboardedByAgentId: null } }),
        }),
      );
    });
```

Add, right after the `'does not fail when the client has no onboarding record'` test inside `describe('findById', ...)`:

```typescript
    it('includes a derived onboardingSource', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', onboardedById: null, onboardedByAgentId: 'agent-1' },
      });
      const result = await service.findById('c1');
      expect(result.onboardingSource).toBe('AGENT');
    });
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the query filter**

In `src/admin-client-review/dto/list-clients-query.dto.ts`, change:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

to:

```typescript
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsIn(['SELF', 'AGENT', 'ADMIN'])
  onboardingSource?: 'SELF' | 'AGENT' | 'ADMIN';
}
```

- [ ] **Step 6: Wire it into the controller**

In `src/admin-client-review/admin-client-review.controller.ts`, change:

```typescript
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

to:

```typescript
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        onboardingSource: query.onboardingSource,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

- [ ] **Step 7: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts src/admin-client-review/dto/list-clients-query.dto.ts src/admin-client-review/admin-client-review.controller.ts
git commit -m "feat(admin-client-review): add onboardingSource field and filter to the client list"
```

---

### Task 8: Agent's own "clients I onboarded" list

**Files:**
- Create: `src/agent-clients/agent-clients.service.ts`
- Create: `src/agent-clients/agent-clients.service.spec.ts`
- Create: `src/agent-clients/dto/list-my-clients-query.dto.ts`
- Create: `src/agent-clients/agent-clients.controller.ts`
- Create: `src/agent-clients/agent-clients.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `GET agent/clients` (separate controller class, same route prefix as Task 4's `AgentClientOnboardingController`, mirroring how `admin/clients` is already split across `AdminClientOnboardingController` and `AdminClientReviewController` in two different modules).

- [ ] **Step 1: Write the service**

```typescript
// src/agent-clients/agent-clients.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface ListMyClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AgentClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMyClients(
    agentId: string,
    filters: ListMyClientsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientWhereInput = {
      onboarding: { onboardedByAgentId: agentId },
      status: filters.status,
      phone: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: { onboarding: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/agent-clients/agent-clients.service.spec.ts
import { AgentClientsService } from './agent-clients.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AgentClientsService', () => {
  let service: AgentClientsService;
  let prisma: { client: { findMany: jest.Mock; count: jest.Mock } };

  beforeEach(() => {
    prisma = { client: { findMany: jest.fn(), count: jest.fn() } };
    service = new AgentClientsService(prisma as unknown as PrismaService);
  });

  describe('listMyClients', () => {
    it('scopes the query to onboardedByAgentId for this agent only', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.listMyClients('agent-1');

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });

    it('applies status/q/date-range filters alongside the agent scope', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.listMyClients('agent-1', { status: 'VERIFIED' as never, q: '0801', createdFrom, createdTo });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            onboarding: { onboardedByAgentId: 'agent-1' },
            status: 'VERIFIED',
            phone: { contains: '0801', mode: 'insensitive' },
            createdAt: { gte: createdFrom, lte: createdTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.listMyClients('agent-1', {}, { page: 2, limit: 10 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    });
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/agent-clients/agent-clients.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Write the DTO**

```typescript
// src/agent-clients/dto/list-my-clients-query.dto.ts
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListMyClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Write the controller**

```typescript
// src/agent-clients/agent-clients.controller.ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AgentClientsService } from './agent-clients.service';
import { ListMyClientsQueryDto } from './dto/list-my-clients-query.dto';

@Controller('agent/clients')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentClientsController {
  constructor(private readonly agentClientsService: AgentClientsService) {}

  @Get()
  list(@Query() query: ListMyClientsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.agentClientsService.listMyClients(
      req.user.sub,
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
```

Note: this route is deliberately NOT guarded by `AgentCanOnboardClientsGuard` — an agent whose access was later revoked can still see clients they previously onboarded (per the design spec §6).

- [ ] **Step 6: Write the module**

```typescript
// src/agent-clients/agent-clients.module.ts
import { Module } from '@nestjs/common';
import { AgentClientsController } from './agent-clients.controller';
import { AgentClientsService } from './agent-clients.service';

@Module({
  controllers: [AgentClientsController],
  providers: [AgentClientsService],
})
export class AgentClientsModule {}
```

- [ ] **Step 7: Wire it into `AppModule`**

In `src/app.module.ts`, add the import:

```typescript
import { AgentClientsModule } from './agent-clients/agent-clients.module';
```

and add it to the `imports` array (anywhere alongside the other feature modules, e.g. right after `AgentEnrollmentModule`):

```typescript
    AgentEnrollmentModule,
    AgentClientsModule,
```

- [ ] **Step 8: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/agent-clients src/app.module.ts
git commit -m "feat(agent-clients): add agent-facing clients-I-onboarded list"
```

---

### Task 9: Admin analytics summary endpoint

**Files:**
- Create: `src/admin-client-review/admin-client-analytics.service.ts`
- Create: `src/admin-client-review/admin-client-analytics.service.spec.ts`
- Create: `src/admin-client-review/dto/client-analytics-query.dto.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`
- Modify: `src/admin-client-review/admin-client-review.module.ts`

**Interfaces:**
- Produces: `GET admin/clients/analytics`, permission `clients:analytics:read` (seeded in Task 10).

- [ ] **Step 1: Write the service**

```typescript
// src/admin-client-review/admin-client-analytics.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';

export interface ClientAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ClientAnalyticsSummary {
  totalClients: number;
  bySource: { SELF: number; AGENT: number; ADMIN: number; NONE: number };
  byOnboardingStep: Record<OnboardingStep, number>;
  byClientStatus: Record<ClientStatus, number>;
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    totalOnboarded: number;
    completedCount: number;
    stalledCount: number;
  }>;
  activity: {
    clientsWithAtLeastOneLoanRequest: number;
    clientsWithAtLeastOneDisbursedLoan: number;
    clientsWithAtLeastOneSession: number;
    totalLoanRequests: number;
    totalWalletEntries: number;
  };
}

@Injectable()
export class AdminClientAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(filters: ClientAnalyticsFilters = {}): Promise<ClientAnalyticsSummary> {
    const clientWhere: Prisma.ClientWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [
      totalClients,
      selfCount,
      agentCount,
      adminCount,
      noneCount,
      onboardingStepGroups,
      clientStatusGroups,
      agentLeaderboard,
      activity,
    ] = await Promise.all([
      this.prisma.client.count({ where: clientWhere }),
      this.prisma.client.count({
        where: { ...clientWhere, onboarding: { onboardedById: null, onboardedByAgentId: null } },
      }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: { onboardedByAgentId: { not: null } } } }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: { onboardedById: { not: null } } } }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: null } }),
      this.prisma.clientOnboarding.groupBy({
        by: ['step'],
        where: { client: clientWhere },
        _count: { _all: true },
      }),
      this.prisma.client.groupBy({
        by: ['status'],
        where: clientWhere,
        _count: { _all: true },
      }),
      this.buildAgentLeaderboard(clientWhere),
      this.buildActivity(clientWhere),
    ]);

    const byOnboardingStep = Object.fromEntries(
      Object.values(OnboardingStep).map((step) => [
        step,
        onboardingStepGroups.find((g) => g.step === step)?._count._all ?? 0,
      ]),
    ) as Record<OnboardingStep, number>;

    const byClientStatus = Object.fromEntries(
      Object.values(ClientStatus).map((status) => [
        status,
        clientStatusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<ClientStatus, number>;

    return {
      totalClients,
      bySource: { SELF: selfCount, AGENT: agentCount, ADMIN: adminCount, NONE: noneCount },
      byOnboardingStep,
      byClientStatus,
      agentLeaderboard,
      activity,
    };
  }

  private async buildAgentLeaderboard(clientWhere: Prisma.ClientWhereInput) {
    const grouped = await this.prisma.clientOnboarding.groupBy({
      by: ['onboardedByAgentId'],
      where: { onboardedByAgentId: { not: null }, client: clientWhere },
      _count: { _all: true },
    });

    const results = await Promise.all(
      grouped.map(async (group) => {
        const agentId = group.onboardedByAgentId!;
        const [agent, completedCount] = await Promise.all([
          this.prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } }),
          this.prisma.clientOnboarding.count({
            where: { onboardedByAgentId: agentId, step: OnboardingStep.COMPLETED, client: clientWhere },
          }),
        ]);
        const totalOnboarded = group._count._all;
        return {
          agentId,
          agentName: agent?.fullName ?? 'Unknown agent',
          totalOnboarded,
          completedCount,
          stalledCount: totalOnboarded - completedCount,
        };
      }),
    );

    return results.sort((a, b) => b.totalOnboarded - a.totalOnboarded);
  }

  private async buildActivity(clientWhere: Prisma.ClientWhereInput) {
    const [
      clientsWithAtLeastOneLoanRequest,
      clientsWithAtLeastOneDisbursedLoan,
      clientsWithAtLeastOneSession,
      totalLoanRequests,
      totalWalletEntries,
    ] = await Promise.all([
      this.prisma.client.count({ where: { ...clientWhere, loanRequests: { some: {} } } }),
      this.prisma.client.count({ where: { ...clientWhere, clientLoans: { some: {} } } }),
      this.countClientsWithSession(clientWhere),
      this.prisma.loanRequest.count({ where: { client: clientWhere } }),
      this.prisma.walletEntry.count({ where: { client: clientWhere } }),
    ]);

    return {
      clientsWithAtLeastOneLoanRequest,
      clientsWithAtLeastOneDisbursedLoan,
      clientsWithAtLeastOneSession,
      totalLoanRequests,
      totalWalletEntries,
    };
  }

  private async countClientsWithSession(clientWhere: Prisma.ClientWhereInput): Promise<number> {
    const clients = await this.prisma.client.findMany({ where: clientWhere, select: { id: true } });
    if (clients.length === 0) return 0;
    const sessions = await this.prisma.session.findMany({
      where: { principalType: 'CLIENT', principalId: { in: clients.map((c) => c.id) } },
      select: { principalId: true },
      distinct: ['principalId'],
    });
    return sessions.length;
  }
}
```

Note: `Session` has no direct Prisma relation to `Client` (it's a polymorphic `principalType`/`principalId` pair, shared across ADMIN/AGENT/CLIENT), so `clientsWithAtLeastOneSession` is necessarily a two-step lookup (matching client ids, then distinct sessions for those ids) rather than a single relation-filtered `count`. This is the one place in this service that can't be a single aggregate query — acceptable per the design spec's explicit allowance for a "bounded query count" in this first version.

- [ ] **Step 2: Write its spec**

```typescript
// src/admin-client-review/admin-client-analytics.service.spec.ts
import { AdminClientAnalyticsService } from './admin-client-analytics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientAnalyticsService', () => {
  let service: AdminClientAnalyticsService;
  let prisma: {
    client: { count: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
    clientOnboarding: { groupBy: jest.Mock; count: jest.Mock };
    agent: { findUnique: jest.Mock };
    loanRequest: { count: jest.Mock };
    walletEntry: { count: jest.Mock };
    session: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      clientOnboarding: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      agent: { findUnique: jest.fn() },
      loanRequest: { count: jest.fn().mockResolvedValue(0) },
      walletEntry: { count: jest.fn().mockResolvedValue(0) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminClientAnalyticsService(prisma as unknown as PrismaService);
  });

  it('fills every OnboardingStep and ClientStatus key even when groupBy returns no rows for them', async () => {
    const result = await service.getSummary();

    expect(Object.keys(result.byOnboardingStep).sort()).toEqual(
      ['COMPLETED', 'DOCUMENTS_SUBMITTED', 'FACE_MATCH_PENDING', 'IDENTITY_SUBMITTED', 'IPPIS_LINKED', 'PHONE_VERIFIED'].sort(),
    );
    expect(Object.values(result.byOnboardingStep).every((v) => v === 0)).toBe(true);
    expect(Object.keys(result.byClientStatus).sort()).toEqual(
      ['MANUAL_REVIEW', 'PENDING_IPPIS', 'PHONE_VERIFIED', 'VERIFIED'].sort(),
    );
  });

  it('maps groupBy counts onto the right step/status keys', async () => {
    prisma.clientOnboarding.groupBy.mockResolvedValue([{ step: 'COMPLETED', _count: { _all: 7 } }]);
    prisma.client.groupBy.mockResolvedValue([{ status: 'VERIFIED', _count: { _all: 7 } }]);

    const result = await service.getSummary();

    expect(result.byOnboardingStep.COMPLETED).toBe(7);
    expect(result.byClientStatus.VERIFIED).toBe(7);
  });

  it('builds a sorted agent leaderboard with stalledCount derived from totalOnboarded - completedCount', async () => {
    prisma.clientOnboarding.groupBy.mockResolvedValue([
      { onboardedByAgentId: 'agent-1', _count: { _all: 10 } },
      { onboardedByAgentId: 'agent-2', _count: { _all: 20 } },
    ]);
    prisma.agent.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ fullName: where.id === 'agent-1' ? 'Agent One' : 'Agent Two' }),
    );
    prisma.clientOnboarding.count.mockImplementation(({ where }: { where: { onboardedByAgentId: string } }) =>
      Promise.resolve(where.onboardedByAgentId === 'agent-1' ? 4 : 20),
    );

    const result = await service.getSummary();

    expect(result.agentLeaderboard).toEqual([
      { agentId: 'agent-2', agentName: 'Agent Two', totalOnboarded: 20, completedCount: 20, stalledCount: 0 },
      { agentId: 'agent-1', agentName: 'Agent One', totalOnboarded: 10, completedCount: 4, stalledCount: 6 },
    ]);
  });

  it('skips the session lookup entirely when there are no matching clients', async () => {
    prisma.client.findMany.mockResolvedValue([]);
    await service.getSummary();
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('counts distinct clients with at least one session', async () => {
    prisma.client.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    prisma.session.findMany.mockResolvedValue([{ principalId: 'c1' }]);

    const result = await service.getSummary();

    expect(result.activity.clientsWithAtLeastOneSession).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/admin-client-review/admin-client-analytics.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Write the query DTO**

```typescript
// src/admin-client-review/dto/client-analytics-query.dto.ts
import { IsISO8601, IsOptional } from 'class-validator';

export class ClientAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Wire the controller route**

In `src/admin-client-review/admin-client-review.controller.ts`, add the imports:

```typescript
import { AdminClientAnalyticsService } from './admin-client-analytics.service';
import { ClientAnalyticsQueryDto } from './dto/client-analytics-query.dto';
```

Add it to the constructor:

```typescript
  constructor(
    private readonly adminClientReviewService: AdminClientReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly adminClientActivityService: AdminClientActivityService,
    private readonly adminClientAnalyticsService: AdminClientAnalyticsService,
  ) {}
```

**Route ordering matters here**: add the new route between `list()` and `findOne()` — `analytics` must be registered as a literal path segment *before* the `:id` param route, or NestJS will try to match it as `findOne('analytics')` instead:

```typescript
  @Get()
  @RequirePermissions('clients:review')
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        onboardingSource: query.onboardingSource,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('analytics')
  @RequirePermissions('clients:analytics:read')
  getAnalytics(@Query() query: ClientAnalyticsQueryDto) {
    return this.adminClientAnalyticsService.getSummary({
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('clients:review')
  findOne(@Param('id') id: string) {
    return this.adminClientReviewService.findById(id);
  }
```

- [ ] **Step 6: Register the service in the module**

In `src/admin-client-review/admin-client-review.module.ts`, add the import:

```typescript
import { AdminClientAnalyticsService } from './admin-client-analytics.service';
```

and add it to `providers`:

```typescript
  providers: [AdminClientReviewService, AdminClientActivityService, AdminClientAnalyticsService],
```

- [ ] **Step 7: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/admin-client-review/admin-client-analytics.service.ts src/admin-client-review/admin-client-analytics.service.spec.ts src/admin-client-review/dto/client-analytics-query.dto.ts src/admin-client-review/admin-client-review.controller.ts src/admin-client-review/admin-client-review.module.ts
git commit -m "feat(admin-client-review): add GET admin/clients/analytics summary endpoint"
```

---

### Task 10: Permission seeding

**Files:**
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: permission keys `agents:onboarding-access:manage` and `clients:analytics:read`, available after the next seed run — `SetOnboardingAccessDto`'s route (Task 6) and the analytics route (Task 9) already reference these keys via `@RequirePermissions`.

- [ ] **Step 1: Add the two new permissions**

In `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS` array, add (anywhere in the array — order doesn't matter, grouping near the existing `clients:*`/`agents:*` entries is just for readability):

```typescript
  { key: 'agents:onboarding-access:manage', description: "Grant or revoke an agent's ability to onboard clients" },
  { key: 'clients:analytics:read', description: 'View aggregate client onboarding and activity analytics' },
```

- [ ] **Step 2: Run the seed script to verify it doesn't error**

Run: `npx prisma db seed`
Expected: completes without error; both new permissions now exist as `Permission` rows, auto-granted to `SUPER_ADMIN`.

- [ ] **Step 3: Commit**

```bash
git add prisma/seed.ts
git commit -m "chore: seed agents:onboarding-access:manage and clients:analytics:read permissions"
```

---

### Task 11: e2e — agent onboarding flow + restriction

**Files:**
- Create: `test/agent-client-onboarding.e2e-spec.ts`

**Interfaces:**
- Consumes: `/agent/clients/onboarding/*` (Task 4), `/auth/agent/login` (Task 5), `/admin/clients/onboarding/ippis-lookup` (existing), `/client/onboarding/ippis-link` (existing).

- [ ] **Step 1: Write the spec**

```typescript
// test/agent-client-onboarding.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { hashPassword } from '../src/common/password-hash.util';

describe('Agent-initiated client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const createdAgentIds: string[] = [];
  const documentTypes = ['NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE'];

  async function createAgent(emailPrefix: string, canOnboardClients: boolean) {
    const agent = await prisma.agent.create({
      data: {
        email: `${emailPrefix}-${Date.now()}@example.com`,
        phone: '+2348012340000',
        fullName: `E2E ${emailPrefix}`,
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: `agents/e2e/${emailPrefix}.pdf`,
        canOnboardClients,
      },
    });
    createdAgentIds.push(agent.id);
    const accessToken = tokenService.signAccessToken({ sub: agent.id, type: 'agent', canOnboardClients });
    return { agent, accessToken };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);
  });

  afterAll(async () => {
    await prisma.clientDocument.deleteMany({ where: { clientOnboarding: { clientId: { in: createdClientIds } } } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it('rejects onboarding start for an agent without canOnboardClients', async () => {
    const { accessToken } = await createAgent('no-access', false);
    const staffId = `E2E-AGENT-NOACCESS-${Date.now()}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'No Access Client', phone: `+234806${Date.now().toString().slice(-7)}` },
    });

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(403);
  });

  it(
    'runs the full agent journey: ippis-lookup creates the client, identity verifies, 4 documents, passport face-match completes',
    async () => {
      const { agent, accessToken } = await createAgent('full-journey', true);
      const staffId = `E2E-AGENT-FULL-${Date.now()}`;
      const phone = `+234807${Date.now().toString().slice(-7)}`;
      createdStaffIds.push(staffId);
      await prisma.ippisRecord.create({
        data: { agency: 'NPF', staffId, employeeName: 'Agent Onboarded Client', bankName: 'Test Bank', accountNumber: '0000000020', phone },
      });

      const lookupRes = await request(app.getHttpServer())
        .post('/agent/clients/onboarding/ippis-lookup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ippisNumber: staffId })
        .expect(201);
      expect(lookupRes.body.step).toBe('IPPIS_LINKED');
      const clientId = lookupRes.body.clientId;
      createdClientIds.push(clientId);

      await request(app.getHttpServer())
        .post(`/agent/clients/${clientId}/onboarding/identity`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ bvn: '12345678901', nin: '98765432109' })
        .expect(201)
        .expect((res) => {
          expect(res.body.step).toBe('IDENTITY_SUBMITTED');
          expect(res.body.identityVerified).toBe(true);
        });

      for (const documentType of documentTypes) {
        await request(app.getHttpServer())
          .post(`/agent/clients/${clientId}/onboarding/documents/${documentType}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
          .expect(201);
      }

      await request(app.getHttpServer())
        .post(`/agent/clients/${clientId}/onboarding/face-match`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(201)
        .expect((res) => {
          expect(res.body.step).toBe('COMPLETED');
          expect(res.body.faceMatchPassed).toBe(true);
        });

      const onboarding = await prisma.clientOnboarding.findUniqueOrThrow({ where: { clientId } });
      expect(onboarding.onboardedByAgentId).toBe(agent.id);
      expect(onboarding.onboardedById).toBeNull();

      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(client.status).toBe('VERIFIED');
      expect(client.createdById).toBeNull();
    },
    20000,
  );

  it('resumes its own in-progress onboarding idempotently on a second ippis-lookup call', async () => {
    const { accessToken } = await createAgent('resume', true);
    const staffId = `E2E-AGENT-RESUME-${Date.now()}`;
    const phone = `+234808${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Resume Client', phone } });

    const firstRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(firstRes.body.clientId);

    const secondRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(secondRes.body.clientId).toBe(firstRes.body.clientId);
  });

  it('rejects a different agent from onboarding a client another agent already started', async () => {
    const { accessToken: firstAgentToken } = await createAgent('owner', true);
    const { accessToken: otherAgentToken } = await createAgent('intruder', true);
    const staffId = `E2E-AGENT-TAKEOVER-${Date.now()}`;
    const phone = `+234809${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Takeover Target', phone } });

    const firstRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${firstAgentToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(firstRes.body.clientId);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${otherAgentToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('rejects an agent from onboarding a client who already self-onboarded', async () => {
    const { accessToken } = await createAgent('vs-self', true);
    const staffId = `E2E-AGENT-VSSELF-${Date.now()}`;
    const phone = `+234810${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Self Onboarded Client', phone } });

    const client = await prisma.client.create({ data: { phone } });
    createdClientIds.push(client.id);
    const clientAccessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('rejects an agent from onboarding a client who was already admin-onboarded', async () => {
    const { accessToken } = await createAgent('vs-admin', true);
    const staffId = `E2E-AGENT-VSADMIN-${Date.now()}`;
    const phone = `+234811${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Admin Onboarded Client', phone } });

    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    const adminAccessToken = adminLoginRes.body.accessToken;

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(lookupRes.body.clientId);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('includes canOnboardClients in the JWT issued at real login', async () => {
    const plainPassword = 'a-strong-password';
    const agent = await prisma.agent.create({
      data: {
        email: `real-login-${Date.now()}@example.com`,
        phone: '+2348012340001',
        fullName: 'E2E Real Login Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/real-login.pdf',
        canOnboardClients: true,
        passwordHash: await hashPassword(plainPassword),
      },
    });
    createdAgentIds.push(agent.id);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: agent.email, password: plainPassword })
      .expect(200);
    const decoded = JSON.parse(Buffer.from(loginRes.body.accessToken.split('.')[1], 'base64url').toString());
    expect(decoded.canOnboardClients).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json agent-client-onboarding`
Expected: PASS (7 tests). Per established project practice, re-run in isolation before treating any failure as a real regression — this is a shared UAT database with known DB-contention flakiness under concurrent load.

- [ ] **Step 3: Commit**

```bash
git add test/agent-client-onboarding.e2e-spec.ts
git commit -m "test(e2e): add agent-initiated client onboarding and restriction coverage"
```

---

### Task 12: e2e — agent's own clients list

**Files:**
- Create: `test/agent-clients.e2e-spec.ts`

**Interfaces:**
- Consumes: `/agent/clients` GET (Task 8).

- [ ] **Step 1: Write the spec**

```typescript
// test/agent-clients.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent own-clients list (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("only returns clients this agent onboarded, not another agent's", async () => {
    const agentA = await prisma.agent.create({
      data: {
        email: `agent-a-${Date.now()}@example.com`,
        phone: '+2348012340002',
        fullName: 'Agent A',
        address: '1 St',
        status: 'APPROVED',
        cvKey: 'agents/e2e/a.pdf',
        canOnboardClients: true,
      },
    });
    createdAgentIds.push(agentA.id);
    const agentB = await prisma.agent.create({
      data: {
        email: `agent-b-${Date.now()}@example.com`,
        phone: '+2348012340003',
        fullName: 'Agent B',
        address: '1 St',
        status: 'APPROVED',
        cvKey: 'agents/e2e/b.pdf',
        canOnboardClients: true,
      },
    });
    createdAgentIds.push(agentB.id);
    const agentAToken = tokenService.signAccessToken({ sub: agentA.id, type: 'agent', canOnboardClients: true });
    const agentBToken = tokenService.signAccessToken({ sub: agentB.id, type: 'agent', canOnboardClients: true });

    const staffIdA = `E2E-MYCLIENTS-A-${Date.now()}`;
    const staffIdB = `E2E-MYCLIENTS-B-${Date.now()}`;
    createdStaffIds.push(staffIdA, staffIdB);
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: staffIdA, employeeName: 'Client Of A', phone: `+234812${Date.now().toString().slice(-7)}` },
    });
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: staffIdB, employeeName: 'Client Of B', phone: `+234813${Date.now().toString().slice(-7)}` },
    });

    const resA = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${agentAToken}`)
      .send({ ippisNumber: staffIdA })
      .expect(201);
    createdClientIds.push(resA.body.clientId);

    const resB = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${agentBToken}`)
      .send({ ippisNumber: staffIdB })
      .expect(201);
    createdClientIds.push(resB.body.clientId);

    const listRes = await request(app.getHttpServer())
      .get('/agent/clients')
      .set('Authorization', `Bearer ${agentAToken}`)
      .expect(200);

    const ids = listRes.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(resA.body.clientId);
    expect(ids).not.toContain(resB.body.clientId);
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json agent-clients`
Expected: PASS (1 test)

- [ ] **Step 3: Commit**

```bash
git add test/agent-clients.e2e-spec.ts
git commit -m "test(e2e): add agent own-clients list scoping coverage"
```

---

### Task 13: e2e — admin toggle, list source/filter, analytics

**Files:**
- Modify: `test/admin-agents.e2e-spec.ts`
- Modify: `test/admin-client-review.e2e-spec.ts`

**Interfaces:**
- Consumes: `PATCH admin/agents/:id/onboarding-access` (Task 6), the extended `GET admin/clients`/`GET admin/clients/:id` (Task 7), `GET admin/clients/analytics` (Task 9).

- [ ] **Step 1: Extend `admin-agents.e2e-spec.ts`**

Add, right after the existing `'filters GET /admin/agents by status and searches by q'` test:

```typescript
  it("grants and revokes an agent's client-onboarding access, rejecting the grant for a non-APPROVED agent", async () => {
    const pendingAgent = await prisma.agent.findFirstOrThrow({ where: { email: 'wave3.agent2@test.com' } });
    await request(app.getHttpServer())
      .patch(`/admin/agents/${pendingAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(422);

    const approvedAgent = await prisma.agent.findFirstOrThrow({ where: { email: 'wave3.agent1@test.com' } });
    const grantRes = await request(app.getHttpServer())
      .patch(`/admin/agents/${approvedAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(200);
    expect(grantRes.body.canOnboardClients).toBe(true);

    const revokeRes = await request(app.getHttpServer())
      .patch(`/admin/agents/${approvedAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: false })
      .expect(200);
    expect(revokeRes.body.canOnboardClients).toBe(false);
  });

  it('returns 404 for an unknown agent id', async () => {
    await request(app.getHttpServer())
      .patch('/admin/agents/00000000-0000-0000-0000-000000000000/onboarding-access')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(404);
  });
```

- [ ] **Step 2: Extend `admin-client-review.e2e-spec.ts`**

Add, right after the existing `'gets the full client detail including onboarding'` test (and before `'retries: resets to IDENTITY_SUBMITTED...'`):

```typescript
  it('returns onboardingSource on the list and detail views', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ status: 'MANUAL_REVIEW' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    const row = listRes.body.data.find((c: { id: string }) => c.id === clientId);
    expect(row.onboardingSource).toBe('SELF');

    const detailRes = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(detailRes.body.onboardingSource).toBe('SELF');
  });

  it('filters the list by onboardingSource', async () => {
    const selfRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ onboardingSource: 'SELF' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(selfRes.body.data.some((c: { id: string }) => c.id === clientId)).toBe(true);

    const agentRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ onboardingSource: 'AGENT' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(agentRes.body.data.some((c: { id: string }) => c.id === clientId)).toBe(false);
  });

  it('returns an analytics summary with totals and breakdowns', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients/analytics')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.totalClients).toBeGreaterThanOrEqual(1);
    expect(res.body.bySource).toEqual(
      expect.objectContaining({
        SELF: expect.any(Number),
        AGENT: expect.any(Number),
        ADMIN: expect.any(Number),
        NONE: expect.any(Number),
      }),
    );
    expect(Object.keys(res.body.byOnboardingStep).sort()).toEqual(
      ['COMPLETED', 'DOCUMENTS_SUBMITTED', 'FACE_MATCH_PENDING', 'IDENTITY_SUBMITTED', 'IPPIS_LINKED', 'PHONE_VERIFIED'].sort(),
    );
    expect(Object.keys(res.body.byClientStatus).sort()).toEqual(
      ['MANUAL_REVIEW', 'PENDING_IPPIS', 'PHONE_VERIFIED', 'VERIFIED'].sort(),
    );
    expect(Array.isArray(res.body.agentLeaderboard)).toBe(true);
    expect(res.body.activity).toEqual(
      expect.objectContaining({
        clientsWithAtLeastOneLoanRequest: expect.any(Number),
        clientsWithAtLeastOneDisbursedLoan: expect.any(Number),
        clientsWithAtLeastOneSession: expect.any(Number),
        totalLoanRequests: expect.any(Number),
        totalWalletEntries: expect.any(Number),
      }),
    );
  });
```

- [ ] **Step 3: Run both specs to verify they pass**

Run: `npx jest --config ./test/jest-e2e.json admin-agents admin-client-review`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/admin-agents.e2e-spec.ts test/admin-client-review.e2e-spec.ts
git commit -m "test(e2e): cover the onboarding-access toggle, onboardingSource field/filter, and analytics"
```

---

### Task 14: Postman collection update

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

As with the Loan Product plan's Postman task, write a one-off Node script to a scratch location, run it once, then delete it — this collection is a single ~870KB JSON file and a script is the safe, repeatable way to make a precise, large edit to it.

- [ ] **Step 1: Write and run a migration script**

The script should:

1. Load the collection JSON.
2. Under the **Agent** top-level group, add a new "Client Onboarding" folder with 5 requests mirroring the existing Admin "Client Onboarding"-equivalent requests (find them by searching for `admin/clients/onboarding` in the current collection) but pointed at `agent/clients/onboarding/*`, using `{{agent_access_token}}`, plus one `403 Forbidden` example for an agent without `canOnboardClients` and one `409 Conflict` example for "already onboarded by someone else".
3. Under the **Agent** group, add a new "My Clients" folder with one `GET agent/clients` request (success example, paginated envelope).
4. Under the **Admin → Agents** folder, add a `PATCH admin/agents/:id/onboarding-access` request (success, `422` for non-APPROVED, `404`, `403` examples) — collect the agent id into a `{{agent_id}}` collection variable from the existing agent-list or agent-approve request if one already sets it, otherwise add a `pm.collectionVariables.set('agent_id', ...)` test script to whichever existing Agent request first returns one.
5. Under the **Admin → Clients** (or wherever the existing client list/analytics naturally sits), update the existing `GET /admin/clients - Success` example response to include `onboardingSource` on each row, add a `GET /admin/clients - Filtered by onboardingSource` request, and add a new `GET /admin/clients/analytics - Success` request with a full example response matching the `ClientAnalyticsSummary` shape from Task 9.

Follow the exact script structure and conventions used in `docs/superpowers/plans/2026-10-13-loan-product.md`'s own Postman task (Task 13 there) — same JSON.stringify-based item construction, same validation steps (valid JSON afterward, grep to confirm the new folders exist), same "delete the script before committing" cleanup. Author every example body/response from the actual DTOs/controllers/services built in Tasks 4-9 above, not guessed field names.

- [ ] **Step 2: Validate the result**

Run:
```bash
python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo "valid JSON"
```
Expected: `valid JSON` printed, no errors.

- [ ] **Step 3: Delete the one-off script, confirm it isn't tracked**

Run: `git status` — the script must not appear (it should live outside the repo, e.g. in your scratchpad directory, or be deleted if written inside the repo).

- [ ] **Step 4: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): add agent client-onboarding, agent my-clients, onboarding-access toggle, and analytics coverage"
```

**Important:** the `422`/`403`/`409` example bodies are best-effort reconstructions from the actual exception messages in the code (not captured from a live server). Before considering this task done, run the real requests against a running local server once and correct any example body that doesn't match the live response exactly — same caveat already flagged and followed up on for the Loan Product Postman task.

---

### Task 15: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS. Investigate anything outside this feature's touched files before proceeding.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Re-run any failing spec in isolation before treating it as a regression — this shared UAT database has known contention-based flakiness under full-suite concurrent load, confirmed multiple times this session to be unrelated to code correctness.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx eslint "{src,apps,libs,test}/**/*.ts"` (note: **without** `--fix` — the `npm run lint` script includes `--fix` and will reformat far more of the codebase than this feature touches; run eslint directly, read-only, instead)
Expected: no new errors beyond whatever pre-existing `@typescript-eslint/no-unused-vars` baseline already exists on this branch (confirm by checking whether any reported line is inside a file this plan touched).

- [ ] **Step 4: Confirm the app boots live**

Run: `npm run start:dev` against a reachable database, confirm clean startup (no `UnknownDependenciesException`), confirm the new routes resolve in the startup log (`AgentClientOnboardingController`, `AgentClientsController`, the new `PATCH admin/agents/:id/onboarding-access` and `GET admin/clients/analytics` routes), then stop it.

- [ ] **Step 5: Confirm no stray debug artifacts remain**

Run:
```bash
git status --short
```
Expected: clean (no leftover scratch scripts from Task 14).

- [ ] **Step 6: Clean up any e2e test rows left in the shared UAT database**

Confirm no stray rows were left behind by this plan's e2e specs (they should all self-clean in `afterAll`, but verify):

```typescript
// one-off check, run via ts-node, then delete
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const agents = await prisma.agent.findMany({ where: { email: { contains: '@example.com' } } });
  console.log('leftover e2e agent rows:', agents.map((a) => a.email));
  const ippis = await prisma.ippisRecord.findMany({ where: { staffId: { startsWith: 'E2E-AGENT' } } });
  console.log('leftover e2e ippisRecord rows:', ippis.map((i) => i.staffId));
  await prisma.$disconnect();
})();
```
Expected: both arrays empty. If anything is found, delete it.

- [ ] **Step 7: Final review pass**

Re-read `docs/superpowers/specs/2026-10-14-agent-client-onboarding-analytics-design.md` once more against the diff and confirm every numbered section (§1-§13) has a corresponding implemented piece. This plan's tasks map to the spec as: §2→Task 1, §3→Tasks 3/4, §4→Task 6, §5→Task 7, §6→Task 2, §7→Task 8, §8→Task 9, §9→Task 10, §10→(API surface recap, no dedicated task), §11→Tasks 11/12/13, §12→Task 14, §13→(intentionally not implemented).
