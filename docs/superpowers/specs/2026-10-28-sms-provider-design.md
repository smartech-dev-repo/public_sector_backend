# SMS Provider Abstraction + Termii Integration — Design

## Goal

Replace the two existing, mock-only, send-side SMS abstractions
(`OtpProvider` in `src/otp/`, and `TwoWaySmsProvider` in `src/two-way-sms/`)
with a single `SmsProvider` interface and a routing `SmsService`, so the app
can switch providers per deployment and route different SMS **types** to
different providers. Integrate Termii
(https://developers.termii.com/messaging-api) as the first real provider.

## Context (current state)

Two call sites send SMS today, through two separate, structurally
identical interfaces:

- `OtpService.request()` (`src/otp/otp.service.ts`) sends the client
  phone-login OTP code via `OTP_PROVIDERS: OtpProvider[]`
  (`send(phone, code): Promise<void>`), with a failover loop across the
  array. Only `ConsoleOtpProvider` exists (logs instead of sending).
- `LoanRequestService` (`src/loan-request/loan-request.service.ts`, 3 call
  sites: `create`, `createTopup`, `resend`) sends the loan
  confirm/reject-by-SMS-reply message via `TWO_WAY_SMS_PROVIDER:
  TwoWaySmsProvider` (`send(phone, message): Promise<void>`). Only
  `MockTwoWaySmsProvider` exists (logs instead of sending). The reply side
  of this flow is independent: `SmsWebhookController` →
  `LoanRequestService.confirmByPhone()` reads an inbound "YES"/"1" SMS from
  any phone number and looks up a pending loan request by phone — it does
  not care which provider sent the original outbound message.

Both interfaces have the same shape because sending is the same operation
either way. The only thing that makes the loan-confirmation flow "two-way"
is that something downstream (the webhook) is wired to react to a reply —
that's a property of the flow, not of the provider. A single provider
(Termii) can serve both message types through one `send()` method.

`EmailModule` (`src/email/`) already has the config pattern this design
follows: an env var selects the active provider, defaulting to a
console/log-only provider for local dev and tests.

## Architecture

```
SmsModule
├── sms-provider.interface.ts   — SmsProvider contract + SMS_PROVIDERS token
├── sms-type.ts                 — SmsType enum: OTP | LOAN_CONFIRMATION | NOTIFICATION
├── sms.service.ts              — SmsService: routes send() by type to a provider
├── console-sms.provider.ts     — ConsoleSmsProvider (logs; default for all types)
├── termii-sms.provider.ts      — TermiiSmsProvider (real send via Termii HTTP API)
└── sms.module.ts                — wires provider map + exports SmsService
```

`OtpModule` and `TwoWaySmsModule` are deleted. `OtpService` and
`LoanRequestService` both import `SmsModule` and inject `SmsService`
instead of their old provider tokens.

### `SmsProvider` interface

```typescript
export interface SmsProvider {
  readonly name: string;
  send(phone: string, message: string, channel: SmsChannel): Promise<void>;
}

export type SmsChannel = 'dnd' | 'generic';
```

`channel` is passed through on every call (not provider-specific config)
because it's a per-message routing concern (transactional vs promotional),
not a property of a provider instance. `ConsoleSmsProvider` ignores it;
`TermiiSmsProvider` maps it straight onto Termii's `channel` field.

### `SmsType` and routing

```typescript
export enum SmsType {
  OTP = 'OTP',
  LOAN_CONFIRMATION = 'LOAN_CONFIRMATION',
  NOTIFICATION = 'NOTIFICATION',
}
```

`SmsService.send({ type, phone, message })`:
1. Resolves the provider for `type` from a `Record<SmsType, SmsProvider>`
   built in `SmsModule` (see below).
2. Resolves the channel for `type` the same way (config-driven, defaulting
   to `dnd` for every type — all three current/initial types are
   transactional, not promotional).
3. Calls `provider.send(phone, message, channel)`. On failure, logs the
   provider name and error, then rethrows (no silent fallback — a failed
   OTP or confirmation send must surface to the caller, not disappear into
   a console log).

```typescript
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @Inject(SMS_PROVIDERS_BY_TYPE) private readonly providers: Record<SmsType, SmsProvider>,
    @Inject(SMS_CHANNELS_BY_TYPE) private readonly channels: Record<SmsType, SmsChannel>,
  ) {}

  async send(args: { type: SmsType; phone: string; message: string }): Promise<void> {
    const provider = this.providers[args.type];
    const channel = this.channels[args.type];
    try {
      await provider.send(args.phone, args.message, channel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMS provider "${provider.name}" failed for type ${args.type}: ${msg}`);
      throw error;
    }
  }
}
```

### Module wiring (`SmsModule`)

```typescript
@Module({
  providers: [
    SmsService,
    ConsoleSmsProvider,
    TermiiSmsProvider,
    {
      provide: SMS_PROVIDERS_BY_TYPE,
      useFactory: (config: ConfigService, console_: ConsoleSmsProvider, termii: TermiiSmsProvider) => {
        // `||`, not `??` -- an unset override in .env (e.g. `SMS_OTP_PROVIDER=`)
        // resolves to an empty string, not undefined, so `??` would never
        // fall through to the SMS_PROVIDER default.
        const resolve = (envVar: string): SmsProvider => {
          const name = config.get<string>(envVar) || config.get<string>('SMS_PROVIDER', 'console');
          return name === 'termii' ? termii : console_;
        };
        return {
          [SmsType.OTP]: resolve('SMS_OTP_PROVIDER'),
          [SmsType.LOAN_CONFIRMATION]: resolve('SMS_LOAN_CONFIRMATION_PROVIDER'),
          [SmsType.NOTIFICATION]: resolve('SMS_NOTIFICATION_PROVIDER'),
        };
      },
      inject: [ConfigService, ConsoleSmsProvider, TermiiSmsProvider],
    },
    {
      provide: SMS_CHANNELS_BY_TYPE,
      useFactory: (config: ConfigService) => {
        const resolve = (envVar: string): SmsChannel =>
          (config.get<string>(envVar) || config.get<string>('SMS_CHANNEL', 'dnd')) as SmsChannel;
        return {
          [SmsType.OTP]: resolve('SMS_OTP_CHANNEL'),
          [SmsType.LOAN_CONFIRMATION]: resolve('SMS_LOAN_CONFIRMATION_CHANNEL'),
          [SmsType.NOTIFICATION]: resolve('SMS_NOTIFICATION_CHANNEL'),
        };
      },
      inject: [ConfigService],
    },
  ],
  exports: [SmsService],
})
export class SmsModule {}
```

`SMS_PROVIDERS_BY_TYPE` and `SMS_CHANNELS_BY_TYPE` are `Symbol()` tokens
declared in `sms-provider.interface.ts`, following the existing
`EMAIL_PROVIDERS`/`OTP_PROVIDERS` convention.

### `TermiiSmsProvider`

Uses native `fetch` (Node 22, already the runtime — no new dependency,
matching how `SendGridEmailProvider` uses the `@sendgrid/mail` SDK but
nothing else in this codebase reaches for `axios`).

```typescript
@Injectable()
export class TermiiSmsProvider implements SmsProvider {
  readonly name = 'termii';

