# Email Provider Switch (SMTP / SendGrid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Note for this repo:** neither sub-skill is installed here — replicate the pattern manually: one fresh Agent-tool call per task, review its diff before starting the next task, run only the touched file's tests per task (full suite at the end of this plan, not per-task).

**Goal:** Let `EmailModule` send real emails via SMTP or SendGrid, selected by `EMAIL_PROVIDER` at boot, while keeping `console` (log-only) as the safe default for local dev/tests — with zero changes to `EmailService`'s existing provider-array/fallback behavior.

**Architecture:** Two new `EmailProvider` implementations (`SmtpEmailProvider` via `nodemailer`, `SendGridEmailProvider` via `@sendgrid/mail`), both built lazily on first `send()` exactly like `S3FileStorageProvider` already does — `EmailModule` always instantiates every concrete provider so a factory can pick one at runtime, so eagerly reading env vars in the constructor would break boot whenever that provider isn't selected. A new shared `buildFrom()` helper reads the one sender identity (`EMAIL_FROM`/`EMAIL_FROM_NAME`) both providers use. `EmailModule`'s `EMAIL_PROVIDERS` factory changes from unconditionally returning `[consoleProvider]` to picking one of three based on `EMAIL_PROVIDER`.

**Tech Stack:** NestJS, `nodemailer`, `@sendgrid/mail`, Jest (module-level mocking, same pattern as `S3FileStorageProvider`'s test).

**Spec:** `docs/superpowers/specs/2026-09-29-email-provider-switch-design.md`

## Global Constraints

- `EMAIL_PROVIDER` config values are exactly `console | smtp | sendgrid`, default `console` — copied verbatim from the spec and already live in `.env`/`.env.example` (commit `fd5b90e`).
- No fallback-chain behavior between SMTP and SendGrid — exactly one provider is active per environment; `EmailService`'s existing loop-and-fallback code is not touched.
- No HTTP-facing surface changes — no Postman updates needed (per the spec's own scope note).
- Every provider reads its env vars lazily (on first `send()`), never in the constructor — `EmailModule` always constructs every concrete provider regardless of which is selected, so eager reads would break boot in any environment not using that provider.

---

### Task 1: Shared `buildFrom` sender-identity helper

**Files:**
- Create: `src/email/email-from.util.ts`
- Test: `src/email/email-from.util.spec.ts`

**Interfaces:**
- Produces: `buildFrom(configService: ConfigService): { name: string; address: string }` — consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/email/email-from.util.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { buildFrom } from './email-from.util';

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('buildFrom', () => {
  it('reads EMAIL_FROM_NAME and EMAIL_FROM into a {name, address} sender', () => {
    const config = fakeConfig({ EMAIL_FROM_NAME: 'Public Sector Backend', EMAIL_FROM: 'no-reply@example.com' });
    expect(buildFrom(config)).toEqual({ name: 'Public Sector Backend', address: 'no-reply@example.com' });
  });

  it('throws when EMAIL_FROM is missing', () => {
    const config = fakeConfig({ EMAIL_FROM_NAME: 'Public Sector Backend' });
    expect(() => buildFrom(config)).toThrow('Missing config: EMAIL_FROM');
  });

  it('throws when EMAIL_FROM_NAME is missing', () => {
    const config = fakeConfig({ EMAIL_FROM: 'no-reply@example.com' });
    expect(() => buildFrom(config)).toThrow('Missing config: EMAIL_FROM_NAME');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/email/email-from.util.spec.ts`
Expected: FAIL — `Cannot find module './email-from.util'`

- [ ] **Step 3: Write the implementation**

Create `src/email/email-from.util.ts`:

```typescript
import { ConfigService } from '@nestjs/config';

export interface EmailSender {
  name: string;
  address: string;
}

export function buildFrom(configService: ConfigService): EmailSender {
  return {
    name: configService.getOrThrow<string>('EMAIL_FROM_NAME'),
    address: configService.getOrThrow<string>('EMAIL_FROM'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/email/email-from.util.spec.ts`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add src/email/email-from.util.ts src/email/email-from.util.spec.ts
git commit -m "feat: add shared buildFrom sender-identity helper for email providers"
```

---

### Task 2: `SmtpEmailProvider`

**Files:**
- Modify: `package.json` (add `nodemailer` dependency, `@types/nodemailer` dev dependency)
- Create: `src/email/smtp-email.provider.ts`
- Test: `src/email/smtp-email.provider.spec.ts`

**Interfaces:**
- Consumes: `buildFrom` (Task 1), `EmailMessage`/`EmailProvider` from `src/email/email-provider.interface.ts` (pre-existing, unchanged).
- Produces: `SmtpEmailProvider` (implements `EmailProvider`, `name = 'smtp'`) — consumed by Task 4's module wiring.

- [ ] **Step 1: Install dependencies**

```bash
npm install nodemailer
npm install -D @types/nodemailer
```

- [ ] **Step 2: Write the failing test**

Create `src/email/smtp-email.provider.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { SmtpEmailProvider } from './smtp-email.provider';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('SmtpEmailProvider', () => {
  const config = fakeConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'user@example.com',
    SMTP_PASSWORD: 'secret',
    EMAIL_FROM: 'no-reply@example.com',
    EMAIL_FROM_NAME: 'Public Sector Backend',
  });
  let provider: SmtpEmailProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SmtpEmailProvider(config);
  });

  it('builds the transporter lazily from config, only once across multiple sends', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    await provider.send({ to: 'b@example.com', subject: 'Hi again', html: '<p>Hi</p>' });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'secret' },
    });
  });

  it('sends with the configured from identity and the message fields', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });

    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Public Sector Backend', address: 'no-reply@example.com' },
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('propagates a sendMail rejection', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('smtp down'));
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    await expect(
      provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('smtp down');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/email/smtp-email.provider.spec.ts`
Expected: FAIL — `Cannot find module './smtp-email.provider'`

- [ ] **Step 4: Write the implementation**

Create `src/email/smtp-email.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { EmailMessage, EmailProvider } from './email-provider.interface';
import { buildFrom } from './email-from.util';

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {}

  // Built lazily, on first send() -- see this file's module comment in
  // EmailModule: every concrete provider is always constructed so the
  // factory can pick one at runtime, so reading SMTP_* eagerly here would
  // break boot whenever SMTP isn't the selected provider.
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport({
        host: this.configService.getOrThrow<string>('SMTP_HOST'),
        port: Number(this.configService.getOrThrow<string>('SMTP_PORT')),
        secure: this.configService.get('SMTP_SECURE') === 'true',
        auth: {
          user: this.configService.getOrThrow<string>('SMTP_USER'),
          pass: this.configService.getOrThrow<string>('SMTP_PASSWORD'),
        },
      });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.getTransporter().sendMail({
      from: buildFrom(this.configService),
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/email/smtp-email.provider.spec.ts`
Expected: PASS, 3/3

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/email/smtp-email.provider.ts src/email/smtp-email.provider.spec.ts
git commit -m "feat: add SmtpEmailProvider"
```

---

### Task 3: `SendGridEmailProvider`

**Files:**
- Modify: `package.json` (add `@sendgrid/mail` dependency)
- Create: `src/email/sendgrid-email.provider.ts`
- Test: `src/email/sendgrid-email.provider.spec.ts`

**Interfaces:**
- Consumes: `buildFrom` (Task 1), `EmailMessage`/`EmailProvider` (pre-existing, unchanged).
- Produces: `SendGridEmailProvider` (implements `EmailProvider`, `name = 'sendgrid'`) — consumed by Task 4's module wiring.

- [ ] **Step 1: Install the dependency**

```bash
npm install @sendgrid/mail
```

(`@sendgrid/mail` ships its own TypeScript types — no separate `@types/` package needed.)

- [ ] **Step 2: Write the failing test**

Create `src/email/sendgrid-email.provider.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { SendGridEmailProvider } from './sendgrid-email.provider';

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('SendGridEmailProvider', () => {
  const config = fakeConfig({
    SENDGRID_API_KEY: 'SG.test-key',
    EMAIL_FROM: 'no-reply@example.com',
    EMAIL_FROM_NAME: 'Public Sector Backend',
  });
  let provider: SendGridEmailProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SendGridEmailProvider(config);
  });

  it('sets the API key lazily from config, only once across multiple sends', async () => {
    (sgMail.send as jest.Mock).mockResolvedValue(undefined);

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    await provider.send({ to: 'b@example.com', subject: 'Hi again', html: '<p>Hi</p>' });

    expect(sgMail.setApiKey).toHaveBeenCalledTimes(1);
    expect(sgMail.setApiKey).toHaveBeenCalledWith('SG.test-key');
  });

  it("sends with the configured from identity mapped to SendGrid's email key, and the message fields", async () => {
    (sgMail.send as jest.Mock).mockResolvedValue(undefined);

    await provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });

    expect(sgMail.send).toHaveBeenCalledWith({
      from: { name: 'Public Sector Backend', email: 'no-reply@example.com' },
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('propagates a send rejection', async () => {
    (sgMail.send as jest.Mock).mockRejectedValue(new Error('sendgrid down'));

    await expect(
      provider.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('sendgrid down');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/email/sendgrid-email.provider.spec.ts`
Expected: FAIL — `Cannot find module './sendgrid-email.provider'`

- [ ] **Step 4: Write the implementation**

Create `src/email/sendgrid-email.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { EmailMessage, EmailProvider } from './email-provider.interface';
import { buildFrom } from './email-from.util';

@Injectable()
export class SendGridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  // Initialized lazily, on first send() -- see SmtpEmailProvider's comment
  // for why (EmailModule always constructs every concrete provider).
  private ensureInitialized(): void {
    if (!this.initialized) {
      sgMail.setApiKey(this.configService.getOrThrow<string>('SENDGRID_API_KEY'));
      this.initialized = true;
    }
  }

  async send(message: EmailMessage): Promise<void> {
    this.ensureInitialized();
    const from = buildFrom(this.configService);
    await sgMail.send({
      from: { name: from.name, email: from.address },
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/email/sendgrid-email.provider.spec.ts`
Expected: PASS, 3/3

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/email/sendgrid-email.provider.ts src/email/sendgrid-email.provider.spec.ts
git commit -m "feat: add SendGridEmailProvider"
```

---

### Task 4: Wire `EMAIL_PROVIDER` selection into `EmailModule`

**Files:**
- Modify: `src/email/email.module.ts`

**Interfaces:**
- Consumes: `SmtpEmailProvider` (Task 2), `SendGridEmailProvider` (Task 3), pre-existing `ConsoleEmailProvider`/`EmailService`/`EMAIL_PROVIDERS`.
- Produces: `EMAIL_PROVIDERS` now resolves to `[smtp]`, `[sendgrid]`, or `[consoleProvider]` based on `EMAIL_PROVIDER`.

This task has no dedicated unit test — the sibling `FileStorageModule`/`IdentityVerificationModule` provider-selection factories in this codebase follow the same convention (no `*.module.spec.ts` exists for any of them); verification is a full app boot + the existing `EmailService` suite, which doesn't change behavior here.

- [ ] **Step 1: Update the module**

In `src/email/email.module.ts`, find:

```typescript
import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ConsoleEmailProvider } from './console-email.provider';
import { EMAIL_PROVIDERS } from './email-provider.interface';

@Module({
  providers: [
    EmailService,
    ConsoleEmailProvider,
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (consoleProvider: ConsoleEmailProvider) => [consoleProvider],
      inject: [ConsoleEmailProvider],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
```

Replace with:

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { ConsoleEmailProvider } from './console-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';
import { SendGridEmailProvider } from './sendgrid-email.provider';
import { EMAIL_PROVIDERS, EmailProvider } from './email-provider.interface';

@Module({
  providers: [
    EmailService,
    ConsoleEmailProvider,
    SmtpEmailProvider,
    SendGridEmailProvider,
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (
        configService: ConfigService,
        consoleProvider: ConsoleEmailProvider,
        smtp: SmtpEmailProvider,
        sendgrid: SendGridEmailProvider,
      ): EmailProvider[] => {
        const provider = configService.get<string>('EMAIL_PROVIDER', 'console');
        if (provider === 'smtp') return [smtp];
        if (provider === 'sendgrid') return [sendgrid];
        return [consoleProvider];
      },
      inject: [ConfigService, ConsoleEmailProvider, SmtpEmailProvider, SendGridEmailProvider],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
```

(`ConfigModule` doesn't need adding to this module's `imports` — it's already registered globally in `AppModule`, the same reason `FileStorageModule`'s providers can inject `ConfigService` without importing `ConfigModule` themselves.)

- [ ] **Step 2: Verify the app still boots and the existing email suite is unaffected**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors

Run: `npx jest src/email`
Expected: PASS — all of `email.service.spec.ts`, `email-from.util.spec.ts`, `smtp-email.provider.spec.ts`, `sendgrid-email.provider.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add src/email/email.module.ts
git commit -m "feat: select EmailProvider by EMAIL_PROVIDER (console/smtp/sendgrid)"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS, no regressions

- [ ] **Step 2: Confirm no stray env/config drift**

Run: `grep -c "EMAIL_PROVIDER\|SMTP_HOST\|SENDGRID_API_KEY" .env .env.example`
Expected: both files already have these (added in commit `fd5b90e`) — this step only confirms nothing in this plan's tasks needed to touch them again.
