# Optional Client Email (OTP + Notification CC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Note for this repo:** neither sub-skill is installed here — replicate the pattern manually: one fresh Agent-tool call per task, review its diff before starting the next task, run only the touched file's tests per task (full suite at the end of this plan, not per-task).

**Goal:** Let a client optionally attach a permanent, unique email to their account at login time, so it receives a copy of every OTP and every other client-facing SMS notification this app sends.

**Architecture:** `Client.email`/`OtpCode.email` (both nullable, the former unique) carry the value from `ClientAuthService.requestOtp` through `OtpService.request`/`verify` to `ClientAuthService.verifyOtp`'s upsert. `OtpService` and `LoanRequestService` each gain an optional `EmailService` injection and send a best-effort, logged-not-thrown email copy alongside their existing SMS sends.

**Tech Stack:** NestJS, Prisma (PostgreSQL), Jest.

**Spec:** `docs/superpowers/specs/2026-10-13-client-email-otp-cc-design.md`

## Global Constraints

- Email is **permanent once set** — a client who already has one keeps it; any newly-supplied value on a later request is silently ignored.
- Email delivery is **best-effort everywhere** — a failed email send is caught, logged, and never fails the surrounding request (phone/SMS remains the only hard-required channel).
- Reuse the existing `isUniqueConstraintError` helper (`src/common/is-unique-constraint-error.util.ts`) for the P2002 safety net — don't write a new one.
- Run only the current task's touched-file tests per task; full suite only at the end (Task 6).
- Never add a `Co-Authored-By: Claude` trailer to commits (this repo's standing rule).

---

### Task 1: Schema — `Client.email` and `OtpCode.email`

**Files:**
- Modify: `prisma/schema.prisma` (`Client` model, `OtpCode` model)

**Interfaces:**
- Produces: `Client.email: string | null` (unique), `OtpCode.email: string | null` — consumed by every later task.

- [ ] **Step 1: Add `email` to `Client`**

In `prisma/schema.prisma`, find:

```prisma
model Client {
  id        String       @id @default(uuid())
  phone     String       @unique
  status    ClientStatus @default(PHONE_VERIFIED)
  createdById String?
```

Replace with:

```prisma
model Client {
  id        String       @id @default(uuid())
  phone     String       @unique
  email     String?      @unique
  status    ClientStatus @default(PHONE_VERIFIED)
  createdById String?
```

- [ ] **Step 2: Add `email` to `OtpCode`**

In `prisma/schema.prisma`, find:

```prisma
model OtpCode {
  id         String     @id @default(uuid())
  phone      String
  codeHash   String
```

Replace with:

```prisma
model OtpCode {
  id         String     @id @default(uuid())
  phone      String
  email      String?
  codeHash   String
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npx prisma migrate dev --name client_and_otp_email`
Expected: succeeds, creates a new migration folder adding two nullable columns (one with a unique constraint on `Client`) — no backfill needed.

- [ ] **Step 4: Verify**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add nullable email to Client and OtpCode"
```

---

### Task 2: `OtpService` — store and email-CC the code

**Files:**
- Modify: `src/otp/otp.service.ts`
- Modify: `src/otp/otp.module.ts`
- Test: `src/otp/otp.service.spec.ts`

**Interfaces:**
- Consumes: `EmailService.send(message: EmailMessage): Promise<void>` (pre-existing, `src/email/email.service.ts`).
- Produces: `OtpService.request(phone: string, email?: string): Promise<{ mockCode?: string }>` (email param added, stores it, best-effort emails the code). `OtpService.verify(phone: string, code: string): Promise<{ valid: boolean; email?: string | null }>` (return type changed from `boolean`) — consumed by Task 3.

- [ ] **Step 1: Extend the mock shape and fix existing assertions for `verify`'s new return type**

In `src/otp/otp.service.spec.ts`, find:

```typescript
import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpProvider } from './otp-provider.interface';
import { hashPassword } from '../common/password-hash.util';
```

Replace with:

```typescript
import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpProvider } from './otp-provider.interface';
import { EmailService } from '../email/email.service';
import { hashPassword } from '../common/password-hash.util';
```

Find:

```typescript
  it('rejects verification when no matching unconsumed code exists', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    const result = await service.verify('+2348000000000', '123456');
    expect(result).toBe(false);
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toBe(true);
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });
```

Replace with:

```typescript
  it('rejects verification when no matching unconsumed code exists', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    const result = await service.verify('+2348000000000', '123456');
    expect(result.valid).toBe(false);
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      email: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toEqual({ valid: true, email: null });
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('returns the matched row\'s pending email on success', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    const codeHash = await hashPassword('123456');
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      email: 'client@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toEqual({ valid: true, email: 'client@example.com' });
  });
