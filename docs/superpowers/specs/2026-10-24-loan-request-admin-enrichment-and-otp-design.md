# Loan Request Admin Enrichment, Phone Fallback, and Admin-Confirm OTP — Design

## Overview

Three related adjustments to the loan-request flow, all converging on
`LoanRequestService` and the three controllers around it
(`AdminLoanRequestController`, `LoanRequestController` (client),
`AgentLoanRequestController`):

1. **Admin loan-request responses are too thin.** `GET admin/loan-requests`
   returns a bare `LoanRequest` row plus a narrow `client`/`topupTarget`
   selection. Admins need the client's onboarding/IPPIS context and a
   computed list of what they can actually do with each row. There's also
   no `GET admin/loan-requests/:id` detail endpoint at all today.
2. **SMS delivery has no fallback.** `create()`/`createTopup()`/`resend()`
   always send to `client.phone`. If that's ever empty, there's no
   fallback — even though the linked `IppisRecord.phone` is sitting right
   there in the same `onboarding.ippisRecord` include these methods
   already fetch.
3. **Admin needs an OTP-gated way to push a stuck `PENDING` request to
   `CONFIRMED`** (today only the client/agent can do this, via SMS-reply
   or the existing confirm-code endpoints), **and approving a `CONFIRMED`
   request should go straight to `DISBURSED`** in one step, matching the
   auto-threshold path's existing behavior instead of resting in a
   separate `APPROVED` state that always needs a second manual disburse
   click.

Confirmed against the live UAT DB before writing this: zero `LoanRequest`
rows are currently `APPROVED`, so collapsing approve+disburse is safe —
nothing is left stranded in a state that stops existing.

## Part 1 — Admin enrichment + `availableActions`

### Response shape

`LoanRequestService`'s shared `LOAN_REQUEST_RELATIONS_INCLUDE` constant
grows from `{ client: {id, phone, status}, topupTarget: {...} }` to:

```typescript
private static readonly LOAN_REQUEST_RELATIONS_INCLUDE = {
  client: {
    select: {
      id: true,
      phone: true,
      email: true,
      status: true,
      onboarding: {
        select: {
          employeeName: true,
          agency: true,
          onboardedByAgentId: true,
          ippisRecord: {
            select: {
              agency: true,
              staffId: true,
              employeeName: true,
              employeeStatus: true,
              hireDate: true,
              department: true,
              grade: true,
              bankName: true,
              accountNumber: true,
            },
          },
        },
      },
    },
  },
  topupTarget: { select: { id: true, status: true, agency: true } },
} as const;
```
The `ippisRecord` sub-select already excludes `bvn`/`salary`/`pinNumber`/
`rawFields` — the same sensitive-field exclusion `narrowIppisRecord()`
applies elsewhere, just done at the query level this time since every
field is being hand-picked anyway (no separate narrowing pass needed).

Every row (list and the new detail endpoint) also gets:
```typescript
availableActions: string[]
```
computed from `status`:
- `PENDING` → `['confirmCode']` (admin's new power — see Part 3A; admin
  does **not** get a resend action, only agent/client do, unchanged)
- `CONFIRMED` → `['approve', 'reject']`
- `APPROVED` → `['disburse']` (defensive — nothing should land here
  going forward per Part 3B, but a request already here when this ships,
  or any future edge case, still needs a way out)
- `DISBURSED` / `REJECTED` / `FAILED` → `[]`

`disbursedAt` needs no change — it's a plain `LoanRequest` column, never
part of the `omit`, already present on every response today. Calling it
out explicitly here because it's the field that matters most to admins:
it's the moment a `ClientLoan`'s own `disbursementDate` is set to (in
`createClientLoanFromRequest`/`applyTopupToClientLoan`, both called at
disburse time), i.e. the date the loan's tenor/repayment schedule
actually starts counting from.

### New detail endpoint

`LoanRequestService.findById(id: string)`:
```typescript
async findById(id: string) {
  const loanRequest = await this.prisma.loanRequest.findUnique({
    where: { id },
    include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
    omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
  });
  if (!loanRequest) {
    throw new NotFoundException('Loan request not found');
  }
  return { ...loanRequest, availableActions: computeAvailableAdminActions(loanRequest.status) };
}
```
`listAll()` gets the same `availableActions` spread onto each row before
pagination.

`computeAvailableAdminActions(status: LoanRequestStatus): string[]` is a
small exported pure function (new file
`src/loan-request/available-admin-actions.util.ts`), switching on the
four cases above.

