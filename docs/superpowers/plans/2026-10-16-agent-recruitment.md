# Agent Recruitment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-shot `POST /agents/register` with a multi-step recruitment flow — verify email by code, self-check NIN, resume anytime by re-verifying email, then submit a fuller application — plus admin-side reject emails and an analytics summary.

**Architecture:** A new `AgentApplication` draft model carries an applicant through email verification → NIN check → final submission, independent of the real `Agent` table. A short-lived JWT ("application token," its own secret, 45-min TTL) is issued once the email code is confirmed and gates every subsequent call, mirroring the existing 2FA-pending-token pattern. `src/agent-enrollment/` is deleted entirely and replaced by `src/agent-recruitment/`.

**Tech Stack:** NestJS, Prisma, class-validator DTOs, Jest unit tests, supertest e2e tests, the existing `FileStorageProvider`/`EmailService`/`IdentityVerificationService` abstractions.

**Spec:** `docs/superpowers/specs/2026-10-16-agent-recruitment-design.md`

## Global Constraints

- `src/agent-enrollment/` is deleted outright (controller, service, module, DTO) — no backward-compat shim for `POST /agents/register`.
- `Agent.supportingDocumentKeys` is **not** dropped from the schema (existing approved/rejected agents may have real uploaded files referenced there) — it's simply never written to by the new flow. Don't touch this field.
- NIN-name mismatches never block submission — informational only, per the approved spec.
- Every new endpoint gets a Postman example authored from the actual DTO/controller/service code, per this repo's `CLAUDE.md`.

---

### Task 1: Schema — `AgentApplication` model + `Agent` field additions

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `AgentApplication` model, `AgentApplicationStatus` enum, new `Agent` fields (`gender`, `city`, `state`, `localGovernment`, `nin`, `ninVerified`, `ninVerifiedName`, `coverLetter`, `passportPhotoKey`, `identityDocumentKey`) — consumed by Tasks 3, 6, 7.

- [ ] **Step 1: Add the new fields to `Agent`**

In `prisma/schema.prisma`, in the `Agent` model, change:

```prisma
  cvKey                  String
  supportingDocumentKeys String[]    @default([])
  mustChangePassword     Boolean     @default(true)
```

to:

```prisma
  cvKey                  String
  supportingDocumentKeys String[]    @default([])
  gender                 String?
  city                   String?
  state                  String?
  localGovernment        String?
  nin                    String?
  ninVerified            Boolean?
  ninVerifiedName        String?
  coverLetter            String?
  passportPhotoKey       String?
  identityDocumentKey    String?
  mustChangePassword     Boolean     @default(true)
```

Add the back-relation for the new `AgentApplication.submittedAgent` relation (Prisma requires both sides declared), right after `onboardedClients`:

```prisma
  onboardedClients       ClientOnboarding[]
  agentApplication       AgentApplication?
```

- [ ] **Step 2: Add the new model + enum**

Add, anywhere near the `Agent` model (e.g. right after its closing brace):

```prisma
enum AgentApplicationStatus {
  EMAIL_PENDING
  EMAIL_VERIFIED
  SUBMITTED
}

model AgentApplication {
  id                  String                 @id @default(uuid())
  email               String                 @unique
  status              AgentApplicationStatus @default(EMAIL_PENDING)
  emailCodeHash       String?
  emailCodeExpiresAt  DateTime?
  emailVerifiedAt     DateTime?
  fullName            String?
  phone               String?
  gender              String?
  address             String?
  city                String?
  state               String?
  localGovernment     String?
  nin                 String?
  ninVerified         Boolean?
  ninVerifiedName     String?
  coverLetter         String?
  cvKey               String?
  passportPhotoKey    String?
  identityDocumentKey String?
  submittedAgentId    String?                @unique
  submittedAgent      Agent?                 @relation(fields: [submittedAgentId], references: [id])
  createdAt           DateTime               @default(now())
  updatedAt           DateTime               @updatedAt
}
```

- [ ] **Step 3: Run the migration**

Run: `npx prisma migrate dev --name agent_recruitment`
Expected: non-destructive (every new field is nullable, the new model/enum are purely additive), completes cleanly.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add AgentApplication draft model and recruitment fields on Agent"
```

---

### Task 2: Application token — `TokenService`, env var, guard

**Files:**
- Modify: `src/auth/token.service.ts`
- Modify: `.env.example`
- Create: `src/auth/agent-application-token.guard.ts`
- Create: `src/auth/agent-application-token.guard.spec.ts`

**Interfaces:**
- Produces: `TokenService.signAgentApplicationToken(applicationId)`, `TokenService.verifyAgentApplicationToken(token)`, `AgentApplicationTokenGuard` — consumed by Tasks 3, 4.

- [ ] **Step 1: Add the token methods**

In `src/auth/token.service.ts`, add after `verifyTwoFactorPendingToken`:

```typescript
  signAgentApplicationToken(applicationId: string): string {
    return this.jwtService.sign(
      { sub: applicationId },
      {
        secret: this.configService.getOrThrow<string>('JWT_AGENT_APPLICATION_SECRET'),
        expiresIn: '45m',
      },
    );
  }

  verifyAgentApplicationToken(token: string): { sub: string } {
    return this.jwtService.verify(token, {
      secret: this.configService.getOrThrow<string>('JWT_AGENT_APPLICATION_SECRET'),
    });
  }
```

- [ ] **Step 2: Add the env var**

In `.env.example`, add near the other `JWT_*` entries:

```
JWT_AGENT_APPLICATION_SECRET=change-me-agent-application
```

- [ ] **Step 3: Write the guard**

```typescript
// src/auth/agent-application-token.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

interface ApplicationRequest {
  headers: Record<string, string | undefined>;
  applicationId?: string;
}

