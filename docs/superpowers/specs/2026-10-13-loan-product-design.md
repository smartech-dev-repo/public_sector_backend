# Loan Product Design

## 1. Purpose

Today, loan terms are configured via `LoanTermOption` — one flat
`interestRatePercent` per exact `(agency, tenorMonths)` pair, with a
separate, blunt `LOAN_SALARY_MULTIPLE_CAP` env var capping the amount a
client can borrow (explicitly marked "provisional" in `.env.example`).
Eligibility (`src/loan-request/eligibility/`) and "which rate applies"
(`LoanTermOption` lookup) are two entirely separate concerns today.

This replaces both with a single **Loan Product** entity that is itself
the qualification mechanism: an admin defines a product's eligible
sectors (IPPIS agencies), amount range, tenor range, a dynamic set of
tenor-range-to-interest-rate tiers, and service-length bounds, and a
client's loan request is resolved against whichever product structurally
and eligibility-wise matches.

## 2. Schema

```prisma
model LoanProduct {
  id                           String                       @id @default(uuid())
  productName                  String
  productCode                  String                       @unique
  sectors                      String[]
  minimumAmount                Decimal
  maximumAmount                Decimal
  minimumTenorMonths           Int
  maximumTenorMonths           Int
  interestTiers                Json
  managementChargeType         ManagementChargeType
  managementChargeValue        Decimal
  managementChargeApplication  ManagementChargeApplication
  minimumServiceMonthsLeft     Int?
  maximumMonthsInService       Int?
  isActive                     Boolean                      @default(true)
  createdAt                    DateTime                     @default(now())
  updatedAt                    DateTime                     @updatedAt
}

model LoanSettings {
  id                 String   @id @default(uuid())
  retirementAgeYears Int      @default(60)
  maxServiceYears    Int      @default(35)
  updatedAt          DateTime @updatedAt
}
```

`LoanTermOption` is dropped in the same migration. Every existing row in
it is e2e-test/dev fixture data (confirmed: `NPF` with various
`tenorMonths` from this session's own test runs, `WAVE3-NPF`/
`WAVE3-NSCDC` from `admin-loan-terms.e2e-spec.ts`) — there is no real
admin-entered production config to migrate forward. If that assumption is
wrong, say so before implementation starts.

