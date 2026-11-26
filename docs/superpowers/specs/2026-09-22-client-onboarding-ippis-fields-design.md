# Client Onboarding — IPPIS-Sourced Fields Design (Sub-project C)

## 1. Purpose

The third of three sub-projects extending client onboarding (A: document
collection, already spec'd; B: extended Dojah identity data + marital
status, not yet spec'd). Surfaces three pieces of information already
present in the IPPIS ingestion pipeline but not yet exposed anywhere:
`employeeStatus`, `legacyId` (both already parsed and stored on
`IppisRecord`, just never copied onto `ClientOnboarding`), and a
computed length-of-service derived from `IppisRecord.hireDate`.

**Explicitly deferred**: "Command ID." Research found no such field or
concept anywhere in the IPPIS broadsheet ingestion pipeline
(`src/document-ingestion/parsers/ippis-row-mapper.ts`'s known-header
mapping has no match). The only "Command" reference anywhere in this
codebase is an unmapped `command` column in the *repayment-schedule*
parser's own test fixture (an NPF-specific example, e.g. `command: 'Zone
2'`) — a different ingestion source than IPPIS entirely. You noted
Command ID might simply be the existing `staffId`, and said you'd
clarify the relationship separately — this spec does not guess further;
it's parked as a follow-up once that's confirmed, rather than building
against an assumption that might be wrong.

**Also noted, not this spec**: mid-brainstorming you flagged that
marital status — originally slated for manual client entry in
Sub-project B — is in fact already parsed from the IPPIS broadsheet
(`marital status` header, confirmed populated on `IppisRecord`). This
changes Sub-project B's design (auto-populate from IPPIS, client
confirms/overrides, rather than blank manual entry) — captured here as a
note for that spec, not implemented in this one.

## 2. Schema — copying `employeeStatus`/`legacyId` onto `ClientOnboarding`

Both fields already exist and are already populated on `IppisRecord` by
the broadsheet parser (`src/document-ingestion/parsers/ippis-row-mapper.ts`,
`employee status`/`legacy id` headers) — this is purely about copying
them onto `ClientOnboarding` the same way `employeeName`/`agency`/
`bankName`/`accountNumber` already are, for consistency with that
existing snapshot pattern:

```prisma
  employeeStatus String?
  legacyId       String?
```

`ClientOnboardingService.linkIppis` (`src/client-onboarding/
client-onboarding.service.ts:45-55`) copies these two additional fields
from the linked `IppisRecord` at the same point it already copies the
other four — no new step, no new endpoint, just two more fields in an
existing `create` call.

## 3. Length of service

A pure computed value, not stored — derived from `IppisRecord.hireDate`
at read time:

```typescript
export interface LengthOfService {
  years: number;
  months: number;
}

export function computeLengthOfService(hireDate: Date | null): LengthOfService | null {
  if (!hireDate) {
    return null;
  }
  const now = new Date();
  let months = (now.getFullYear() - hireDate.getFullYear()) * 12 + (now.getMonth() - hireDate.getMonth());
  if (now.getDate() < hireDate.getDate()) {
    months -= 1;
  }
  return { years: Math.floor(months / 12), months: months % 12 };
}
```

(`src/client-onboarding/length-of-service.util.ts` — the only consumers
identified so far are both `ClientOnboarding`-adjacent, so it lives
alongside that module rather than a shared/generic utils location.)

Surfaced in two places, both already returning onboarding data with an
`ippisRecord` relation available (or newly widened to include it):

- **`GET /client/onboarding/status`** (client-facing,
  `ClientOnboardingService.getStatus`) — currently fetches
  `ClientOnboarding` without its `ippisRecord` relation; this adds
  `include: { ippisRecord: true }` and a new `lengthOfService` field in
  the response, computed from `onboarding?.ippisRecord?.hireDate ?? null`.
- **`GET /admin/clients/:id`** (admin-facing,
  `AdminClientReviewService.findById`) — currently does
  `include: { onboarding: true }` (a flat include, no nested
  `ippisRecord`); this widens it to
  `include: { onboarding: { include: { ippisRecord: true } } }` and adds
  the same computed `lengthOfService` field to the response.

## 4. Testing

- Unit: `computeLengthOfService` — null `hireDate` → `null`; exact
  year/month boundaries (e.g. a hire date exactly 2 years and 3 months
  ago); the day-of-month rollback case (hired on the 28th, checked on
  the 15th of a later month — one month short of a naive calendar-month
  subtraction).
- Unit: `linkIppis` copies `employeeStatus`/`legacyId` from the linked
  `IppisRecord` (including the case where either is `null` on the source
  record).
- Unit: `getStatus` and `findById` both include `lengthOfService` in
  their response, computed correctly, `null` when there's no linked
  `IppisRecord` yet.
- e2e: link IPPIS with a record that has `employeeStatus`/`legacyId` set
  → both endpoints reflect the copied values and a non-null
  `lengthOfService`.

## 5. Postman

Per this repo's `CLAUDE.md`: update the existing `GET /client/onboarding/status`
and `GET /admin/clients/:id` saved response examples to include
`employeeStatus`/`legacyId` (on the onboarding object) and the new
`lengthOfService` field — no new endpoints, so no new requests, just
updated examples on existing ones.
