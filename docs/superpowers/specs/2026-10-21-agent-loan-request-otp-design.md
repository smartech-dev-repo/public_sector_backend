# Agent-Assisted Loan Requests with Email-OTP Confirmation — Design

## Overview

Today, loan origination/renewal is entirely client-initiated
(`src/loan-request/loan-request.controller.ts`, `ClientOnlyGuard`), and
confirmation happens one way: the client replies "YES" to an SMS
(`SmsWebhookController` → `LoanRequestService.confirmByPhone`).

This adds:
1. A **second, parallel confirmation channel** — an emailed OTP code —
   available for every loan request going forward, client-initiated or
   agent-initiated. SMS-reply-YES keeps working exactly as today; both
   channels race to confirm the same `PENDING` request.
2. An **agent-initiated path**: an agent can originate a loan request or
   top-up/renewal on behalf of a client they manage, through new
   `agent/clients/:clientId/loan-requests...` endpoints mirroring the
   existing `agent/clients/:clientId/loan-products` ownership pattern.
3. **Code submission from either side** — the client can type the code
   into their own app, or relay it verbally to an agent who submits it —
   via two new endpoints sharing one service method.

## Architecture

**Schema**: `LoanRequest` gains `confirmationCodeHash String?` and
`confirmationCodeExpiresAt DateTime?` — same `hashToken`-hashed,
inline-on-the-owning-row, `EMAIL_CODE_LENGTH`-configured, 10-minute-TTL
pattern as the Agent change-password OTP feature.

**Code issuance**: `create()`, `createTopup()`, and `resend()` each
generate a fresh code via a shared private helper, store its hash +
expiry on the `LoanRequest` row (same write, no extra round-trip), and
email it through a new dedicated template — separate from the existing
informational `loanRequestConfirmationEmail` copy, which is unchanged —
only when the client has an email on file (silently skipped otherwise,
matching today's optional-email handling for the copy email).

**Code verification**: a new `confirmByCode(clientId, id, code)` method
validates ownership + `PENDING` status + hash/expiry match, then runs the
same confirm logic `confirmByPhone` already has — extracted into a shared
private `confirmPending()` helper so both channels share one code path
and one set of auto-approve/disburse semantics.

**Response hygiene**: every existing method that returns a raw
`LoanRequest` row (`create`, `createTopup`, `resend`, `approve`, `reject`,
`disburse`, `listAll`, `list`) must exclude the two new columns via
Prisma's per-query `omit`. This isn't optional cleanup — `hashToken` is a
single unsalted SHA-256 pass over a 6–8 digit numeric space (≤100 million
possibilities), trivially brute-forced offline in milliseconds if the
hash ever appeared in a response. (This is a materially different risk
profile from e.g. `Agent.passwordHash`, which does leak in raw responses
elsewhere in this codebase today but is bcrypt-hashed and computationally
expensive to crack — that existing precedent does not extend to this
field.) A global Prisma-client-level omit was considered and rejected:
it would affect every query against `loanRequest` app-wide, including
`confirmByCode`'s own lookup (which must read the hash), and would need
auditing every other consumer of this model (admin review, reconciliation,
etc.) for unintended interaction — a much larger blast radius than this
feature's scope. A scoped, per-call-site `omit` (via one shared static
constant, matching this file's existing `LOAN_REQUEST_RELATIONS_INCLUDE`
convention) keeps the fix local and reviewable.

**Agent authorization**: the new agent controller requires
`AgentCanOnboardClientsGuard` (the same `canOnboardClients` JWT-flag guard
`agent-client-onboarding.controller.ts` already uses) in addition to
ownership scoping — this is a consequential write action on a client's
behalf, not a read like `agent-loan-products.controller.ts`, so it
belongs with the stricter existing precedent, not the looser one.

## Schema