```

Find:

```typescript
    it('does not short-circuit verify() when ENABLE_MOCK_OTP is not configured', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn()),
      ]);
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+2348000000000', '0000');

      expect(result).toBe(false);
      expect(prisma.otpCode.findFirst).toHaveBeenCalled();
    });
```

Replace with:

```typescript
    it('does not short-circuit verify() when ENABLE_MOCK_OTP is not configured', async () => {
      service = new OtpService(prisma as unknown as PrismaService, [
        fakeProvider('primary', jest.fn()),
      ]);
      prisma.otpCode.findFirst.mockResolvedValue(null);

      const result = await service.verify('+2348000000000', '0000');

      expect(result.valid).toBe(false);
      expect(prisma.otpCode.findFirst).toHaveBeenCalled();
    });
```

Find:

```typescript
      const result = await service.verify('+2348000000000', '0000');

      expect(result).toBe(true);
      expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    });
```

Replace with:

```typescript
      const result = await service.verify('+2348000000000', '0000');

      expect(result).toEqual({ valid: true });
      expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Write the new failing tests for the email-CC behavior**

In `src/otp/otp.service.spec.ts`, find:

```typescript
  it('omits mockCode from request() when disabled', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn().mockResolvedValue(undefined)),
    ]);

    const result = await service.request('+2348000000000');

    expect(result.mockCode).toBeUndefined();
  });
  });
});
```

Replace with:

```typescript
  it('omits mockCode from request() when disabled', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn().mockResolvedValue(undefined)),
    ]);

    const result = await service.request('+2348000000000');

    expect(result.mockCode).toBeUndefined();
  });
  });

  describe('email CC', () => {
    let emailService: { send: jest.Mock };

    beforeEach(() => {
      emailService = { send: jest.fn().mockResolvedValue(undefined) };
    });

    it('stores the email on the OtpCode row when given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000', 'client@example.com');

      expect(prisma.otpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'client@example.com' }) }),
      );
    });

    it('sends an email copy of the code when an email is given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000', 'client@example.com');

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'client@example.com',
          html: expect.stringContaining('verification code'),
        }),
      );
    });

    it('does not call emailService when no email is given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        undefined,
        emailService as unknown as EmailService,
      );

      await service.request('+2348000000000');

      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does not throw when the email copy fails -- the request still resolves', async () => {
      emailService.send.mockRejectedValue(new Error('smtp down'));
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockResolvedValue(undefined))],
        undefined,
        emailService as unknown as EmailService,
      );

      await expect(service.request('+2348000000000', 'client@example.com')).resolves.toBeDefined();
    });

    it('still throws when every SMS provider fails, even with an email given', async () => {
      service = new OtpService(
        prisma as unknown as PrismaService,
        [fakeProvider('primary', jest.fn().mockRejectedValue(new Error('vendor down')))],
        undefined,
        emailService as unknown as EmailService,
      );

      await expect(service.request('+2348000000000', 'client@example.com')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx jest src/otp/otp.service.spec.ts -t "email CC"`
Expected: FAIL — `service.request` doesn't accept/store/send an email yet

- [ ] **Step 4: Implement the service changes**

In `src/otp/otp.service.ts`, find:

```typescript
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_PROVIDERS, OtpProvider } from './otp-provider.interface';
import { hashPassword } from '../common/password-hash.util';
import { generateNumericCode } from '../common/generate-numeric-code.util';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDERS) private readonly providers: OtpProvider[],
    private readonly configService?: ConfigService,
  ) {}
```

Replace with:

```typescript
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_PROVIDERS, OtpProvider } from './otp-provider.interface';
import { EmailService } from '../email/email.service';
import { hashPassword } from '../common/password-hash.util';
import { generateNumericCode } from '../common/generate-numeric-code.util';

export interface OtpVerifyResult {
  valid: boolean;
  email?: string | null;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDERS) private readonly providers: OtpProvider[],
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
  ) {}
```

Find:

```typescript
  async request(phone: string): Promise<{ mockCode?: string }> {
    const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
    const code = generateNumericCode(length);
    const codeHash = await hashPassword(code);
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: { phone, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
    });

    await this.sendWithFailover(phone, code);

    return {
      mockCode:
        this.configService?.get('ENABLE_MOCK_OTP') === 'true'
          ? code
          : undefined,
    };
  }
```

