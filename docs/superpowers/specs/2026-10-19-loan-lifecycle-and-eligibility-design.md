# Loan Lifecycle Policy Change & Eligibility-Gated Product Listing — Design

## Overview

Two coupled changes:

1. **Lifecycle policy change**: a client may have exactly one loan in their
   lifetime. Today's rules allow a fresh origination any time the client has
   no *active* loan (i.e. after full repayment, a brand-new loan could be
   created). That's wrong going forward — after a loan closes (balance ≤ 0),
   the only path to more money is a **top-up**, which now acts as a renewal
   of that same lifetime loan rather than an add-on to an outstanding
   balance.
2. **Eligibility-gated product listing**: `GET client/loan-products` (and a
   new agent-facing equivalent, `GET agent/clients/:clientId/loan-products`)
   stops being a plain catalog browse and starts reflecting whether the
   client can actually act right now — which of `NEW_LOAN` or `TOPUP` mode
   applies to them, whether they're currently eligible for it, and if so,
   which products they qualify for.

Explicitly **out of scope** for this spec (separate future specs):
- Deduplicating admin-ingested `Loan` records when the same loan is
  uploaded more than once across batches.
- A unified client loan-history view spanning app-native `ClientLoan`
  cycles and admin-ingested `Loan` records (repayments, renewals, etc. in
  one timeline).

## Part 1 — Lifecycle Policy Change

### Current behavior (for reference)

- `NoActiveLoanRule` (gates `EligibilityService`, used by `create()` /
  fresh origination): blocks if the client has an **ACTIVE** `ClientLoan`,
  a non-terminal `LoanRequest`, or an **ACTIVE** ingested `Loan`
  (`ClientLoansService.hasActiveLoan`).
- `HasActiveLoanRule` (gates `TopupEligibilityService`, used by
  `createTopup()`): requires an **ACTIVE** `ClientLoan` (`status ===
  ACTIVE`, i.e. `principalBalance > 0`).
- `applyTopupToClientLoan`: adds the new amount onto the existing
  `principalAmount`/`principalBalance`/`disbursedAmount`, extends
  `maturationDate` if the new one is later.

### New behavior

**"Has a lifetime loan" becomes a shared concept**, since both rules now
need it. New util:

`src/loan-request/eligibility/has-lifetime-loan.util.ts`
```typescript
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';

export async function hasLifetimeLoan(
  prisma: PrismaService,
  clientLoansService: ClientLoansService,
  clientId: string,
): Promise<boolean> {
  const clientLoan = await prisma.clientLoan.findFirst({
    where: { clientId },
    select: { id: true },
  });
  if (clientLoan) {
    return true;
  }
  return clientLoansService.hasAnyMatchedLoan(clientId);
}
```

**`ClientLoansService` gains two additive methods** (its existing
`hasActiveLoan` — consumed by `client-profile.service.ts`'s `GET client/me`
`hasActiveLoan` field — is untouched; these are new, separate methods, not
a rename):

```typescript
// Unpaginated on purpose — same reasoning as hasActiveLoan above.
async hasAnyMatchedLoan(clientId: string): Promise<boolean> {
  const matched = await this.getMatchedLoansWithStatus(clientId);
  return matched ? matched.loans.length > 0 : false;
}

async hasOutstandingMatchedLoan(clientId: string): Promise<boolean> {
  const matched = await this.getMatchedLoansWithStatus(clientId);
  return matched ? matched.loans.some((loan) => loan.status !== 'CLOSED') : false;
}
```

(`getMatchedLoansWithStatus` is already `private` — these two public
methods are added right after the existing `hasActiveLoan` method, calling
the same private helper, same pattern as today.)

**`NoActiveLoanRule`** (file/class name unchanged — only the logic
changes):
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { hasLifetimeLoan } from './has-lifetime-loan.util';

const NON_TERMINAL_LOAN_REQUEST_STATUSES = [
  LoanRequestStatus.PENDING,
  LoanRequestStatus.CONFIRMED,
  LoanRequestStatus.APPROVED,
];