```prisma
model LoanRequest {
  // ...existing fields unchanged...
  confirmationCodeHash      String?
  confirmationCodeExpiresAt DateTime?
}
```
Both columns are nullable additions to an existing table — requires a new
Prisma migration (`npx prisma migrate dev --name loan_request_confirmation_code`
or equivalent), same as the earlier Agent change-password OTP schema
change this session. This needs to be applied against the live shared
UAT database, consistent with this project's established migration
rollout process.

## Email template

New function in `src/email/templates/verification-code-emails.ts`,
following `changePasswordConfirmationCodeEmail`'s exact shape:
```typescript
export function loanConfirmationCodeEmail(params: { code: string; ttlMinutes: number }): { subject: string; html: string; text: string } {
  const bodyText = `Hello,\n\nWe received a request to confirm your loan.\n\nYour verification code is: ${params.code}\n\nThis code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email — no loan will be confirmed.\n\n${CLOSING_TEXT}`;
  const bodyHtml = `<p>Hello,</p><p>We received a request to confirm your loan.</p><p>Your verification code is:</p>${highlightBox(params.code)}<p>This code expires in ${params.ttlMinutes} minutes. If you didn't request this, you can safely ignore this email — no loan will be confirmed.</p>${CLOSING_HTML}`;
  return {
    subject: 'Confirm your loan request',
    html: wrapEmailLayout({ headline: 'Confirm your loan request', bodyHtml }),
    text: wrapEmailLayoutText({ headline: 'Confirm your loan request', bodyText }),
  };
}
```

## `LoanRequestService` changes

New imports: `UnauthorizedException` (added to the existing
`@nestjs/common` import list), `hashToken` from
`../common/opaque-token.util`, `generateNumericCode` from
`../common/generate-numeric-code.util`, `devCodeEcho` from
`../common/dev-code-echo.util`, `loanConfirmationCodeEmail` from
`../email/templates/verification-code-emails`.

New constant: `const LOAN_CONFIRMATION_CODE_TTL_MS = 10 * 60 * 1000;`

New static constant, alongside the existing
`LOAN_REQUEST_RELATIONS_INCLUDE`:
```typescript
private static readonly OMIT_CONFIRMATION_CODE = {
  confirmationCodeHash: true,
  confirmationCodeExpiresAt: true,
} as const;
```

New private helper:
```typescript
private async issueConfirmationCode(email: string | null): Promise<{
  confirmationCodeHash: string;
  confirmationCodeExpiresAt: Date;
  devCode?: string;
}> {
  const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
  const code = generateNumericCode(length);
  const confirmationCodeExpiresAt = new Date(Date.now() + LOAN_CONFIRMATION_CODE_TTL_MS);

  if (email) {
    try {
      await this.emailService?.send({
        to: email,
        ...loanConfirmationCodeEmail({ code, ttlMinutes: LOAN_CONFIRMATION_CODE_TTL_MS / 60000 }),
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Loan-request confirmation code email to ${email} failed: ${err}`);
    }
  }

  return {
    confirmationCodeHash: hashToken(code),
    confirmationCodeExpiresAt,
    devCode: devCodeEcho(this.configService, code),
  };
}
```

`create()` — after the existing `sendEmailCopy` call, before building the
`data` object:
```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
    await this.sendEmailCopy(client.email, amount, LoanRequestType.ORIGINATION);
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.issueConfirmationCode(client.email);

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
        confirmationCodeHash,
        confirmationCodeExpiresAt,
      },
      omit: LoanRequestService.OMIT_CONFIRMATION_CODE,
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return { ...loanRequest, devCode };
```
(Everything before `sendEmailCopy` — client lookup, onboarding check,
eligibility, product resolution, management charge calc — is unchanged.)

`createTopup()` — same shape, after the existing `sendEmailCopy` call:
```typescript
    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, amount, LoanRequestType.TOPUP);
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.issueConfirmationCode(client.email);

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
        topupTargetId: existingClientLoan?.id,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
        confirmationCodeHash,
        confirmationCodeExpiresAt,
      },
      omit: LoanRequestService.OMIT_CONFIRMATION_CODE,
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return { ...loanRequest, devCode };
```

`resend()` — full replacement:
```typescript
  async resend(clientId: string, id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));
    await this.sendEmailCopy(client.email, Number(loanRequest.amount), LoanRequestType.ORIGINATION);
    const { confirmationCodeHash, confirmationCodeExpiresAt, devCode } = await this.issueConfirmationCode(client.email);

    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { confirmationSmsSentAt: new Date(), confirmationCodeHash, confirmationCodeExpiresAt },
      omit: LoanRequestService.OMIT_CONFIRMATION_CODE,
    });

    return { ...updated, devCode };
  }
```
(The `LoanRequestType.ORIGINATION` hardcoding here is pre-existing
behavior — `resend` has always ignored the request's actual `type` this
way — not something this feature changes or fixes.)

`confirmByPhone()` — refactored to share logic with the new code path,
behavior unchanged:
```typescript
  async confirmByPhone(phone: string, message: string): Promise<void> {
    const normalized = message.trim().toLowerCase();
    if (normalized !== 'yes' && normalized !== '1') {
      return;
    }

    const client = await this.prisma.client.findUnique({ where: { phone } });
    if (!client) {
      return;
    }

    const pending = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: LoanRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      return;
    }

    await this.confirmPending(pending);
  }

  async confirmByCode(clientId: string, id: string, code: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }
    if (
      !loanRequest.confirmationCodeHash ||
      !loanRequest.confirmationCodeExpiresAt ||
      loanRequest.confirmationCodeExpiresAt < new Date() ||
      loanRequest.confirmationCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.confirmPending(loanRequest);
  }

  private async confirmPending(pending: LoanRequest): Promise<void> {
    const confirmed = await this.prisma.loanRequest.update({
      where: { id: pending.id },
      data: { status: LoanRequestStatus.CONFIRMED, confirmedAt: new Date() },
    });

    const threshold = Number(this.configService?.get('LOAN_AUTO_APPROVE_THRESHOLD') ?? 0);
    if (Number(confirmed.amount) < threshold) {
      await this.prisma.loanRequest.update({
        where: { id: confirmed.id },
        data: { status: LoanRequestStatus.DISBURSED, approvedAt: new Date(), disbursedAt: new Date() },
      });
      await this.createClientLoanFromRequest(confirmed.id);
    }
  }
```
(`confirmPending`'s two internal `update` calls don't need the
omit — their results are never returned to an API consumer, same as
today.)

`approve()`, `reject()`, `disburse()` — add `omit:
LoanRequestService.OMIT_CONFIRMATION_CODE` alongside the existing
`include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE` in each of
their three `update()` calls (Prisma allows `include` and `omit` together
in the same query — `omit` governs the base model's own scalar fields,
`include` governs relations).

`listAll()` — add `omit: LoanRequestService.OMIT_CONFIRMATION_CODE`
alongside the existing `include` in its `findMany` call.

`list()` (client-facing) — add `omit:
LoanRequestService.OMIT_CONFIRMATION_CODE` to its plain `findMany` call
(no existing `include` here).

## New DTO

`src/loan-request/dto/confirm-loan-request-code.dto.ts`:
```typescript
import { IsString, Length } from 'class-validator';

export class ConfirmLoanRequestCodeDto {
  @IsString()
  @Length(6, 8)
  code: string;
}
```

## Controllers

`LoanRequestController` (client-facing) gains one route:
```typescript
  @Post(':id/confirm-code')
  @HttpCode(200)
  async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.confirmByCode(req.user.sub, id, dto.code);
    return { confirmed: true };
  }
```

New `src/loan-request/agent-loan-request.controller.ts`:
```typescript
import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { AgentCanOnboardClientsGuard } from '../auth/agent-can-onboard-clients.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';

@Controller('agent/clients/:clientId/loan-requests')
@UseGuards(JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard)
export class AgentLoanRequestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanRequestService: LoanRequestService,
  ) {}

  private async assertOwnsClient(clientId: string, agentId: string): Promise<void> {
    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: agentId } },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Client not found');
    }
  }

  @Post()
  async create(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.create(clientId, dto.amount, dto.tenorMonths);
  }

  @Post('topup')
  async createTopup(@Param('clientId') clientId: string, @Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.createTopup(clientId, dto.amount, dto.tenorMonths);
  }

  @Post(':id/resend')
  @HttpCode(200)
  async resend(@Param('clientId') clientId: string, @Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.assertOwnsClient(clientId, req.user.sub);
    return this.loanRequestService.resend(clientId, id);
  }

  @Post(':id/confirm-code')
  @HttpCode(200)
  async confirmCode(
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() dto: ConfirmLoanRequestCodeDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.assertOwnsClient(clientId, req.user.sub);
    await this.loanRequestService.confirmByCode(clientId, id, dto.code);
    return { confirmed: true };
  }
}
```
(Ownership check mirrors `AgentLoanProductsController`'s exact pattern —
same where-clause, same 404-not-found treatment for a client that exists
but isn't this agent's.)

## Module wiring

`src/loan-request/loan-request.module.ts`: add `AgentLoanRequestController`
to the existing `controllers` array. No new `imports` needed —
`AgentCanOnboardClientsGuard` has no constructor dependencies (DI-free,
instantiated directly by Nest), and `PrismaService` is already available
app-wide.

## Testing

- `loan-request.service.spec.ts`: every existing `create`/`createTopup`/
  `resend` test's mocked `prisma.loanRequest.create`/`update` return
  values need `devCode: undefined` to be a non-issue (Jest's `toEqual`
  ignores `undefined`-valued keys — confirmed safe, same reasoning
  already validated earlier this session for the admin/agent devCode
  rollout) — but each mock's resolved value should also **not** include
  `confirmationCodeHash`/`confirmationCodeExpiresAt` keys (since the real
  `omit` strips them before the object reaches the caller) to keep the
  mocks accurate to the real Prisma call shape. New tests: `issueConfirmationCode`
  is called with the client's email; code email send failure doesn't
  block loan-request creation (mirrors the existing
  `sendEmailCopy`-failure-tolerance test); `confirmByCode` rejects a
  wrong/expired code, rejects a non-`PENDING` request, rejects a request
  belonging to a different client, and confirms + auto-disburses under
  threshold on a correct code (mirroring the existing `confirmByPhone`
  auto-approval tests).
- New `agent-loan-request.controller.spec.ts` (no existing coverage for
  this new file, obviously): ownership check passes/fails for each of the
  four routes; each route delegates to the matching service method with
  the resolved `clientId` (not `req.user.sub`, which is the *agent's* id).
- e2e: extend `test/loan-topup.e2e-spec.ts` or `test/loan-origination.e2e-spec.ts`
  (whichever already has `EMAIL_CODE_DEV_ECHO`-style coverage precedent to
  follow) with a full agent-initiated flow — agent creates a request for
  a client they onboarded, client's email receives the code (dev-echoed),
  agent submits it via `confirm-code`, request auto-disburses under
  threshold; a 404 case for an agent targeting a client they don't own;
  a case proving the *existing* SMS-reply-YES flow still independently
  confirms a request that also has a code pending (channels are
  independent, neither blocks the other); a wrong-code 401 case.

## Postman

Per this project's standing CLAUDE.md rule: `Client > Loan Requests`
gains the new `POST /client/loan-requests/:id/confirm-code` request
(success, wrong-code 401, validation-error 400 scenarios); a new
`Agent > Loan Requests` sub-folder is added (new controller → new
sub-folder, per the folder-structure convention) with all four routes'
success/failure scenarios, including the ownership 404 case.