`sectors` is a plain Postgres `String[]` (via Prisma's native array
support), matching the existing convention of agency being a free-text
string throughout this codebase (not FK'd to an enum/lookup table).

`interestTiers` shape (stored as `Json`, validated at the application
layer — Prisma/Postgres `Json` columns aren't schema-validated):

```typescript
export interface InterestTier {
  minTenorMonths: number;
  maxTenorMonths: number;
  interestRatePercent: number;
}
```

**Validation rules on `interestTiers`** (enforced in the create/update DTO,
not the DB): every tier's `[minTenorMonths, maxTenorMonths]` must fall
within the product's own `[minimumTenorMonths, maximumTenorMonths]`; no
two tiers may overlap; gaps between tiers are allowed (a tenor falling in
a gap simply has no rate — rejected at request time, not rounded to a
neighboring tier, matching your 0-4/6-12/13-18 example which skips month 5
and anything past 18).

**Two decisions made by omission, not asked about — flag if wrong:**
management charge (`managementChargeType`/`Value`/`Application`) stays
**flat per product**, not per tier, since only interest was described as
varying by tenor. `minimumServiceMonthsLeft`/`maximumMonthsInService` are
both nullable — a product that sets neither skips the service-length
check entirely.

## 3. `LoanSettings` — lazy-initialized singleton

```typescript
@Injectable()
export class LoanSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<LoanSettings> {
    const existing = await this.prisma.loanSettings.findFirst();
    if (existing) return existing;
    return this.prisma.loanSettings.create({ data: {} }); // schema defaults: 60 / 35
  }

  async update(input: { retirementAgeYears?: number; maxServiceYears?: number }): Promise<LoanSettings> {
    const current = await this.get();
    return this.prisma.loanSettings.update({ where: { id: current.id }, data: input });
  }
}
```

No create endpoint — `GET /admin/loan-settings` and
`PATCH /admin/loan-settings { retirementAgeYears?, maxServiceYears? }`,
gated by a new `loan-settings:manage` permission (separate from
`loan-products:manage` — changing this affects every product's
eligibility at once, more sensitive, one-permission-per-capability
convention).

## 4. Service-length computation

```typescript
export interface ServiceWindow {
  monthsLeft: number | null;
  monthsServed: number | null;
}

export function computeServiceWindow(
  dateOfBirth: Date | null,
  hireDate: Date | null,
  retirementAgeYears: number,
  maxServiceYears: number,
): ServiceWindow {
  const now = new Date();
  const byAge = dateOfBirth ? addYears(dateOfBirth, retirementAgeYears) : null;
  const byService = hireDate ? addYears(hireDate, maxServiceYears) : null;
  const candidates = [byAge, byService].filter((d): d is Date => d !== null);
  const retirementDate = candidates.length > 0
    ? candidates.reduce((earliest, d) => (d < earliest ? d : earliest))
    : null;

  return {
    monthsLeft: retirementDate ? monthsBetween(now, retirementDate) : null,
    monthsServed: hireDate ? monthsBetween(hireDate, now) : null,
  };
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
```

New file: `src/loan-request/eligibility/compute-service-window.util.ts`.
Uses whichever of the age-based / service-based retirement date is
earlier and actually computable — if only one of `dateOfBirth`/`hireDate`
is on file, that one alone determines it. `monthsServed` is independent of
the retirement-date logic (always derivable from `hireDate` alone, same
basis `computeLengthOfService` already uses elsewhere, just as a single
month count instead of `{years, months}`).

## 5. `LoanProductResolverService` — replaces the term lookup and the retired salary-cap rule

New file `src/loan-request/eligibility/loan-product-resolver.service.ts`:

```typescript
@Injectable()
export class LoanProductResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
  ) {}

  async resolve(ippisRecord: IppisRecord, amount: number, tenorMonths: number): Promise<{ product: LoanProduct; tier: InterestTier }> {
    const structuralMatches = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: ippisRecord.agency },
        minimumAmount: { lte: amount },
        maximumAmount: { gte: amount },
        minimumTenorMonths: { lte: tenorMonths },
        maximumTenorMonths: { gte: tenorMonths },
      },
    });
    if (structuralMatches.length === 0) {
      throw new UnprocessableEntityException('No loan product matches this amount/tenor for your agency');
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      ippisRecord.dateOfBirth,
      ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const eligibleMatches = structuralMatches.filter((p) =>
      (p.minimumServiceMonthsLeft == null || (monthsLeft != null && monthsLeft >= p.minimumServiceMonthsLeft)) &&
      (p.maximumMonthsInService == null || (monthsServed != null && monthsServed <= p.maximumMonthsInService)),
    );
    if (eligibleMatches.length === 0) {
      throw new UnprocessableEntityException('Not eligible for any matching loan product based on service length');
    }
    if (eligibleMatches.length > 1) {
      throw new UnprocessableEntityException('Multiple loan products match this request — ambiguous configuration, contact an admin');
    }

    const product = eligibleMatches[0];
    const tiers = product.interestTiers as unknown as InterestTier[];
    const tier = tiers.find((t) => tenorMonths >= t.minTenorMonths && tenorMonths <= t.maxTenorMonths);
    if (!tier) {
      throw new UnprocessableEntityException(`No interest rate configured for ${tenorMonths} months under this product`);
    }

    return { product, tier };
  }
}
```

**`LoanRequestService.create`/`createTopup`** change: the block

```typescript
const termOption = await this.prisma.loanTermOption.findUnique({
  where: { agency_tenorMonths: { agency: onboarding.ippisRecord.agency, tenorMonths } },
});
if (!termOption || !termOption.isActive) {
  throw new UnprocessableEntityException(`No active loan term available for ${tenorMonths} months`);
}
```

becomes

```typescript
const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);
```

and every subsequent reference to `termOption.interestRatePercent` becomes
`tier.interestRatePercent`; `termOption.managementChargeType/Value/Application`
becomes `product.managementChargeType/Value/Application` — otherwise
`managementChargeAmount`'s calculation and the `LoanRequest.create` data
block are unchanged.

**`AmountWithinSalaryCapRule` and `LOAN_SALARY_MULTIPLE_CAP` are deleted**
(file, its spec, its registration in `EligibilityService`/
`TopupEligibilityService`, the env var in `.env`/`.env.example`) — the
resolver's `minimumAmount`/`maximumAmount` range is the replacement, per
your confirmation that this was the "real ratio" the provisional env var
was always meant to be superseded by.

`ClientMustBeVerifiedRule`, `NoActiveLoanRule`, `HasActiveLoanRule`,
`NoTopupInProgressRule` are **unchanged** — they stay in
`EligibilityService`/`TopupEligibilityService`'s rule chains exactly as
today, run before the new resolver.

## 6. Sectors lookup endpoint

An admin building a product's `sectors` list needs to know the valid
values. Today the set of recognized agencies is hardcoded independently
in two places that have already drifted apart:
`ippis-broadsheet.parser.ts`'s `KNOWN_AGENCIES` (4: NPF, NSCDC,
IMMIGRATION, CORRECTIONAL) and `repayment-row-mapper.ts`'s `AgencyKey`
type / `repayment-schedule.parser.ts`'s `KNOWN_AGENCIES` (6: adds CUSTOM,
LASG). That drift is pre-existing and out of scope here — not touched by
this change.