Replace with:

```typescript
  async request(phone: string, email?: string): Promise<{ mockCode?: string }> {
    const length = Number(this.configService?.get('PHONE_OTP_LENGTH') ?? 4);
    const code = generateNumericCode(length);
    const codeHash = await hashPassword(code);
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: { phone, email, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
    });

    await this.sendWithFailover(phone, code);

    if (email) {
      await this.sendEmailCopy(email, code);
    }

    return {
      mockCode:
        this.configService?.get('ENABLE_MOCK_OTP') === 'true'
          ? code
          : undefined,
    };
  }

  private async sendEmailCopy(email: string, code: string): Promise<void> {
    const minutes = Math.round(this.ttlSeconds() / 60);
    try {
      await this.emailService?.send({
        to: email,
        subject: 'Your login code',
        html: `<p>Your verification code is <strong>${code}</strong>. It expires in ${minutes} minutes.</p>`,
        text: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OTP email copy to ${email} failed: ${message}`);
    }
  }
```

Find:

```typescript
  async verify(phone: string, code: string): Promise<boolean> {
    if (
      this.configService?.get('ENABLE_MOCK_OTP') === 'true' &&
      code === (this.configService?.get('MOCK_OTP_CODE') ?? '0000')
    ) {
      return true;
    }

    const candidate = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidate || candidate.expiresAt < new Date()) {
      return false;
    }

    const matches = await bcrypt.compare(code, candidate.codeHash);
    if (!matches) {
      return false;
    }

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    return true;
  }
```

Replace with:

```typescript
  async verify(phone: string, code: string): Promise<OtpVerifyResult> {
    if (
      this.configService?.get('ENABLE_MOCK_OTP') === 'true' &&
      code === (this.configService?.get('MOCK_OTP_CODE') ?? '0000')
    ) {
      return { valid: true };
    }

    const candidate = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidate || candidate.expiresAt < new Date()) {
      return { valid: false };
    }

    const matches = await bcrypt.compare(code, candidate.codeHash);
    if (!matches) {
      return { valid: false };
    }

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    return { valid: true, email: candidate.email };
  }
```

- [ ] **Step 5: Add `EmailModule` to `OtpModule`'s imports**

In `src/otp/otp.module.ts`, find:

```typescript
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './console-otp.provider';
import { OTP_PROVIDERS } from './otp-provider.interface';

