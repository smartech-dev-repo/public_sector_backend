# Client Loan Dashboard/History — Design

**Date:** 2026-09-17
**Status:** Approved for planning
**Depends on:** Client/IPPIS Onboarding Pipeline (built, shipped) for the `ClientOnboarding`↔`IppisRecord` link; Document Ingestion (built, shipped) for the `Loan`/`LoanRepaymentRecord` data being surfaced.

This is sub-project 3 of 3 in the "Client Onboarding, Login, and Loan Request" feature. Sub-projects 1 (Onboarding) and 2 (Loan Request & Confirmation Workflow) are both done.

## 1. Purpose and scope

Let a client see their own pre-existing loan history — real disbursed loans and repayment activity ingested from bank reports, which predate this platform and have no direct database link to `Client`. This is deliberately a separate concern from `GET /client/loan-requests` (a client's own in-platform loan applications, already shipped) — one surfaces historical/external data, the other surfaces requests made through this system.

**In scope:**
- `GET /client/loans` — returns the calling client's matched `Loan` rows and `LoanRepaymentRecord` rows.
- A matching strategy that bridges `Client` to this historical data via the client's linked `IppisRecord` (`agency` + `staffId`), with a BVN cross-check against `Loan.bvn` where both sides have one, to guard against an `agency`+`staffId` collision showing one client someone else's loan.

**Explicitly out of scope / deferred:**
- Any combination with `GET /client/loan-requests` — these stay two separate endpoints/concerns, per your decision.
- Admin-facing views of this same data (already reachable today via the existing document-ingestion admin endpoints).
- Pagination — `Loan`/`LoanRepaymentRecord` per agency+staffId is expected to be a small set per client (a handful of loans, a bounded number of repayment line items); unpaginated for now, matching every other client-facing list endpoint in this codebase (`GET /client/loan-requests` is also unpaginated).

## 2. Matching strategy

`Loan` and `LoanRepaymentRecord` were ingested from bank reports independently of `Client`/`IppisRecord` and carry no foreign key to either. The bridge:

```
Client → ClientOnboarding.ippisRecordId → IppisRecord.{agency, staffId}
```

1. **Primary match** — `Loan.agency === ippisRecord.agency AND Loan.ippisNumber === ippisRecord.staffId` (the same `agency`+IPPIS-number pairing `LoanRowMapper` already derives during ingestion — `ippisNumber` and `staffId` are the same real-world identifier, just named differently per model). `LoanRepaymentRecord.agency`/`.staffId` use the identical field names, so the same pair applies directly.
2. **BVN cross-check (Loan only — `LoanRepaymentRecord` has no `bvn` field)** — when **both** `ClientOnboarding.bvn` (the client's own Dojah-verified BVN, captured during onboarding) and `Loan.bvn` (whatever the bank's report carried) are present, they must match, or that `Loan` row is excluded from the result. This deliberately compares two *independently sourced* BVNs (the client's own verified submission vs. the bank's ingested record) rather than comparing `IppisRecord.bvn` against `Loan.bvn` (both would just be reflecting the same government broadsheet data used for the primary match, so agreement there proves nothing new).
3. If either side lacks a BVN to compare (e.g. `Loan.bvn` wasn't populated in that ingestion, or the client hasn't reached `bvn` submission yet), the primary `agency`+`staffId` match alone stands — there's nothing to cross-check against.
4. A client with no `ClientOnboarding` row yet (hasn't linked IPPIS) has no `agency`/`staffId` to match against at all — the endpoint returns empty lists, not an error (this is a read endpoint; "nothing to show yet" isn't a failure).

## 3. Endpoint

`GET /client/loans` (Client JWT via `ClientOnlyGuard`, same as the loan-request endpoints) →

```json
{
  "loans": [ /* full Loan rows minus `rawFields` (internal ingestion artifact), most recent disbursementDate first */ ],
  "repayments": [ /* full LoanRepaymentRecord rows minus `rawFields`, most recent createdAt first */ ]
}
```

No query params, no body. Not gated on `Client.status` (unlike loan requests) — this is informational history, not an action requiring eligibility; a client mid-onboarding can still see it (though in practice they'd have no `ClientOnboarding` row yet if they haven't linked IPPIS, so it'd just be empty).

## 4. Error handling

- No `ClientOnboarding` row → `200` with `{ loans: [], repayments: [] }` (§2 point 4).
- No matching `Loan`/`LoanRepaymentRecord` rows found → `200` with empty arrays (never a `404` — "no history yet" is a normal state, not a missing resource).
- A `Loan` row failing the BVN cross-check is silently excluded, not surfaced as a partial/flagged result — the client never needs to know a same-agency/staffId collision almost showed them someone else's data.

## 5. Testing strategy

Unit tests for the matching service (mocked Prisma): primary-match success, BVN-cross-check exclusion when both sides present and mismatched, pass-through when either side lacks a BVN, empty result when no `ClientOnboarding` exists, empty result when no `Loan`/`LoanRepaymentRecord` rows match. One e2e test: seed a matching `IppisRecord` + `Loan` + `LoanRepaymentRecord` (via direct Prisma writes, same fixture style as `test/loan-request.e2e-spec.ts`) for a `ClientOnboarding`-linked client, call `GET /client/loans`, assert both collections are returned; a second case seeds a same-agency/staffId `Loan` with a mismatched `bvn` and asserts it's excluded.