@Injectable()
export class NoActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const inProgressRequest = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: { in: NON_TERMINAL_LOAN_REQUEST_STATUSES } },
    });
    if (inProgressRequest) {
      return { eligible: false, reason: 'Client already has a loan request in progress' };
    }

    if (await hasLifetimeLoan(this.prisma, this.clientLoansService, client.id)) {
      return { eligible: false, reason: 'Client has already taken a loan — only a renewal is available now' };
    }

    return { eligible: true };
  }
}
```
(`no-active-loan.rule.spec.ts` will need its existing "client already has
an active loan" / "active ingested loan" cases rewritten to match: a
**CLOSED** `ClientLoan` or ingested `Loan` must now also block, where
before only `ACTIVE` blocked.)

**`HasActiveLoanRule`** (file/class name unchanged — only the logic
changes; gains a new `ClientLoansService` constructor dependency):
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class HasActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const latestClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id },
      orderBy: { disbursementDate: 'desc' },
    });

    if (latestClientLoan) {
      if (Number(latestClientLoan.principalBalance) > 0) {
        return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
      }
      return { eligible: true };
    }

    if (await this.clientLoansService.hasOutstandingMatchedLoan(client.id)) {
      return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
    }
    if (!(await this.clientLoansService.hasAnyMatchedLoan(client.id))) {
      return { eligible: false, reason: 'Client has no existing loan to renew' };
    }

    return { eligible: true };
  }
}
```
(`has-active-loan.rule.spec.ts` rewritten: the old "no active loan at all →
ineligible" case is replaced by "no `ClientLoan` and no matched ingested
loan at all → ineligible"; the old "has an active loan → eligible" case
flips to "has an active (balance > 0) loan → ineligible"; new cases added
for "has a closed `ClientLoan` → eligible" and the ingested-only variants.)

**`LoanRequestService.createTopup`** — needs to stop requiring an
**ACTIVE** `ClientLoan` to exist (that row may not exist yet, for an
ingested-only lifetime loan), and instead look up whichever `ClientLoan`
row exists, if any:
```typescript
async createTopup(clientId: string, amount: number, tenorMonths: number) {
  const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  const onboarding = await this.prisma.clientOnboarding.findUnique({
    where: { clientId },
    include: { ippisRecord: true },
  });
  if (!onboarding) {
    throw new ConflictException('Client has not completed onboarding');
  }

  const eligibility = await this.topupEligibilityService.check(client, onboarding.ippisRecord, amount);
  if (!eligibility.eligible) {
    throw new UnprocessableEntityException(eligibility.reason);
  }

  const existingClientLoan = await this.prisma.clientLoan.findFirst({
    where: { clientId },
    orderBy: { disbursementDate: 'desc' },
  });

  const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

  const managementChargeAmount =
    product.managementChargeType === ManagementChargeType.PERCENTAGE
      ? (amount * Number(product.managementChargeValue)) / 100
      : Number(product.managementChargeValue);

  await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
  await this.sendEmailCopy(client.email, amount, LoanRequestType.TOPUP);

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
    },
  });

  await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

  return loanRequest;
}
```
(Only change from today: `findFirstOrThrow({ where: { clientId, status:
ACTIVE } })` → `findFirst({ where: { clientId }, orderBy: {
disbursementDate: 'desc' } })`, and `topupTargetId: activeLoan.id` →
`topupTargetId: existingClientLoan?.id` — now optional.)

**`applyTopupToClientLoan`** — resets in place when a target exists;
creates the client's first `ClientLoan` row when it doesn't:
```typescript
private async applyTopupToClientLoan(loanRequest: LoanRequest): Promise<void> {
  const topupAmount = Number(loanRequest.amount);
  const managementChargeAmount = Number(loanRequest.managementChargeAmount);
  const disbursedAmount =
    loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
      ? topupAmount - managementChargeAmount
      : topupAmount;

  const disbursementDate = new Date();
  const maturationDate = new Date(disbursementDate);
  maturationDate.setMonth(maturationDate.getMonth() + loanRequest.tenorMonths);

  const fields = {
    principalAmount: topupAmount,
    disbursedAmount,
    principalBalance: topupAmount,
    tenorMonths: loanRequest.tenorMonths,
    interestRatePercent: loanRequest.interestRatePercent,
    managementChargeType: loanRequest.managementChargeType,
    managementChargeValue: loanRequest.managementChargeValue,
    managementChargeApplication: loanRequest.managementChargeApplication,
    managementChargeAmount,
    disbursementDate,
    maturationDate,
    status: ClientLoanStatus.ACTIVE,
  };

  if (loanRequest.topupTargetId) {
    await this.prisma.clientLoan.update({ where: { id: loanRequest.topupTargetId }, data: fields });
    return;
  }

  const onboarding = await this.prisma.clientOnboarding.findUniqueOrThrow({
    where: { clientId: loanRequest.clientId },
    include: { ippisRecord: true },
  });

  await this.prisma.clientLoan.create({
    data: {
      clientId: loanRequest.clientId,
      loanRequestId: loanRequest.id,
      agency: onboarding.ippisRecord.agency,
      staffId: onboarding.ippisRecord.staffId,
      ...fields,
    },
  });
}
```
(This replaces the current additive version entirely — new fields
`status: ClientLoanStatus.ACTIVE` added explicitly since a renewed loan
must flip back from `CLOSED` to `ACTIVE`, which the old code never had to
do since it only ever ran against already-`ACTIVE` rows.)

