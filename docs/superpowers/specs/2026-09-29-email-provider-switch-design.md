# Email Provider Switch (SMTP / SendGrid) Design

## 1. Purpose

`EmailModule` (`src/email/`) already has a provider-array/fallback design —
`EmailService` loops over an injected `EmailProvider[]`, trying each in
order and falling back on failure. Today only `ConsoleEmailProvider` (logs
instead of sending) is registered, so **no real emails are sent in any
environment**, including OTP/2FA codes in `AdminAuthService`/
`AgentAuthService`, agent review notifications, and admin invites.

This adds two real providers — SMTP (via `nodemailer`) and SendGrid (via
`@sendgrid/mail`) — selected by a single config value, mirroring the
`STORAGE_PROVIDER` pattern already used by `FileStorageModule`
(`local | s3 | gcs`, one active provider chosen at boot). `EMAIL_PROVIDER`
(`console | smtp | sendgrid`, default `console`) picks exactly one active
provider; the array-based `EmailService` loop is left as-is (with one
provider in the array it just calls that one), so no fallback-chain
behavior is introduced or implied — switching providers is a deploy-time
config change, not automatic runtime failover.

`EmailMessage`/`EmailProvider` interfaces (`src/email/email-provider.interface.ts`)
are unchanged.

## 2. New providers

Both follow `S3FileStorageProvider`'s lazy-client pattern
(`src/file-storage/s3-file-storage.provider.ts`): `FileStorageModule`/
`EmailModule` always construct every concrete provider so a factory can
pick one at runtime, so reading required env vars eagerly in the
constructor would break app startup whenever that provider isn't selected
(e.g. local dev on `console`). Config is read via `getOrThrow` only inside
the lazily-built client getter, on first `send()` call.

`src/email/smtp-email.provider.ts`:

```typescript
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {}

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
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
    const from = buildFrom(this.configService);
    await this.getTransporter().sendMail({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
```

`src/email/sendgrid-email.provider.ts`:

```typescript
@Injectable()
export class SendGridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

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
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
```

`buildFrom(configService)` is a small shared helper (co-located in
`email-provider.interface.ts` or a new `email-from.util.ts`) reading
`EMAIL_FROM`/`EMAIL_FROM_NAME` into `{ name, address }`, used identically
by both providers — one shared sender identity regardless of which
provider is active.

## 3. Module wiring

`src/email/email.module.ts` changes from unconditionally injecting
`[consoleProvider]` to selecting one provider by `EMAIL_PROVIDER`:

```typescript
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

## 4. Config

Already added to `.env`/`.env.example` (2026-09-29):

```
EMAIL_PROVIDER=console
EMAIL_FROM=no-reply@example.com
EMAIL_FROM_NAME=Public Sector Backend

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=

SENDGRID_API_KEY=
```

`console` stays the default in both files, so local dev/CI never need real
SMTP/SendGrid credentials — same default-to-safe pattern as
`STORAGE_PROVIDER=local`.

## 5. New dependencies

`nodemailer` + `@types/nodemailer` (dev dep), `@sendgrid/mail`.

## 6. Testing

- Unit: `SmtpEmailProvider` — mock `nodemailer.createTransport`, assert
  `sendMail` is called with the right `to`/`subject`/`html`/`text`/`from`;
  assert the transporter is built lazily (not in the constructor) and only
  once across multiple `send()` calls; assert a `sendMail` rejection
  propagates.
- Unit: `SendGridEmailProvider` — mock `@sendgrid/mail`, same assertions
  (`setApiKey` called once, `send` called with the right payload, rejection
  propagates).
- Unit: `EmailModule`'s factory — `EMAIL_PROVIDER=smtp`/`sendgrid`/`console`/
  unset each resolve to the expected single-element provider array.
- No e2e or Postman changes — this isn't an HTTP-facing surface, and no
  endpoint's request/response shape changes.

## 7. Out of scope

- Fallback-chain behavior (trying a second provider automatically after
  the first fails) — not requested; `EMAIL_PROVIDER` selects exactly one
  provider per environment.
- Attachments, CC/BCC — no current call site needs them; `EmailMessage`
  is unchanged.
- Per-provider `from` addresses — one shared `EMAIL_FROM`/`EMAIL_FROM_NAME`
  covers the single-active-provider design.