@Module({
  providers: [
```

Replace with:

```typescript
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './console-otp.provider';
import { OTP_PROVIDERS } from './otp-provider.interface';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  providers: [
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 7: Commit**

```bash
git add src/otp/otp.service.ts src/otp/otp.service.spec.ts src/otp/otp.module.ts
git commit -m "feat: store and email-CC the OTP code when a client email is given"
```

---

### Task 3: `ClientAuthService`/`Controller` — collect, uniqueness-check, and persist the email

**Files:**
- Modify: `src/auth/client/client-auth.service.ts`
- Modify: `src/auth/client/client-auth.controller.ts`
- Modify: `src/auth/client/dto/request-otp.dto.ts`
- Test: `src/auth/client/client-auth.service.spec.ts`

**Interfaces:**
- Consumes: `OtpService.request(phone, email?)`/`.verify(phone, code): Promise<OtpVerifyResult>` (Task 2), `isUniqueConstraintError` (`src/common/is-unique-constraint-error.util.ts`, pre-existing).
- Produces: `ClientAuthService.requestOtp(phone: string, email?: string): Promise<{ mockCode?: string; emailSent: boolean }>`, `ClientAuthService.verifyOtp(...)` (unchanged signature, new internal behavior) — consumed by the controller.

- [ ] **Step 1: Add `email` to `RequestOtpDto`**

In `src/auth/client/dto/request-otp.dto.ts`, find:

```typescript
import { IsPhoneNumber } from 'class-validator';

export class RequestOtpDto {
  @IsPhoneNumber()
  phone: string;
}
```

Replace with:

```typescript
import { IsEmail, IsOptional, IsPhoneNumber } from 'class-validator';

export class RequestOtpDto {
  @IsPhoneNumber()
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
```

- [ ] **Step 2: Extend the test mock shape and write the failing tests**

In `src/auth/client/client-auth.service.spec.ts`, find:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = { client: { upsert: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  it('delegates OTP requests to OtpService', async () => {
    await service.requestOtp('+2348000000000');
    expect(otpService.request).toHaveBeenCalledWith('+2348000000000');
  });

  it('rejects an invalid OTP', async () => {
    otpService.verify.mockResolvedValue(false);
    await expect(
      service.verifyOtp('+2348000000000', '000000'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('upserts the Client and issues tokens via SessionService on a valid OTP', async () => {
    otpService.verify.mockResolvedValue(true);
    prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });

    const result = await service.verifyOtp('+2348000000000', '123456', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'CLIENT',
      principalId: 'client-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

Replace with:

```typescript
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = {
      client: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  describe('requestOtp', () => {
    it('delegates to OtpService with no email when none is given and no client exists yet', async () => {
      otpService.request.mockResolvedValue({});
      const result = await service.requestOtp('+2348000000000');
      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', undefined);
      expect(result.emailSent).toBe(false);
    });

    it('passes a brand-new email through after confirming it is not already taken', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.email ? null : null),
      );
      otpService.request.mockResolvedValue({});

      const result = await service.requestOtp('+2348000000000', 'new@example.com');

      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', 'new@example.com');
      expect(result.emailSent).toBe(true);
    });

    it('rejects when the supplied email already belongs to another client', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.email ? { id: 'other-client', email: where.email } : null),
      );

      await expect(service.requestOtp('+2348000000000', 'taken@example.com')).rejects.toThrow(ConflictException);
      expect(otpService.request).not.toHaveBeenCalled();
    });

    it('ignores a newly-supplied email and uses the existing saved one once a client already has one', async () => {
      prisma.client.findUnique.mockImplementation(({ where }: { where: { phone?: string; email?: string } }) =>
        Promise.resolve(where.phone ? { id: 'client-1', phone: where.phone, email: 'already-saved@example.com' } : null),
      );
      otpService.request.mockResolvedValue({});

      const result = await service.requestOtp('+2348000000000', 'different@example.com');

      expect(otpService.request).toHaveBeenCalledWith('+2348000000000', 'already-saved@example.com');
      expect(result.emailSent).toBe(true);
    });
  });

  describe('verifyOtp', () => {
    it('rejects an invalid OTP', async () => {
      otpService.verify.mockResolvedValue({ valid: false });
      await expect(
        service.verifyOtp('+2348000000000', '000000'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('upserts the Client and issues tokens via SessionService on a valid OTP', async () => {
      otpService.verify.mockResolvedValue({ valid: true });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });

      const result = await service.verifyOtp('+2348000000000', '123456', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(sessionService.createSession).toHaveBeenCalledWith({
        principalType: 'CLIENT',
        principalId: 'client-1',
        userAgent: 'jest',
        ip: '127.0.0.1',
      });
      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });

    it('persists a pending email from the OTP onto a newly-created Client', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'new@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: 'new@example.com' });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { email: 'new@example.com' },
      });
    });

    it('does not touch the Client when the OTP carried no pending email', async () => {
      otpService.verify.mockResolvedValue({ valid: true });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('does not overwrite a Client that already has an email', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'new@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: 'already-saved@example.com' });

      await service.verifyOtp('+2348000000000', '123456');

      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('swallows a P2002 race on the email update and still logs the client in', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'raced@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockRejectedValue({ code: 'P2002' });

      const result = await service.verifyOtp('+2348000000000', '123456');

      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });

    it('propagates a non-P2002 error from the email update', async () => {
      otpService.verify.mockResolvedValue({ valid: true, email: 'raced@example.com' });
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000', email: null });
      prisma.client.update.mockRejectedValue(new Error('db down'));

      await expect(service.verifyOtp('+2348000000000', '123456')).rejects.toThrow('db down');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx jest src/auth/client/client-auth.service.spec.ts`
Expected: FAIL — `service.requestOtp`/`verifyOtp` don't have the new behavior yet

- [ ] **Step 4: Implement the service changes**

In `src/auth/client/client-auth.service.ts`, replace the entire file with:

```typescript
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { isUniqueConstraintError } from '../../common/is-unique-constraint-error.util';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async requestOtp(phone: string, email?: string): Promise<{ mockCode?: string; emailSent: boolean }> {
    const existingClient = await this.prisma.client.findUnique({ where: { phone } });
    let effectiveEmail: string | undefined = existingClient?.email ?? undefined;

    if (!effectiveEmail && email) {
      const emailTaken = await this.prisma.client.findUnique({ where: { email } });
      if (emailTaken) {
        throw new ConflictException('This email is already in use');
      }
      effectiveEmail = email;
    }

    const { mockCode } = await this.otpService.request(phone, effectiveEmail);
    return { mockCode, emailSent: Boolean(effectiveEmail) };
  }

  async verifyOtp(phone: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    const result = await this.otpService.verify(phone, code);
    if (!result.valid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    let client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    if (result.email && !client.email) {
      try {
        client = await this.prisma.client.update({ where: { id: client.id }, data: { email: result.email } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        // Someone else claimed this email in the window between this
        // client's request and verify calls -- login still succeeds, the
        // email is just silently dropped this time.
      }
    }

    const payload = { sub: client.id, type: 'client' as const };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.CLIENT,
      principalId: client.id,
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

- [ ] **Step 5: Update the controller**

In `src/auth/client/client-auth.controller.ts`, find:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    const { mockCode } = await this.clientAuthService.requestOtp(dto.phone);
    return { sent: true, ...(mockCode ? { mockCode } : {}) };
  }
```

Replace with:

```typescript
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    const { mockCode, emailSent } = await this.clientAuthService.requestOtp(dto.phone, dto.email);
    return { sent: true, emailSent, ...(mockCode ? { mockCode } : {}) };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/auth/client/client-auth.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 7: Build check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors

- [ ] **Step 8: Commit**

```bash
git add src/auth/client/client-auth.service.ts src/auth/client/client-auth.controller.ts src/auth/client/dto/request-otp.dto.ts src/auth/client/client-auth.service.spec.ts
git commit -m "feat: collect, uniqueness-check, and persist an optional client email at login"
```

---

### Task 4: `LoanRequestService` — email-CC the three confirmation SMS sends

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.module.ts`
- Test: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `EmailService.send` (pre-existing).
- Produces: no new public methods — `create`/`createTopup`/`resend` each now also email-CC when `client.email` is set.

- [ ] **Step 1: Extend the test mock shape and constructor call, write the failing tests**

In `src/loan-request/loan-request.service.spec.ts`, find:

```typescript
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { WalletService } from '../wallet/wallet.service';
import { LoanRequestType } from '../generated/prisma/client';
```

Replace with:

```typescript
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../email/email.service';
import { LoanRequestType } from '../generated/prisma/client';
```

Find:

```typescript
  let smsProvider: { send: jest.Mock };
  let expiryQueue: { add: jest.Mock };
```

Replace with:

```typescript
  let smsProvider: { send: jest.Mock };
  let emailService: { send: jest.Mock };
  let expiryQueue: { add: jest.Mock };
```

Find:

```typescript
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
    );
  });
```

Replace with:

```typescript
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
      undefined,
      emailService as unknown as EmailService,
    );
  });
```

Find:

```typescript
    it('sends the SMS, creates the request, and enqueues the expiry job on success', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 5000,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          managementChargeAmount: 100,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });
```

Replace with:

```typescript
    it('sends the SMS, creates the request, and enqueues the expiry job on success', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 5000,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          managementChargeAmount: 100,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });

    it('also emails a confirmation copy when the client has an email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('5000') }),
      );
    });

    it('does not email when the client has no email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: null,
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('still creates the loan request when the email copy fails', async () => {
      emailService.send.mockRejectedValue(new Error('smtp down'));
      prisma.client.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        phone: '+2348000000000',
        email: 'client@example.com',
        status: 'VERIFIED',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await expect(service.create('c1', 5000, 6)).resolves.toEqual({ id: 'lr1' });
    });
```

Find (in the `createTopup` describe block):

```typescript
    it('sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the active loan', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.clientLoan.findFirstOrThrow.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('top-up'));
```

Leave that test's body as-is (don't truncate the assertions that follow), but add a new test immediately after it closes, still inside `describe('createTopup', ...)`:

```typescript
    it('also emails a top-up confirmation copy when the client has an email on file', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', email: 'client@example.com' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.clientLoan.findFirstOrThrow.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('top-up') }),
      );
    });
```

Find (in the `resend` describe block):

```typescript
    it('re-sends the SMS and updates confirmationSmsSentAt without touching expiresAt', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { confirmationSmsSentAt: expect.any(Date) },
```

Replace with:

```typescript
    it('re-sends the SMS and updates confirmationSmsSentAt without touching expiresAt', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { confirmationSmsSentAt: expect.any(Date) },
```

(leave the rest of that test body as-is) then add a new test immediately after that `it(...)` block closes, still inside `describe('resend', ...)`:

```typescript
    it('also emails a confirmation copy on resend when the client has an email on file', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', email: 'client@example.com' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'client@example.com', text: expect.stringContaining('5000') }),
      );
    });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts -t "email"`
Expected: FAIL — no email-sending behavior exists yet

- [ ] **Step 3: Implement the service changes**

In `src/loan-request/loan-request.service.ts`, find:

```typescript
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
```

Replace with:

```typescript
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
```

Find:

```typescript
import { WalletService } from '../wallet/wallet.service';
import { classifyVariance } from '../reconciliation/variance-classification.util';
```

Replace with:

```typescript
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../email/email.service';
import { classifyVariance } from '../reconciliation/variance-classification.util';
```

Find:

```typescript
@Injectable()
export class LoanRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly configService?: ConfigService,
  ) {}

  private confirmationMessage(amount: number, type: LoanRequestType = LoanRequestType.ORIGINATION): string {
    return type === LoanRequestType.TOPUP
      ? `Reply YES to confirm your loan top-up of ₦${amount}`
      : `Reply YES to confirm your loan request of ₦${amount}`;
  }
```

Replace with:

```typescript
@Injectable()
export class LoanRequestService {
  private readonly logger = new Logger(LoanRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
  ) {}

  private confirmationMessage(amount: number, type: LoanRequestType = LoanRequestType.ORIGINATION): string {
    return type === LoanRequestType.TOPUP
      ? `Reply YES to confirm your loan top-up of ₦${amount}`
      : `Reply YES to confirm your loan request of ₦${amount}`;
  }

  private async sendEmailCopy(email: string | null, message: string): Promise<void> {
    if (!email) return;
    try {
      await this.emailService?.send({
        to: email,
        subject: 'Confirm your loan request',
        html: `<p>${message}</p>`,
        text: message,
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Loan-request confirmation email to ${email} failed: ${err}`);
    }
  }
```

Find (in `create`):

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: termOption.interestRatePercent,
```

Replace with:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: termOption.interestRatePercent,
```

Find (in `createTopup`):

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
```

Replace with:

```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount, LoanRequestType.TOPUP));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
```

Find (in `resend`):

```typescript
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));

    return this.prisma.loanRequest.update({
```

Replace with:

```typescript
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));
    await this.sendEmailCopy(client.email, this.confirmationMessage(Number(loanRequest.amount)));

    return this.prisma.loanRequest.update({
```

- [ ] **Step 4: Add `EmailModule` to `LoanRequestModule`'s imports**

In `src/loan-request/loan-request.module.ts`, find:

```typescript
import { TwoWaySmsModule } from '../two-way-sms/two-way-sms.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { AuditModule } from '../audit/audit.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
    ClientLoansModule,
    AuditModule,
    WalletModule,
  ],
```

Replace with:

```typescript
import { TwoWaySmsModule } from '../two-way-sms/two-way-sms.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { AuditModule } from '../audit/audit.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
    ClientLoansModule,
    AuditModule,
    WalletModule,
    EmailModule,
  ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 6: Build check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors

- [ ] **Step 7: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.module.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: email-CC the three client loan-request confirmation SMS sends"
```

---

### Task 5: Postman

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

- [ ] **Step 1: Update `POST /auth/client/otp/request`'s saved examples**

Find the existing success example(s) for this request (search for `"auth/client/otp/request"`). Add the optional `email` field to the request body example, and `emailSent: true/false` to each response body. Add a new `409` response example named `"Conflict - email already in use (409)"` with body:

```json
{
  "statusCode": 409,
  "message": "This email is already in use",
  "error": "Conflict"
}
```

- [ ] **Step 2: Update `GET /admin/clients`/`GET /admin/clients/:id` saved examples**

Find the existing saved response bodies for these two requests (search for `"legacyId": "LEGACY-0099"` as in prior sessions' Postman edits to locate the `GET /admin/clients/:id` example). Add `"email": null` (or a sample address) to the top-level client object in each.

- [ ] **Step 3: Validate the collection is still valid JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs: add Postman coverage for optional client email"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS, no regressions

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: PASS (per this repo's known pre-existing cross-suite DB-contention flakiness under full-suite parallel runs — rerun any failing suite in isolation first before treating it as a regression)