## Part 2 — Eligibility-Gated Product Listing

### Response shape

Replaces the bare `PaginatedResult<LoanProduct>` that `GET
client/loan-products` returns today:
```typescript
export interface EligibleLoanProductsResult {
  mode: 'NEW_LOAN' | 'TOPUP';
  eligible: boolean;
  reason?: string;
  data: LoanProduct[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}
```
`reason` is present only when `eligible` is `false`. `data` is `[]`
whenever `eligible` is `false`.

### `LoanProductsService`

`listActiveForClient` is replaced by `listEligibleForClient`. New
constructor dependencies: `EligibilityService`, `TopupEligibilityService`,
`ClientLoansService` (all already exist; just newly injected here):

```typescript
constructor(
  private readonly prisma: PrismaService,
  private readonly loanSettingsService: LoanSettingsService,
  private readonly eligibilityService: EligibilityService,
  private readonly topupEligibilityService: TopupEligibilityService,
  private readonly clientLoansService: ClientLoansService,
) {}
```

```typescript
export interface ListEligibleLoanProductsFilters {
  amount?: number;
}

async listEligibleForClient(
  clientId: string,
  filters: ListEligibleLoanProductsFilters = {},
  pagination: { page: number; limit: number } = { page: 1, limit: 25 },
): Promise<EligibleLoanProductsResult> {
  const { page, limit } = pagination;
  const emptyMeta = buildPaginatedResult<LoanProduct>([], 0, page, limit).meta;

  const onboarding = await this.prisma.clientOnboarding.findUnique({
    where: { clientId },
    include: { ippisRecord: true },
  });
  if (!onboarding) {
    return { mode: 'NEW_LOAN', eligible: false, reason: 'Client has not completed onboarding', data: [], meta: emptyMeta };
  }

  const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  const mode: 'NEW_LOAN' | 'TOPUP' = (await hasLifetimeLoan(this.prisma, this.clientLoansService, clientId))
    ? 'TOPUP'
    : 'NEW_LOAN';

  const eligibility =
    mode === 'TOPUP'
      ? await this.topupEligibilityService.check(client, onboarding.ippisRecord, 0)
      : await this.eligibilityService.check(client, onboarding.ippisRecord, 0);

  if (!eligibility.eligible) {
    return { mode, eligible: false, reason: eligibility.reason, data: [], meta: emptyMeta };
  }

  const settings = await this.loanSettingsService.get();
  const { monthsLeft, monthsServed } = computeServiceWindow(
    onboarding.ippisRecord.dateOfBirth,
    onboarding.ippisRecord.hireDate,
    settings.retirementAgeYears,
    settings.maxServiceYears,
  );

  const candidates = await this.prisma.loanProduct.findMany({
    where: {
      isActive: true,
      sectors: { has: onboarding.ippisRecord.agency },
      ...(filters.amount !== undefined
        ? { minimumAmount: { lte: filters.amount }, maximumAmount: { gte: filters.amount } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  const eligibleProducts = candidates.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));

  const total = eligibleProducts.length;
  const data = eligibleProducts.slice((page - 1) * limit, (page - 1) * limit + limit);

  return { mode, eligible: true, data, meta: buildPaginatedResult(data, total, page, limit).meta };
}
```

`hasLifetimeLoan` is imported from
`../loan-request/eligibility/has-lifetime-loan.util` (Part 1).

### DTO change

`src/loan-products/dto/list-client-loan-products-query.dto.ts`:
```typescript
import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListClientLoanProductsQueryDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}
```

### Controllers