New controller route, `AdminLoanRequestController`:
```typescript
@Get(':id')
findOne(@Param('id') id: string) {
  return this.loanRequestService.findById(id);
}
```

## Part 2 — Phone fallback to the linked IppisRecord

`create()`, `createTopup()`, and `resend()` each already fetch
`onboarding.ippisRecord` (the first two already do; `resend()` doesn't
today and needs to start). A new tiny private helper:
```typescript
private resolveSmsPhone(client: { phone: string }, ippisRecord: { phone: string | null }): string {
  return client.phone || ippisRecord.phone || client.phone;
}
```
(`Client.phone` is schema-required and should never actually be empty —
this is a defensive guard, not an expected common path. If both are
somehow empty, the original `client.phone` — an empty string — is passed
through unchanged rather than throwing, so the request still gets
created and the existing email-OTP channel still works even if SMS
silently has nothing to send to.)

`resend()`'s client lookup changes from
`this.prisma.client.findUniqueOrThrow({ where: { id: clientId } })` to
also including `onboarding: { include: { ippisRecord: true } }`, so it
has the same data `create()`/`createTopup()` already have.

All three call sites replace `client.phone` with
`this.resolveSmsPhone(client, onboarding.ippisRecord)` in their
`smsProvider.send(...)` call.

## Part 3A — Admin confirms a PENDING request via OTP

`confirmByCode()` is refactored to extract its shared validation (status
check, hash/expiry check, delegate to `confirmPending`) into a private
helper, so a new admin-facing method can reuse it without the
client-ownership check:

```typescript
async confirmByCode(clientId: string, id: string, code: string): Promise<void> {
  const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
  if (!loanRequest || loanRequest.clientId !== clientId) {
    throw new NotFoundException('Loan request not found');
  }
  await this.verifyCodeAndConfirm(loanRequest, code);
}

async adminConfirmByCode(id: string, code: string): Promise<void> {
  const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
  if (!loanRequest) {
    throw new NotFoundException('Loan request not found');
  }
  await this.verifyCodeAndConfirm(loanRequest, code);
}

private async verifyCodeAndConfirm(loanRequest: LoanRequest, code: string): Promise<void> {
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
```
Admin never resends — only the existing agent/client `resend()` paths do
that (already shipped, confirmed unchanged by this spec). Admin only
submits a code the client has already received and relayed, the same
role the agent already plays today in the agent-initiated flow.

New controller route, `AdminLoanRequestController`:
```typescript
@Post(':id/confirm-code')
@HttpCode(200)
async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
  await this.loanRequestService.adminConfirmByCode(id, dto.code);
  await this.auditLogService.record({
    actorType: AuditActorType.ADMIN,
    actorId: req.user.sub,
    action: 'loan-request.confirm-code',
    targetType: 'LoanRequest',
    targetId: id,
  });
  return { confirmed: true };
}
```
Reuses the existing `ConfirmLoanRequestCodeDto` (already used by the
client and agent confirm-code routes — same `{ code: string }` shape, no
new DTO needed).

## Part 3B — Approve now disburses in one step, with an admin-settable disbursement date

Admin can optionally supply the actual disbursement date (funds often
leave through a channel outside this app, so the recorded date needs to
match reality, not "whenever admin happened to click approve"). This
date drives both `LoanRequest.disbursedAt` and the created `ClientLoan`'s
`disbursementDate` — which matters because `maturationDate` (and so the
whole repayment schedule) is computed as `disbursementDate + tenorMonths`,
so a backdated disbursement must shift the whole schedule back with it,
not just the one timestamp.

New DTO, reused by both the approve and disburse endpoints (identical
shape, both are disbursement-triggering actions):
```typescript
// src/loan-request/dto/disbursement-date.dto.ts
import { IsISO8601, IsOptional } from 'class-validator';

export class DisbursementDateDto {
  @IsOptional()
  @IsISO8601()
  disbursedAt?: string;
}
```

`createClientLoanFromRequest` and `applyTopupToClientLoan` both currently
hardcode `const disbursementDate = new Date();` internally — both gain an
optional parameter instead, defaulting to `new Date()` when omitted (the
existing auto-threshold path in `confirmPending()` calls this with no
argument, so its behavior is unchanged — "now" remains correct there
since that path is fully automatic with no admin involved):
```typescript
private async createClientLoanFromRequest(loanRequestId: string, disbursementDate: Date = new Date()): Promise<void> {
  const loanRequest = await this.prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });
  if (loanRequest.type === LoanRequestType.TOPUP) {
    await this.applyTopupToClientLoan(loanRequest, disbursementDate);
    return;
  }
  // ...unchanged below, just replace the local `const disbursementDate = new Date();`
  // line with using the parameter instead.
```
```typescript
private async applyTopupToClientLoan(loanRequest: LoanRequest, disbursementDate: Date = new Date()): Promise<void> {
  // ...unchanged below, same replacement of the local declaration.
```