New shared constant, `src/common/known-agencies.constant.ts`:

```typescript
export const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'] as const;
export type KnownAgency = (typeof KNOWN_AGENCIES)[number];
```

Sourced from the broader (6-agency) existing list, since a loan product's
`sectors` conceptually spans every agency the system recognizes at all,
not just the subset `ippis-broadsheet` parsing happens to handle.

New endpoint: `GET /admin/loan-products/sectors` (same `loan-products:manage`
permission), returning `{ sectors: KNOWN_AGENCIES }` — lets the admin UI
populate a `sectors` picker when creating/editing a product, instead of
hardcoding or guessing valid values.

## 7. API surface

- `admin/loan-terms` → **`admin/loan-products`**: `POST` (validates tier
  bounds/overlap as in §2, rejects duplicate `productCode` via the shared
  `isUniqueConstraintError` → `409`), `GET` (paginated, filterable by
  `sectors`/`isActive`), `PATCH /:id`. Permission renamed
  `loan-terms:manage` → `loan-products:manage` (seed entry updated in
  place — existing role-permission assignments pointing at the old
  `Permission` row would otherwise dangle; the seed script's upsert-by-key
  means renaming the `key` value creates a *new* permission row rather
  than renaming in place, so any role currently holding `loan-terms:manage`
  needs it re-granted as `loan-products:manage` — called out explicitly
  so it isn't missed during rollout).
- `client/loan-terms` → **`client/loan-products`**: lists active products
  matching the client's own `IppisRecord.agency` *and* their service-length
  eligibility (computed the same way as §5, no amount/tenor filter since
  the client hasn't chosen those yet), each with its full `interestTiers`
  array so the client can see what rate applies before picking a
  `tenorMonths`.
- `POST /client/loan-requests` / the topup equivalent — **contract
  unchanged** (`amount`, `tenorMonths`); internally resolves via §5.
- New `admin/loan-settings` (`GET`/`PATCH`) per §3.

## 8. Testing

- Unit: `computeServiceWindow` — both dates present (earlier of the two
  wins); only `dateOfBirth`; only `hireDate`; neither (both results
  `null`).
- Unit: `LoanProductResolverService.resolve` — zero structural matches;
  structural match but service-length excludes it; exactly one eligible
  match resolves correctly; more than one eligible match throws the
  ambiguous-configuration error; eligible product but `tenorMonths` falls
  in a tier gap.
- Unit: `LoanSettingsService` — `get()` creates-with-defaults on first
  call, returns the same row on subsequent calls; `update()` persists
  partial changes.
- Unit: product create/update DTO validation — overlapping tiers
  rejected; a tier outside `[minimumTenorMonths, maximumTenorMonths]`
  rejected; duplicate `productCode` → `ConflictException` (409).
- Unit: `LoanRequestService.create`/`createTopup` — updated to mock
  `LoanProductResolverService` instead of `prisma.loanTermOption`;
  `AmountWithinSalaryCapRule`'s own spec file is deleted along with it.
- e2e: full loan-request journey using a `LoanProduct` fixture instead of
  `LoanTermOption`; `admin/loan-settings` GET/PATCH roundtrip;
  `client/loan-products` reflects a client's own agency/eligibility only.

## 9. Postman

Per this repo's `CLAUDE.md`: "Loan Terms" folder (both Admin and Client
groups) renamed to "Loan Products," all saved examples rewritten to the
new shapes; new "Loan Settings" sub-folder under Admin
(`GET`/`PATCH admin/loan-settings`, success + `403` + validation
examples); new `GET /admin/loan-products/sectors` request (success +
`403` examples).

## 10. Out of scope

- Migrating existing `LoanTermOption` rows into equivalent `LoanProduct`
  rows (§2 — none are believed to be real production config).
- Per-tier management charges (§2).
- Any UI/analytics around which product a client ended up matched to
  beyond what the resolved `LoanRequest` already snapshots today.