`ClientLoanProductsController` (unchanged route/guard, just the call and
response shape):
```typescript
@Get()
list(@Query() query: ListClientLoanProductsQueryDto, @Req() req: { user: JwtPayload }) {
  return this.loanProductsService.listEligibleForClient(
    req.user.sub,
    { amount: query.amount },
    { page: query.page, limit: query.limit },
  );
}
```

New `src/loan-products/agent-loan-products.controller.ts`:
```typescript
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProductsService } from './loan-products.service';
import { ListClientLoanProductsQueryDto } from './dto/list-client-loan-products-query.dto';

@Controller('agent/clients/:clientId/loan-products')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentLoanProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanProductsService: LoanProductsService,
  ) {}

  @Get()
  async list(
    @Param('clientId') clientId: string,
    @Query() query: ListClientLoanProductsQueryDto,
    @Req() req: { user: JwtPayload },
  ) {
    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: req.user.sub } },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Client not found');
    }

    return this.loanProductsService.listEligibleForClient(
      clientId,
      { amount: query.amount },
      { page: query.page, limit: query.limit },
    );
  }
}
```
(Ownership check mirrors `AgentClientsService.listMyClients`'s existing
`onboarding: { onboardedByAgentId: agentId }` where-clause exactly — same
scoping, same "not found" treatment for a client that exists but isn't
this agent's.)

### Module wiring

`LoanRequestModule` currently has no `exports` array — add one so
`EligibilityService`/`TopupEligibilityService` are available outside the
module:
```typescript
exports: [EligibilityService, TopupEligibilityService],
```

`LoanProductsModule` — needs `ClientLoansModule` imported directly too
(Nest doesn't transitively re-export a nested module's providers just
because `LoanRequestModule` happens to import `ClientLoansModule` for its
own use; only providers a module's own `exports` array lists are visible
to importers):
```typescript
@Module({
  imports: [LoanSettingsModule, LoanRequestModule, ClientLoansModule],
  controllers: [AdminLoanProductsController, ClientLoanProductsController, AgentLoanProductsController],
  providers: [LoanProductsService],
  exports: [LoanProductsService],
})
export class LoanProductsModule {}
```
(No circular import: `LoanRequestModule` imports `TwoWaySmsModule`,
`ClientLoansModule`, `AuditModule`, `WalletModule`, `EmailModule`,
`LoanSettingsModule` — none of those is `LoanProductsModule`.)

## Testing

- `has-lifetime-loan.util.spec.ts` (new): both `ClientLoan`-exists and
  ingested-only-match branches.
- `no-active-loan.rule.spec.ts` (rewritten): closed `ClientLoan` now
  blocks (previously only active did); non-terminal request still blocks;
  ingested-only match (any status) now blocks.
- `has-active-loan.rule.spec.ts` (rewritten): active (balance > 0)
  `ClientLoan` now blocks (flipped from today); closed `ClientLoan` is now
  eligible; no `ClientLoan` + outstanding ingested match blocks; no
  `ClientLoan` + closed-only ingested match is eligible; genuinely nothing
  on record is ineligible with the new "nothing to renew" reason.
- `client-loans.service.spec.ts`: new cases for `hasAnyMatchedLoan` /
  `hasOutstandingMatchedLoan`.
- `loan-request.service.spec.ts`: `createTopup` no longer throws when
  there's no `ClientLoan` row; `applyTopupToClientLoan` (exercised via
  `confirmByPhone`'s auto-approve path, same as today's tests) covers both
  the reset-in-place and first-row-creation branches.
- `loan-products.service.spec.ts`: `listEligibleForClient` covers all
  combinations — not onboarded; `NEW_LOAN` + eligible/ineligible; `TOPUP` +
  eligible/ineligible; `?amount=` narrowing; pagination.
- e2e: extend `test/loan-topup.e2e-spec.ts` for the renewal-at-$0 case and
  the now-blocked mid-repayment case; extend `test/admin-loan-products.e2e-spec.ts`
  or add `test/client-loan-products.e2e-spec.ts` (check which already
  exists) for the gated response shape; new e2e coverage for
  `GET agent/clients/:clientId/loan-products` including the 404
  not-my-client case.

## Postman

Per this project's standing rule, `postman/public-sector-backend.postman_collection.json`
must be updated in the same change: `GET client/loan-products`'s saved
response examples need the new `mode`/`eligible`/`reason` wrapper, and a
new `GET agent/clients/:clientId/loan-products` request (with success,
404-not-your-client, and ineligible-empty-list scenarios) needs adding
under Agent's appropriate sub-folder.