`approve()` and `disburse()` both gain an optional `disbursedAt?: Date`
parameter, validated against the future before anything is written:
```typescript
async approve(id: string, disbursedAt?: Date) {
  const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
  if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
    throw new ConflictException('Loan request must be CONFIRMED to approve');
  }
  const disbursementTimestamp = disbursedAt ?? new Date();
  if (disbursementTimestamp.getTime() > Date.now()) {
    throw new BadRequestException('disbursedAt cannot be in the future');
  }

  await this.prisma.loanRequest.update({
    where: { id },
    data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
  });

  const disbursed = await this.prisma.loanRequest.update({
    where: { id },
    data: { status: LoanRequestStatus.DISBURSED, disbursedAt: disbursementTimestamp },
    include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
    omit: { confirmationCodeHash: true, confirmationCodeExpiresAt: true },
  });
  await this.createClientLoanFromRequest(id, disbursementTimestamp);
  return disbursed;
}
```
(The intermediate `APPROVED` write still happens — `approvedAt` is a real,
meaningful timestamp worth keeping even though the row passes through it
in the same call — it's just no longer a resting state a separate manual
action is needed to leave. `approvedAt` itself always stays "now" — it's
the moment admin acted, which is distinct from the backdated
`disbursedAt`.)

`disburse()` gets the identical `disbursedAt?: Date` parameter and
future-date guard, passed through to `createClientLoanFromRequest` the
same way. It's kept as the escape hatch for the `APPROVED` branch of
`availableActions` (defensive, per Part 1) — unchanged in every other
respect.

Both controller routes (`POST :id/approve`, `POST :id/disburse`) gain
`@Body() dto: DisbursementDateDto` and pass
`dto.disbursedAt ? new Date(dto.disbursedAt) : undefined` through.

## Testing

- `available-admin-actions.util.spec.ts` (new): one case per status.
- `loan-request.service.spec.ts`: update `resend()`'s existing tests for
  the new onboarding/ippisRecord include and `resolveSmsPhone` call; add
  a `resolveSmsPhone`-focused test (falls back when `client.phone` is
  empty, prefers `client.phone` when both are present); rewrite the
  `approve` describe block's success test to assert the full
  CONFIRMED→DISBURSED path (two `prisma.loanRequest.update` calls,
  `createClientLoanFromRequest` invoked, final returned row is
  `DISBURSED`) in place of the old CONFIRMED→APPROVED-only assertion;
  add a case asserting a supplied `disbursedAt` is used for both
  `LoanRequest.disbursedAt` and the created `ClientLoan.disbursementDate`/
  `maturationDate` (so the schedule shift is actually exercised, not just
  the timestamp); add a case asserting a future `disbursedAt` throws
  `BadRequestException` before any write happens; add `adminConfirmByCode`
  tests (not-PENDING, wrong/expired code, success) mirroring the existing
  `confirmByCode` tests minus the ownership case; add `findById`/`listAll`
  tests asserting `availableActions` is present and correct per status.
- `admin-loan-request.controller.spec.ts` (new — no existing coverage
  for this controller at all): the new `GET :id` and `POST :id/confirm-code`
  routes, including the audit-log call for the latter.
- e2e: extend `test/loan-origination.e2e-spec.ts`'s existing manual-review
  flow test to assert the response of `approve` is already `DISBURSED`
  (dropping the separate `disburse` call it currently makes afterward,
  since that step no longer applies); add a case for admin confirming a
  `PENDING` request via `confirm-code` (using `EMAIL_CODE_DEV_ECHO`,
  same tolerance pattern already established for the agent-loan-request
  e2e coverage) and a `GET admin/loan-requests/:id` case asserting the
  enriched shape and `availableActions`.

## Postman

Per this project's standing rule: update `Admin > Loan Requests`'s
existing list/approve/reject/disburse saved response examples to reflect
the new enriched shape and `availableActions`; update the approve and
disburse requests' bodies to show the optional `disbursedAt` field; add
a new `GET /admin/loan-requests/:id` request; add a new `POST
/admin/loan-requests/:id/confirm-code` request (success, wrong-code 401,
not-PENDING 409 examples); add a future-dated-`disbursedAt` 400 example
to the approve request.