@Injectable()
export class AgentApplicationTokenGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ApplicationRequest>();
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing application token');
    }

    try {
      const payload = this.tokenService.verifyAgentApplicationToken(token);
      request.applicationId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired application token');
    }
  }
}
```

Note: unlike `AdminOnlyGuard`/`AgentOnlyGuard`/`ClientOnlyGuard` (which have no constructor dependencies and so don't need to be registered as a provider anywhere), this guard depends on `TokenService` — Task 4's module must list it in `providers` for Nest to resolve that dependency when `@UseGuards(AgentApplicationTokenGuard)` instantiates it.

- [ ] **Step 4: Write its spec**

```typescript
// src/auth/agent-application-token.guard.spec.ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AgentApplicationTokenGuard } from './agent-application-token.guard';
import { TokenService } from './token.service';

function contextWithAuthHeader(authorization: string | undefined) {
  const request: { headers: Record<string, string | undefined>; applicationId?: string } = {
    headers: { authorization },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('AgentApplicationTokenGuard', () => {
  let tokenService: { verifyAgentApplicationToken: jest.Mock };
  let guard: AgentApplicationTokenGuard;

  beforeEach(() => {
    tokenService = { verifyAgentApplicationToken: jest.fn() };
    guard = new AgentApplicationTokenGuard(tokenService as unknown as TokenService);
  });

  it('allows a valid token and attaches applicationId to the request', () => {
    tokenService.verifyAgentApplicationToken.mockReturnValue({ sub: 'application-1' });
    const { context, request } = contextWithAuthHeader('Bearer good-token');

    expect(guard.canActivate(context)).toBe(true);
    expect(request.applicationId).toBe('application-1');
  });

  it('rejects when no Authorization header is present', () => {
    const { context } = contextWithAuthHeader(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects when the token fails verification', () => {
    tokenService.verifyAgentApplicationToken.mockImplementation(() => {
      throw new Error('expired');
    });
    const { context } = contextWithAuthHeader('Bearer bad-token');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx jest src/auth/agent-application-token.guard.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/auth/token.service.ts .env.example src/auth/agent-application-token.guard.ts src/auth/agent-application-token.guard.spec.ts
git commit -m "feat(auth): add agent application token issuance/verification and its guard"
```

---

### Task 3: `AgentRecruitmentService`

**Files:**
- Create: `src/agent-recruitment/agent-recruitment.service.ts`
- Create: `src/agent-recruitment/agent-recruitment.service.spec.ts`

**Interfaces:**
- Consumes: `AgentApplication`/new `Agent` fields (Task 1), `TokenService.signAgentApplicationToken` (Task 2), existing `EmailService`, `IdentityVerificationService`, `FileStorageProvider`.
- Produces: `requestCode`, `confirmCode`, `verifyNin`, `getStatus`, `submit` — consumed by Task 4.

- [ ] **Step 1: Write the service**

```typescript
// src/agent-recruitment/agent-recruitment.service.ts
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TokenService } from '../auth/token.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { generateNumericCode } from '../common/generate-numeric-code.util';
import { hashToken } from '../common/opaque-token.util';
import { AgentApplicationStatus, AgentStatus } from '../generated/prisma/client';

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

export interface SubmitApplicationInput {
  fullName: string;
  phone: string;
  gender: string;
  address: string;
  city: string;
  state: string;
  localGovernment: string;
  nin: string;
  coverLetter: string;
}

export interface SubmitApplicationFiles {
  cv: Express.Multer.File;
  passportPhoto: Express.Multer.File;
  identityDocument?: Express.Multer.File;
}

@Injectable()
export class AgentRecruitmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly tokenService: TokenService,
    private readonly identityVerificationService: IdentityVerificationService,
    private readonly configService: ConfigService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

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
      subject: 'Your agent application verification code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
  }

  async confirmCode(email: string, code: string): Promise<{ applicationToken: string }> {
    const application = await this.prisma.agentApplication.findUnique({ where: { email } });
    if (
      !application ||
      !application.emailCodeHash ||
      !application.emailCodeExpiresAt ||
      application.emailCodeExpiresAt < new Date() ||
      application.emailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    if (application.status === AgentApplicationStatus.EMAIL_PENDING) {
      await this.prisma.agentApplication.update({
        where: { id: application.id },
        data: {
          status: AgentApplicationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: new Date(),
          emailCodeHash: null,
          emailCodeExpiresAt: null,
        },
      });
    } else {
      await this.prisma.agentApplication.update({
        where: { id: application.id },
        data: { emailCodeHash: null, emailCodeExpiresAt: null },
      });
    }

    return { applicationToken: this.tokenService.signAgentApplicationToken(application.id) };
  }

  async verifyNin(
    applicationId: string,
    nin: string,
  ): Promise<{ ninVerified: boolean; ninVerifiedName: string | null }> {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({ where: { id: applicationId } });
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('This application has already been submitted');
    }

    const result = await this.identityVerificationService.lookupNin(nin);
    const ninVerified = Boolean(result.firstName);
    const ninVerifiedName = ninVerified ? `${result.firstName} ${result.lastName}`.trim() : null;

    await this.prisma.agentApplication.update({
      where: { id: applicationId },
      data: { nin, ninVerified, ninVerifiedName },
    });

    return { ninVerified, ninVerifiedName };
  }

  async getStatus(applicationId: string) {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { submittedAgent: true },
    });

    if (application.status === AgentApplicationStatus.SUBMITTED && application.submittedAgent) {
      return {
        status: application.submittedAgent.status,
        reviewedAt: application.submittedAgent.reviewedAt,
        rejectionReason: application.submittedAgent.rejectionReason,
      };
    }

    return {
      status: application.status,
      fullName: application.fullName,
      phone: application.phone,
      gender: application.gender,
      address: application.address,
      city: application.city,
      state: application.state,
      localGovernment: application.localGovernment,
      nin: application.nin,
      ninVerified: application.ninVerified,
      ninVerifiedName: application.ninVerifiedName,
      coverLetter: application.coverLetter,
      hasCv: Boolean(application.cvKey),
      hasPassportPhoto: Boolean(application.passportPhotoKey),
      hasIdentityDocument: Boolean(application.identityDocumentKey),
    };
  }

  async submit(applicationId: string, input: SubmitApplicationInput, files: SubmitApplicationFiles) {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({ where: { id: applicationId } });
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('This application has already been submitted');
    }

    let ninVerified = application.ninVerified;
    let ninVerifiedName = application.ninVerifiedName;
    if (application.nin !== input.nin || application.ninVerified === null) {
      const result = await this.identityVerificationService.lookupNin(input.nin);
      ninVerified = Boolean(result.firstName);
      ninVerifiedName = ninVerified ? `${result.firstName} ${result.lastName}`.trim() : null;
    }

    const agent = await this.prisma.agent.create({
      data: {
        email: application.email,
        phone: input.phone,
        fullName: input.fullName,
        address: input.address,
        gender: input.gender,
        city: input.city,
        state: input.state,
        localGovernment: input.localGovernment,
        nin: input.nin,
        ninVerified,
        ninVerifiedName,
        coverLetter: input.coverLetter,
        cvKey: '',
        status: AgentStatus.PENDING_REVIEW,
      },
    });

    const cvKey = `agent-documents/${agent.id}/cv-${randomUUID()}${extname(files.cv.originalname)}`;
    await this.fileStorageProvider.putObject(cvKey, files.cv.buffer);

    const passportPhotoKey = `agent-documents/${agent.id}/passport-photo-${randomUUID()}${extname(files.passportPhoto.originalname)}`;
    await this.fileStorageProvider.putObject(passportPhotoKey, files.passportPhoto.buffer);

    let identityDocumentKey: string | undefined;
    if (files.identityDocument) {
      identityDocumentKey = `agent-documents/${agent.id}/identity-document-${randomUUID()}${extname(files.identityDocument.originalname)}`;
      await this.fileStorageProvider.putObject(identityDocumentKey, files.identityDocument.buffer);
    }

    const updatedAgent = await this.prisma.agent.update({
      where: { id: agent.id },
      data: { cvKey, passportPhotoKey, identityDocumentKey },
    });

    await this.prisma.agentApplication.update({
      where: { id: applicationId },
      data: {
        status: AgentApplicationStatus.SUBMITTED,
        submittedAgentId: agent.id,
        fullName: input.fullName,
        phone: input.phone,
        gender: input.gender,
        address: input.address,
        city: input.city,
        state: input.state,
        localGovernment: input.localGovernment,
        nin: input.nin,
        ninVerified,
        ninVerifiedName,
        coverLetter: input.coverLetter,
        cvKey,
        passportPhotoKey,
        identityDocumentKey,
      },
    });

    return {
      id: updatedAgent.id,
      email: updatedAgent.email,
      fullName: updatedAgent.fullName,
      status: updatedAgent.status,
      createdAt: updatedAgent.createdAt,
    };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/agent-recruitment/agent-recruitment.service.spec.ts
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TokenService } from '../auth/token.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { hashToken } from '../common/opaque-token.util';

describe('AgentRecruitmentService', () => {
  let service: AgentRecruitmentService;
  let prisma: {
    agent: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    agentApplication: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; upsert: jest.Mock; update: jest.Mock };
  };
  let emailService: { send: jest.Mock };
  let tokenService: { signAgentApplicationToken: jest.Mock };
  let identityVerificationService: { lookupNin: jest.Mock };
  let configService: { get: jest.Mock };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      agentApplication: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    tokenService = { signAgentApplicationToken: jest.fn().mockReturnValue('app-token') };
    identityVerificationService = { lookupNin: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(undefined) };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };

    service = new AgentRecruitmentService(
      prisma as unknown as PrismaService,
      emailService as unknown as EmailService,
      tokenService as unknown as TokenService,
      identityVerificationService as unknown as IdentityVerificationService,
      configService as unknown as ConfigService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('requestCode', () => {
    it('rejects when an Agent already exists with this email', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
      await expect(service.requestCode('taken@example.com')).rejects.toThrow(ConflictException);
      expect(prisma.agentApplication.upsert).not.toHaveBeenCalled();
    });

    it('upserts the draft and emails the code', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      prisma.agentApplication.upsert.mockResolvedValue({ id: 'app-1' });

      await service.requestCode('new@example.com');

      expect(prisma.agentApplication.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'new@example.com' },
          create: expect.objectContaining({ email: 'new@example.com' }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
    });
  });

  describe('confirmCode', () => {
    it('rejects when no draft exists for the email', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.confirmCode('x@example.com', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired code', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() - 1000),
        status: 'EMAIL_PENDING',
      });
      await expect(service.confirmCode('x@example.com', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong code', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_PENDING',
      });
      await expect(service.confirmCode('x@example.com', '000000')).rejects.toThrow(UnauthorizedException);
    });

    it('marks EMAIL_VERIFIED on first confirmation and issues a token', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_PENDING',
      });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.confirmCode('x@example.com', '123456');

      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: expect.objectContaining({ status: 'EMAIL_VERIFIED', emailCodeHash: null, emailCodeExpiresAt: null }),
      });
      expect(tokenService.signAgentApplicationToken).toHaveBeenCalledWith('app-1');
      expect(result).toEqual({ applicationToken: 'app-token' });
    });

    it('re-issues a token without resetting status when already EMAIL_VERIFIED', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_VERIFIED',
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.confirmCode('x@example.com', '123456');

      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { emailCodeHash: null, emailCodeExpiresAt: null },
      });
    });
  });

  describe('verifyNin', () => {
    it('rejects when the application has already been submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.verifyNin('app-1', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('stores and returns the verified name', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.verifyNin('app-1', '12345678901');

      expect(result).toEqual({ ninVerified: true, ninVerifiedName: 'Jane Doe' });
      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { nin: '12345678901', ninVerified: true, ninVerifiedName: 'Jane Doe' },
      });
    });

    it('returns ninVerified false without a name when the lookup finds nothing', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: '', lastName: '' });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.verifyNin('app-1', '00000000000');

      expect(result).toEqual({ ninVerified: false, ninVerifiedName: null });
    });
  });

  describe('getStatus', () => {
    it('returns the draft fields when not yet submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        status: 'EMAIL_VERIFIED',
        fullName: 'Jane Doe',
        phone: '+2348000000000',
        gender: 'Female',
        address: '1 St',
        city: 'Lagos',
        state: 'Lagos',
        localGovernment: 'Ikeja',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
        coverLetter: 'Hello',
        cvKey: 'agent-documents/x/cv.pdf',
        passportPhotoKey: null,
        identityDocumentKey: null,
        submittedAgent: null,
      });

      const result = await service.getStatus('app-1');

      expect(result).toEqual(
        expect.objectContaining({
          status: 'EMAIL_VERIFIED',
          hasCv: true,
          hasPassportPhoto: false,
          hasIdentityDocument: false,
        }),
      );
    });

    it('returns the real Agent status once submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        status: 'SUBMITTED',
        submittedAgent: { status: 'PENDING_REVIEW', reviewedAt: null, rejectionReason: null },
      });

      const result = await service.getStatus('app-1');

      expect(result).toEqual({ status: 'PENDING_REVIEW', reviewedAt: null, rejectionReason: null });
    });
  });

  describe('submit', () => {
    const input = {
      fullName: 'Jane Doe',
      phone: '+2348000000000',
      gender: 'Female',
      address: '1 St',
      city: 'Lagos',
      state: 'Lagos',
      localGovernment: 'Ikeja',
      nin: '12345678901',
      coverLetter: 'Hello',
    };
    const files = {
      cv: { originalname: 'cv.pdf', buffer: Buffer.from('cv') } as Express.Multer.File,
      passportPhoto: { originalname: 'photo.jpg', buffer: Buffer.from('photo') } as Express.Multer.File,
    };

    it('rejects when the application has already been submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.submit('app-1', input, files)).rejects.toThrow(ConflictException);
    });

    it('auto-verifies NIN when not already verified, then creates the Agent and uploads files', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: null,
        ninVerified: null,
        ninVerifiedName: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.submit('app-1', input, files);

      expect(identityVerificationService.lookupNin).toHaveBeenCalledWith('12345678901');
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'jane@example.com', ninVerified: true }) }),
      );
      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
      expect(prisma.agentApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: expect.objectContaining({ status: 'SUBMITTED', submittedAgentId: 'agent-1' }),
        }),
      );
      expect(result).toEqual({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
    });

    it('skips re-verifying NIN when already verified for this exact value', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
      });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.submit('app-1', input, files);

      expect(identityVerificationService.lookupNin).not.toHaveBeenCalled();
    });

    it('uploads an optional identity document when provided', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
      });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.submit('app-1', input, {
        ...files,
        identityDocument: { originalname: 'id.pdf', buffer: Buffer.from('id') } as Express.Multer.File,
      });

      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(3);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/agent-recruitment/agent-recruitment.service.spec.ts`
Expected: PASS (13 tests)

- [ ] **Step 4: Commit**

```bash
git add src/agent-recruitment/agent-recruitment.service.ts src/agent-recruitment/agent-recruitment.service.spec.ts
git commit -m "feat(agent-recruitment): add AgentRecruitmentService"
```

---

### Task 4: Controller, DTOs, module

**Files:**
- Create: `src/agent-recruitment/dto/request-recruitment-code.dto.ts`
- Create: `src/agent-recruitment/dto/confirm-recruitment-code.dto.ts`
- Create: `src/agent-recruitment/dto/verify-recruitment-nin.dto.ts`
- Create: `src/agent-recruitment/dto/submit-recruitment-application.dto.ts`
- Create: `src/agent-recruitment/agent-recruitment.controller.ts`
- Create: `src/agent-recruitment/agent-recruitment.module.ts`

**Interfaces:**
- Consumes: `AgentRecruitmentService` (Task 3), `AgentApplicationTokenGuard` (Task 2).
- Produces: the 5 public routes under `agents/recruitment/*`.

- [ ] **Step 1: Write the DTOs**

```typescript
// src/agent-recruitment/dto/request-recruitment-code.dto.ts
import { IsEmail } from 'class-validator';

export class RequestRecruitmentCodeDto {
  @IsEmail()
  email: string;
}
```

```typescript
// src/agent-recruitment/dto/confirm-recruitment-code.dto.ts
import { IsEmail, IsString, Length } from 'class-validator';

export class ConfirmRecruitmentCodeDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 8)
  code: string;
}
```

```typescript
// src/agent-recruitment/dto/verify-recruitment-nin.dto.ts
import { IsString, Length } from 'class-validator';

export class VerifyRecruitmentNinDto {
  @IsString()
  @Length(11, 11)
  nin: string;
}
```

```typescript
// src/agent-recruitment/dto/submit-recruitment-application.dto.ts
import { IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';

export class SubmitRecruitmentApplicationDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsPhoneNumber()
  phone: string;

  @IsString()
  @MinLength(1)
  gender: string;

  @IsString()
  @MinLength(1)
  address: string;

  @IsString()
  @MinLength(1)
  city: string;

  @IsString()
  @MinLength(1)
  state: string;

  @IsString()
  @MinLength(1)
  localGovernment: string;

  @IsString()
  @Length(11, 11)
  nin: string;

  @IsString()
  @MinLength(1)
  coverLetter: string;
}
```

- [ ] **Step 2: Write the controller**

```typescript
// src/agent-recruitment/agent-recruitment.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AgentApplicationTokenGuard } from '../auth/agent-application-token.guard';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { RequestRecruitmentCodeDto } from './dto/request-recruitment-code.dto';
import { ConfirmRecruitmentCodeDto } from './dto/confirm-recruitment-code.dto';
import { VerifyRecruitmentNinDto } from './dto/verify-recruitment-nin.dto';
import { SubmitRecruitmentApplicationDto } from './dto/submit-recruitment-application.dto';

interface ApplicationRequest {
  applicationId: string;
}

@Controller('agents/recruitment')
export class AgentRecruitmentController {
  constructor(private readonly agentRecruitmentService: AgentRecruitmentService) {}

  @Post('email/request-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async requestCode(@Body() dto: RequestRecruitmentCodeDto) {
    await this.agentRecruitmentService.requestCode(dto.email);
    return { sent: true };
  }

  @Post('email/confirm-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  confirmCode(@Body() dto: ConfirmRecruitmentCodeDto) {
    return this.agentRecruitmentService.confirmCode(dto.email, dto.code);
  }

  @Get('status')
  @UseGuards(AgentApplicationTokenGuard)
  getStatus(@Req() req: ApplicationRequest) {
    return this.agentRecruitmentService.getStatus(req.applicationId);
  }

  @Post('nin/verify')
  @HttpCode(200)
  @UseGuards(AgentApplicationTokenGuard)
  verifyNin(@Body() dto: VerifyRecruitmentNinDto, @Req() req: ApplicationRequest) {
    return this.agentRecruitmentService.verifyNin(req.applicationId, dto.nin);
  }

  @Post('submit')
  @UseGuards(AgentApplicationTokenGuard)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cv', maxCount: 1 },
      { name: 'passportPhoto', maxCount: 1 },
      { name: 'identityDocument', maxCount: 1 },
    ]),
  )
  submit(
    @Body() dto: SubmitRecruitmentApplicationDto,
    @UploadedFiles()
    files: {
      cv?: Express.Multer.File[];
      passportPhoto?: Express.Multer.File[];
      identityDocument?: Express.Multer.File[];
    },
    @Req() req: ApplicationRequest,
  ) {
    const cv = files.cv?.[0];
    const passportPhoto = files.passportPhoto?.[0];
    if (!cv) {
      throw new BadRequestException('cv is required');
    }
    if (!passportPhoto) {
      throw new BadRequestException('passportPhoto is required');
    }
    return this.agentRecruitmentService.submit(req.applicationId, dto, {
      cv,
      passportPhoto,
      identityDocument: files.identityDocument?.[0],
    });
  }
}
```

- [ ] **Step 3: Write the module**

```typescript
// src/agent-recruitment/agent-recruitment.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AgentRecruitmentController } from './agent-recruitment.controller';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { AgentApplicationTokenGuard } from '../auth/agent-application-token.guard';

@Module({
  imports: [AuthModule, EmailModule, IdentityVerificationModule, FileStorageModule],
  controllers: [AgentRecruitmentController],
  providers: [AgentRecruitmentService, AgentApplicationTokenGuard],
})
export class AgentRecruitmentModule {}
```

- [ ] **Step 4: Verify the app compiles**

Run: `npx nest build`
Expected: no errors (the app won't fully boot yet — `AgentRecruitmentModule` isn't wired into `AppModule` until Task 5 — but `nest build` only needs the TypeScript to compile, which it should).

- [ ] **Step 5: Commit**

```bash
git add src/agent-recruitment/dto src/agent-recruitment/agent-recruitment.controller.ts src/agent-recruitment/agent-recruitment.module.ts
git commit -m "feat(agent-recruitment): add controller, DTOs, and module"
```

---

### Task 5: Delete `agent-enrollment`, wire `AgentRecruitmentModule`

**Files:**
- Delete: `src/agent-enrollment/` (entire directory)
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `AgentRecruitmentModule` (Task 4).

- [ ] **Step 1: Delete the old module**

```bash
rm -rf src/agent-enrollment
```

- [ ] **Step 2: Rewire `AppModule`**

In `src/app.module.ts`, change:

```typescript
import { AgentEnrollmentModule } from './agent-enrollment/agent-enrollment.module';
```

to:

```typescript
import { AgentRecruitmentModule } from './agent-recruitment/agent-recruitment.module';
```

and in the `imports` array, change:

```typescript
    AgentEnrollmentModule,
```

to:

```typescript
    AgentRecruitmentModule,
```

- [ ] **Step 3: Verify the app compiles and boots**

Run: `npx nest build`
Expected: no errors. If a database is reachable, also run `npm run start:dev` briefly, confirm clean startup with the 5 new `agents/recruitment/*` routes logged and no references to the deleted module, then stop it.

- [ ] **Step 4: Commit**

```bash
git add -A src/agent-enrollment src/app.module.ts
git commit -m "feat: replace agent-enrollment with agent-recruitment"
```

---

### Task 6: Admin reject sends an email

**Files:**
- Modify: `src/admin-agent-review/admin-agent-review.service.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.spec.ts`

**Interfaces:**
- Produces: `reject()` now emails the applicant — no interface change (same signature).

- [ ] **Step 1: Update `reject()`**

In `src/admin-agent-review/admin-agent-review.service.ts`, change:

```typescript
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
```

to:

```typescript
  async reject(id: string, reviewerId: string, reason: string): Promise<void> {
    const agent = await this.loadPendingReview(id);

    await this.prisma.agent.update({
      where: { id },
      data: {
        status: AgentStatus.REJECTED,
        rejectionReason: reason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });

    await this.emailService.send({
      to: agent.email,
      subject: 'Your agent application was not approved',
      html: `<p>Your application was not approved.</p><p>Reason: ${reason}</p>`,
      text: `Your application was not approved.\nReason: ${reason}`,
    });
  }
```

- [ ] **Step 2: Update the spec**

In `src/admin-agent-review/admin-agent-review.service.spec.ts`, inside `describe('reject', ...)`, change:

```typescript
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
```

to:

```typescript
    it('sets REJECTED with the reason and reviewer, and emails the agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
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
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@example.com', text: expect.stringContaining('Incomplete CV') }),
      );
    });
```

- [ ] **Step 3: Run the spec to verify it passes**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS (all existing tests plus the updated one)

- [ ] **Step 4: Commit**

```bash
git add src/admin-agent-review/admin-agent-review.service.ts src/admin-agent-review/admin-agent-review.service.spec.ts
git commit -m "feat(admin-agent-review): send a rejection email on reject"
```

---

### Task 7: Admin agent analytics

**Files:**
- Create: `src/admin-agent-review/admin-agent-analytics.service.ts`
- Create: `src/admin-agent-review/admin-agent-analytics.service.spec.ts`
- Create: `src/admin-agent-review/dto/agent-analytics-query.dto.ts`
- Modify: `src/admin-agent-review/admin-agent-review.controller.ts`
- Modify: `src/admin-agent-review/admin-agent-review.module.ts`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: `GET admin/agents/analytics`, permission `agents:analytics:read`.

- [ ] **Step 1: Write the service**

```typescript
// src/admin-agent-review/admin-agent-analytics.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentStatus, Prisma } from '../generated/prisma/client';

export interface AgentAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface AgentAnalyticsSummary {
  totalApplications: number;
  byStatus: Record<AgentStatus, number>;
  reviewerLeaderboard: Array<{ adminId: string; adminName: string; approvedCount: number; rejectedCount: number }>;
  activity: { averageReviewTimeHours: number | null; totalApproved: number; totalRejected: number };
}

@Injectable()
export class AdminAgentAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(filters: AgentAnalyticsFilters = {}): Promise<AgentAnalyticsSummary> {
    const agentWhere: Prisma.AgentWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [totalApplications, statusGroups, reviewerLeaderboard, activity] = await Promise.all([
      this.prisma.agent.count({ where: agentWhere }),
      this.prisma.agent.groupBy({ by: ['status'], where: agentWhere, _count: { _all: true } }),
      this.buildReviewerLeaderboard(agentWhere),
      this.buildActivity(agentWhere),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(AgentStatus).map((status) => [
        status,
        statusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<AgentStatus, number>;

    return { totalApplications, byStatus, reviewerLeaderboard, activity };
  }

  private async buildReviewerLeaderboard(agentWhere: Prisma.AgentWhereInput) {
    const grouped = await this.prisma.agent.groupBy({
      by: ['reviewedBy'],
      where: { ...agentWhere, reviewedBy: { not: null } },
      _count: { _all: true },
    });

    const results = await Promise.all(
      grouped.map(async (group) => {
        const adminId = group.reviewedBy!;
        const [admin, approvedCount, rejectedCount] = await Promise.all([
          this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { fullName: true } }),
          this.prisma.agent.count({ where: { ...agentWhere, reviewedBy: adminId, status: AgentStatus.APPROVED } }),
          this.prisma.agent.count({ where: { ...agentWhere, reviewedBy: adminId, status: AgentStatus.REJECTED } }),
        ]);
        return {
          adminId,
          adminName: admin?.fullName ?? 'Unknown admin',
          approvedCount,
          rejectedCount,
        };
      }),
    );

    return results.sort((a, b) => b.approvedCount + b.rejectedCount - (a.approvedCount + a.rejectedCount));
  }

  private async buildActivity(agentWhere: Prisma.AgentWhereInput) {
    const [totalApproved, totalRejected, reviewedAgents] = await Promise.all([
      this.prisma.agent.count({ where: { ...agentWhere, status: AgentStatus.APPROVED } }),
      this.prisma.agent.count({ where: { ...agentWhere, status: AgentStatus.REJECTED } }),
      this.prisma.agent.findMany({
        where: { ...agentWhere, reviewedAt: { not: null } },
        select: { createdAt: true, reviewedAt: true },
      }),
    ]);

    const averageReviewTimeHours =
      reviewedAgents.length === 0
        ? null
        : reviewedAgents.reduce((sum, a) => sum + (a.reviewedAt!.getTime() - a.createdAt.getTime()), 0) /
          reviewedAgents.length /
          (1000 * 60 * 60);

    return { averageReviewTimeHours, totalApproved, totalRejected };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/admin-agent-review/admin-agent-analytics.service.spec.ts
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminAgentAnalyticsService', () => {
  let service: AdminAgentAnalyticsService;
  let prisma: {
    agent: { count: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
    adminUser: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      agent: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      adminUser: { findUnique: jest.fn() },
    };
    service = new AdminAgentAnalyticsService(prisma as unknown as PrismaService);
  });

  it('fills every AgentStatus key even when groupBy returns no rows for them', async () => {
    const result = await service.getSummary();
    expect(Object.keys(result.byStatus).sort()).toEqual(['APPROVED', 'PENDING_REVIEW', 'REJECTED'].sort());
    expect(Object.values(result.byStatus).every((v) => v === 0)).toBe(true);
  });

  it('maps groupBy counts onto the right status keys', async () => {
    prisma.agent.groupBy.mockResolvedValue([{ status: 'APPROVED', _count: { _all: 5 } }]);
    const result = await service.getSummary();
    expect(result.byStatus.APPROVED).toBe(5);
  });

  it('builds a sorted reviewer leaderboard', async () => {
    prisma.agent.groupBy.mockResolvedValue([
      { reviewedBy: 'admin-1', _count: { _all: 3 } },
      { reviewedBy: 'admin-2', _count: { _all: 10 } },
    ]);
    prisma.adminUser.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ fullName: where.id === 'admin-1' ? 'Admin One' : 'Admin Two' }),
    );
    prisma.agent.count.mockImplementation(({ where }: { where: { status?: string; reviewedBy?: string } }) => {
      if (where.reviewedBy === 'admin-2') return Promise.resolve(where.status === 'APPROVED' ? 10 : 0);
      if (where.reviewedBy === 'admin-1') return Promise.resolve(where.status === 'APPROVED' ? 1 : 2);
      return Promise.resolve(0);
    });

    const result = await service.getSummary();

    expect(result.reviewerLeaderboard[0]).toEqual({
      adminId: 'admin-2',
      adminName: 'Admin Two',
      approvedCount: 10,
      rejectedCount: 0,
    });
  });

  it('returns a null averageReviewTimeHours when nothing has been reviewed yet', async () => {
    prisma.agent.findMany.mockResolvedValue([]);
    const result = await service.getSummary();
    expect(result.activity.averageReviewTimeHours).toBeNull();
  });

  it('computes the average review time in hours across reviewed agents', async () => {
    prisma.agent.findMany.mockResolvedValue([
      { createdAt: new Date('2026-01-01T00:00:00Z'), reviewedAt: new Date('2026-01-01T02:00:00Z') },
      { createdAt: new Date('2026-01-01T00:00:00Z'), reviewedAt: new Date('2026-01-01T04:00:00Z') },
    ]);
    const result = await service.getSummary();
    expect(result.activity.averageReviewTimeHours).toBe(3);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/admin-agent-review/admin-agent-analytics.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Write the query DTO**

```typescript
// src/admin-agent-review/dto/agent-analytics-query.dto.ts
import { IsISO8601, IsOptional } from 'class-validator';

export class AgentAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Wire the controller route**

In `src/admin-agent-review/admin-agent-review.controller.ts`, add the imports:

```typescript
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
import { AgentAnalyticsQueryDto } from './dto/agent-analytics-query.dto';
```

Add it to the constructor:

```typescript
  constructor(
    private readonly adminAgentReviewService: AdminAgentReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly adminAgentAnalyticsService: AdminAgentAnalyticsService,
  ) {}
```

**Route ordering matters**: add the new route between `list()` and `findById(':id')` — a literal path segment must be registered before a param route, or NestJS matches `/admin/agents/analytics` as `findById('analytics')` instead (same issue already handled for `GET admin/clients/analytics`):

```typescript
  @Get('analytics')
  @RequirePermissions('agents:analytics:read')
  getAnalytics(@Query() query: AgentAnalyticsQueryDto) {
    return this.adminAgentAnalyticsService.getSummary({
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('agents:read')
  findById(@Param('id') id: string) {
    return this.adminAgentReviewService.findById(id);
  }
```

- [ ] **Step 6: Register the service in the module**

In `src/admin-agent-review/admin-agent-review.module.ts`, add the import:

```typescript
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
```

and add it to `providers`:

```typescript
  providers: [AdminAgentReviewService, AdminAgentAnalyticsService],
```

- [ ] **Step 7: Seed the permission**

In `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS` array, add:

```typescript
  { key: 'agents:analytics:read', description: 'View aggregate agent-application analytics' },
```

Run: `npx prisma db seed` to verify it runs cleanly.

- [ ] **Step 8: Verify the app compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/admin-agent-review/admin-agent-analytics.service.ts src/admin-agent-review/admin-agent-analytics.service.spec.ts src/admin-agent-review/dto/agent-analytics-query.dto.ts src/admin-agent-review/admin-agent-review.controller.ts src/admin-agent-review/admin-agent-review.module.ts prisma/seed.ts
git commit -m "feat(admin-agent-review): add GET admin/agents/analytics summary endpoint"
```

---

### Task 8: e2e tests

**Files:**
- Delete: `test/agent-enrollment.e2e-spec.ts`
- Create: `test/agent-recruitment.e2e-spec.ts`

**Interfaces:**
- Consumes: all routes from Tasks 3-7 — requires the full app wired (Task 5).

- [ ] **Step 1: Delete the old spec**

```bash
rm test/agent-enrollment.e2e-spec.ts
```

- [ ] **Step 2: Write the new spec**

```typescript
// test/agent-recruitment.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent recruitment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capturedEmails: EmailMessage[];
  let adminAccessToken: string;
  const createdAgentIds: string[] = [];
  const createdApplicationEmails: string[] = [];

  function latestCodeFor(email: string): string {
    const match = [...capturedEmails]
      .reverse()
      .find((m) => m.to === email && /verification code is: (\d+)/.test(m.text ?? ''));
    const codeMatch = match?.text?.match(/verification code is: (\d+)/);
    if (!codeMatch) {
      throw new Error(`No verification code email found for ${email}`);
    }
    return codeMatch[1];
  }

  beforeAll(async () => {
    capturedEmails = [];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmails.push(message);
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
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await prisma.agentApplication.deleteMany({ where: { email: { in: createdApplicationEmails } } });
    await app.close();
  });

  it(
    'runs the full recruitment journey: request code -> confirm -> NIN verify -> submit -> appears in admin list',
    async () => {
      const email = `e2e-recruit-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer())
        .post('/agents/recruitment/email/request-code')
        .send({ email })
        .expect(200)
        .expect({ sent: true });

      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);
      const applicationToken = confirmRes.body.applicationToken;
      expect(typeof applicationToken).toBe('string');

      const ninRes = await request(app.getHttpServer())
        .post('/agents/recruitment/nin/verify')
        .set('Authorization', `Bearer ${applicationToken}`)
        .send({ nin: '12345678901' })
        .expect(200);
      expect(ninRes.body.ninVerified).toBe(true);
      expect(typeof ninRes.body.ninVerifiedName).toBe('string');

      const statusRes = await request(app.getHttpServer())
        .get('/agents/recruitment/status')
        .set('Authorization', `Bearer ${applicationToken}`)
        .expect(200);
      expect(statusRes.body.status).toBe('EMAIL_VERIFIED');
      expect(statusRes.body.ninVerified).toBe(true);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${applicationToken}`)
        .field('fullName', 'E2E Recruit')
        .field('phone', '+2348012345678')
        .field('gender', 'Female')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'I would like to join as an agent.')
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
        .expect(201);
      expect(submitRes.body.status).toBe('PENDING_REVIEW');
      const agentId = submitRes.body.id;
      createdAgentIds.push(agentId);

      const listRes = await request(app.getHttpServer())
        .get('/admin/agents')
        .query({ q: 'E2E Recruit' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(listRes.body.data.some((a: { id: string }) => a.id === agentId)).toBe(true);
    },
    20000,
  );

  it('resumes after re-requesting a code, losing nothing already filled in', async () => {
    const email = `e2e-resume-${Date.now()}@example.com`;
    createdApplicationEmails.push(email);

    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const firstCode = latestCodeFor(email);
    const firstConfirm = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code: firstCode })
      .expect(200);

    await request(app.getHttpServer())
      .post('/agents/recruitment/nin/verify')
      .set('Authorization', `Bearer ${firstConfirm.body.applicationToken}`)
      .send({ nin: '12345678901' })
      .expect(200);

    // Simulate coming back later: request a fresh code for the same email.
    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const secondCode = latestCodeFor(email);
    const secondConfirm = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code: secondCode })
      .expect(200);

    const statusRes = await request(app.getHttpServer())
      .get('/agents/recruitment/status')
      .set('Authorization', `Bearer ${secondConfirm.body.applicationToken}`)
      .expect(200);
    expect(statusRes.body.ninVerified).toBe(true);
    expect(statusRes.body.status).toBe('EMAIL_VERIFIED');
  });

  it(
    'rejects requesting a code for an email that already has an Agent application',
    async () => {
      const email = `e2e-duplicate-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${confirmRes.body.applicationToken}`)
        .field('fullName', 'E2E Duplicate')
        .field('phone', '+2348012345679')
        .field('gender', 'Male')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
        .expect(201);
      createdAgentIds.push(submitRes.body.id);

      await request(app.getHttpServer())
        .post('/agents/recruitment/email/request-code')
        .send({ email })
        .expect(409);
    },
    20000,
  );

  it(
    'admin rejection emails the applicant with the reason',
    async () => {
      const email = `e2e-reject-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);

      await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
      const code = latestCodeFor(email);
      const confirmRes = await request(app.getHttpServer())
        .post('/agents/recruitment/email/confirm-code')
        .send({ email, code })
        .expect(200);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${confirmRes.body.applicationToken}`)
        .field('fullName', 'E2E Reject')
        .field('phone', '+2348012345680')
        .field('gender', 'Female')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
        .expect(201);
      const agentId = submitRes.body.id;
      createdAgentIds.push(agentId);

      await request(app.getHttpServer())
        .post(`/admin/agents/${agentId}/reject`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Incomplete documentation' })
        .expect(200)
        .expect({ rejected: true });

      const rejectionEmail = [...capturedEmails]
        .reverse()
        .find((m) => m.to === email && /not approved/.test(m.subject ?? ''));
      expect(rejectionEmail).toBeDefined();
      expect(rejectionEmail?.text).toContain('Incomplete documentation');
    },
    20000,
  );

  it('returns an analytics summary with totals and breakdowns', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents/analytics')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.totalApplications).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus).toEqual(
      expect.objectContaining({
        PENDING_REVIEW: expect.any(Number),
        APPROVED: expect.any(Number),
        REJECTED: expect.any(Number),
      }),
    );
    expect(Array.isArray(res.body.reviewerLeaderboard)).toBe(true);
    expect(res.body.activity).toEqual(
      expect.objectContaining({ totalApproved: expect.any(Number), totalRejected: expect.any(Number) }),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json agent-recruitment`
Expected: PASS (5 tests). Per established project practice, re-run in isolation before treating any failure as a real regression — this is a shared UAT database with known DB-contention flakiness under concurrent load.

- [ ] **Step 4: Commit**

```bash
git add -A test/agent-enrollment.e2e-spec.ts test/agent-recruitment.e2e-spec.ts
git commit -m "test(e2e): replace agent-enrollment spec with agent-recruitment"
```

---

### Task 9: Postman collection update

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all routes from Tasks 3-7.

Write a one-off Node script to a scratch location outside the repo, run it once, then delete it — same safe, repeatable pattern used for every prior Postman task this session.

- [ ] **Step 1: Write and run the migration script**

The script should:

1. Load the collection JSON.
2. Find the `Agent → Enrollment` folder. Rename it to `Agent → Recruitment`. Remove its 3 existing `POST /agents/register - *` items. Add 5 new item groups in their place (success + meaningful failure scenarios each, read from the actual landed DTOs/controller/service before writing bodies):
   - `POST /agents/recruitment/email/request-code` — success (200), duplicate-email (409).
   - `POST /agents/recruitment/email/confirm-code` — success (200, returns `applicationToken`), invalid/expired code (401).
   - `GET /agents/recruitment/status` — success (200, with `Authorization: Bearer {{agent_application_token}}`), missing token (401). Add a test script on the confirm-code success response setting `pm.collectionVariables.set('agent_application_token', json.applicationToken)`.
   - `POST /agents/recruitment/nin/verify` — success (200).
   - `POST /agents/recruitment/submit` — success (201, multipart form-data with `cv`/`passportPhoto`/`identityDocument` file fields), missing cv (400).
   Leave the folder's existing `POST /auth/agent/forgot-password`/`reset-password`/`reset-password/code`/`change-password` items untouched.
3. Under `Admin → Review`, add `GET /admin/agents/analytics - Success` (full example matching `AgentAnalyticsSummary`) and update the `POST /admin/agents/:id/reject - Success` request's description to note it now also sends the applicant a rejection email.

- [ ] **Step 2: Validate the result**

Run:
```bash
python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo "valid JSON"
```

- [ ] **Step 3: Delete the one-off script, confirm it isn't tracked**

Run: `git status` — the script must not appear.

- [ ] **Step 4: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): replace agent-enrollment with agent-recruitment, add agent analytics"
```

---

### Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Re-run any failing spec in isolation before treating it as a regression (known pre-existing DB-contention flakiness under full-suite concurrent load).

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint "{src,apps,libs,test}/**/*.ts"` (note: **without** `--fix`) — expect no new errors beyond the established pre-existing `@typescript-eslint/no-unused-vars` baseline.

- [ ] **Step 4: Confirm the app boots live**

Run `npm run start:dev` against a reachable database, confirm clean startup and that all 6 new routes (`agents/recruitment/email/request-code`, `.../email/confirm-code`, `.../status`, `.../nin/verify`, `.../submit`, `admin/agents/analytics`) resolve in the startup log, then stop it.

- [ ] **Step 5: Confirm no stray debug artifacts remain**

Run: `git status --short` — expect clean.