  constructor(private readonly configService: ConfigService) {}

  async send(phone: string, message: string, channel: SmsChannel): Promise<void> {
    const baseUrl = this.configService.get<string>('TERMII_BASE_URL', 'https://api.ng.termii.com');
    const response = await fetch(`${baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.configService.getOrThrow<string>('TERMII_API_KEY'),
        to: phone,
        from: this.configService.getOrThrow<string>('TERMII_SENDER_ID'),
        sms: message,
        type: 'plain',
        channel,
      }),
    });

    const body = await response.json();
    if (!response.ok || body.code !== 'ok') {
      throw new Error(`Termii send failed: ${body.message ?? response.statusText}`);
    }
  }
}
```

Request/response shape per Termii's documented Messaging API
(`POST {TERMII_BASE_URL}/api/sms/send`):
- Request: `api_key`, `to` (phone, international format e.g.
  `2347880234567`), `from` (registered alphanumeric sender ID, 3–11
  chars), `sms` (message text), `type: 'plain'`, `channel: 'dnd' |
  'generic'`.
- Success response: `{ code: 'ok', balance, message_id, message,
  user, message_id_str }`.
- Failure is detected by a non-2xx HTTP status or `code !== 'ok'`; the
  error message uses Termii's own `message` field when present.

`ConsoleSmsProvider` mirrors `ConsoleEmailProvider`:

```typescript
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  async send(phone: string, message: string, channel: SmsChannel): Promise<void> {
    this.logger.log(`[${channel}] SMS to ${phone}: ${message}`);
  }
}
```

## Call-site changes

### `OtpService` (`src/otp/otp.service.ts`)

- Constructor drops `@Inject(OTP_PROVIDERS) providers: OtpProvider[]`,
  gains `private readonly smsService: SmsService`.
- `sendWithFailover(phone, code)` is deleted; `request()` calls
  `await this.smsService.send({ type: SmsType.OTP, phone, message: code })`
  directly (no failover loop — failure handling now lives once, in
  `SmsService`, not duplicated per call site).

### `LoanRequestService` (`src/loan-request/loan-request.service.ts`)

- Constructor drops `@Inject(TWO_WAY_SMS_PROVIDER) smsProvider:
  TwoWaySmsProvider`, gains `private readonly smsService: SmsService`.
- All 3 call sites (`create`, `createTopup`, `resend`) change
  `this.smsProvider.send(phone, message)` to
  `this.smsService.send({ type: SmsType.LOAN_CONFIRMATION, phone, message })`.
- `SmsWebhookController` and `confirmByPhone()` are **unchanged** — the
  reply-handling side of this flow doesn't know or care which provider
  sent the original message.

### Module wiring

- `src/otp/otp.module.ts`: imports `SmsModule` instead of declaring its
  own providers/`OTP_PROVIDERS`/`ConsoleOtpProvider`.
- `src/loan-request/loan-request.module.ts`: imports `SmsModule` instead
  of `TwoWaySmsModule`.
- `src/otp/otp-provider.interface.ts`, `src/otp/console-otp.provider.ts`,
  and the entire `src/two-way-sms/` directory are deleted.
- `src/app.module.ts`: no change needed — neither `OtpModule` nor
  `LoanRequestModule`'s registration changes shape, they just import a
  different module internally.

## Config (`.env.example` additions, inserted after the `EMAIL_PROVIDER`
block)

```
# SMS_PROVIDER selects the default SmsProvider for every SMS type:
# console | termii. console (the default) just logs instead of sending --
# safe for local dev/tests with no real credentials. Override per type
# with SMS_OTP_PROVIDER / SMS_LOAN_CONFIRMATION_PROVIDER /
# SMS_NOTIFICATION_PROVIDER if a given type should use a different
# provider than the default.
SMS_PROVIDER=console
SMS_OTP_PROVIDER=
SMS_LOAN_CONFIRMATION_PROVIDER=
SMS_NOTIFICATION_PROVIDER=

# SMS_CHANNEL selects the default Termii channel for every SMS type: dnd |
# generic. dnd (the default) is for transactional/critical messages --
# reaches DND-registered numbers and has no MTN night-time restriction.
# generic is for promotional messages only. Override per type with
# SMS_OTP_CHANNEL / SMS_LOAN_CONFIRMATION_CHANNEL / SMS_NOTIFICATION_CHANNEL.
SMS_CHANNEL=dnd
SMS_OTP_CHANNEL=
SMS_LOAN_CONFIRMATION_CHANNEL=
SMS_NOTIFICATION_CHANNEL=

# Termii (https://developers.termii.com) -- only needed when SMS_PROVIDER
# (or a per-type override) is set to "termii".
TERMII_API_KEY=
TERMII_SENDER_ID=
TERMII_BASE_URL=https://api.ng.termii.com
```

## Error handling

- `TermiiSmsProvider.send()` throws a plain `Error` (not a Nest HTTP
  exception — this is an outbound integration call, not a request
  handler) on non-2xx HTTP status or `code !== 'ok'` in the response body,
  using Termii's own `message` field in the thrown error when present.
- `SmsService.send()` logs the provider name, SMS type, and error message
  at `error` level, then rethrows unchanged. No fallback provider, no
  swallowing — matches the "throw on failure" decision: a real outage must
  surface to the caller (e.g. `OtpService.request()` fails the HTTP
  request rather than silently logging an OTP the user never receives).
- `TERMII_API_KEY` / `TERMII_SENDER_ID` use `configService.getOrThrow`,
  so a misconfigured `termii` selection fails fast and loudly rather than
  sending with an empty key.

## Testing

- `sms.service.spec.ts` (new): routes to the correct provider/channel per
  type from the injected maps; rethrows and logs on provider failure;
  does not call any other provider on failure (no fallback).
- `console-sms.provider.spec.ts` (new): logs phone/channel/message,
  resolves.
- `termii-sms.provider.spec.ts` (new): mocks global `fetch`; asserts the
  exact request body/URL/headers sent; succeeds on `{code: 'ok', ...}`;
  throws with Termii's `message` on `{code: 'error', message: '...'}` and
  on a non-2xx HTTP status; throws when `TERMII_API_KEY`/
  `TERMII_SENDER_ID` are unset.
- `otp.service.spec.ts` (update existing): replace the
  `OTP_PROVIDERS`/failover-array mocks with a single `SmsService` mock;
  assert `request()` calls `smsService.send({ type: SmsType.OTP, phone,
  message: code })`.
- `loan-request.service.spec.ts` (update existing): replace the
  `TWO_WAY_SMS_PROVIDER` mock with an `SmsService` mock; assert all 3 call
  sites (`create`, `createTopup`, `resend`) call `smsService.send({ type:
  SmsType.LOAN_CONFIRMATION, phone, message })`.
- No e2e changes needed: `SmsModule` defaults to `console`, so existing
  e2e specs (which never set `SMS_PROVIDER=termii`) keep passing with no
  real network calls, same as today's mock providers.

## Out of scope

- A real two-way provider roster (Termii or otherwise) for the
  loan-confirmation inbound-reply side — `SmsWebhookController`'s generic,
  provider-agnostic webhook already covers this regardless of which
  outbound provider sent the message; no change needed there.
- Signature verification on the inbound SMS webhook (already a separate,
  previously-deferred item per the existing comment in
  `sms-webhook.controller.ts`).
- Bulk send (`/api/sms/send/bulk`), WhatsApp/voice channels, encrypted SMS
  type, and media attachments — none of Termii's documented capabilities
  beyond plain single-recipient `dnd`/`generic` send are used by any
  current call site.
- Postman collection changes — this design touches no HTTP-facing
  endpoint, DTO, or response shape; `SmsService` is an internal
  dependency of existing endpoints whose request/response contracts are
  unchanged.
