# Admin Manual-Review Queue for Client Onboarding — Design

**Date:** 2026-09-17
**Status:** Approved for planning
**Depends on:** Client/IPPIS Onboarding Pipeline (`docs/superpowers/specs/2026-09-17-client-onboarding-pipeline-design.md`, built and shipped).
**Closes out:** Phase 3 of the original spec (`docs/specs/2026-09-09-public-sector-backend-spec.md` §5, §7) — the one piece of that phase left unbuilt: "System calls a pluggable `IdentityVerificationProvider`... If any step fails or is inconclusive, the Client moves to `status = MANUAL_REVIEW`... visible to Admins holding `clients:review`." The `clients:review` permission has been seeded since Phase 1 and has never gated a real route until now.

## 1. Purpose and scope

Give admins holding `clients:review` a way to see and act on clients stuck at `MANUAL_REVIEW`, and fix a gap discovered while designing this: `Client.status` currently sits frozen at `PHONE_VERIFIED` through the entire onboarding pipeline (the `PENDING_IPPIS` enum value has never actually been set by any code).

**In scope:**
- `ClientOnboardingService.linkIppis` sets `Client.status = PENDING_IPPIS` once IPPIS linking succeeds (previously left unset).
- `ClientOnboarding` gains `reviewedBy`/`reviewedAt`/`reviewNote` fields.
- `GET /admin/clients` (filterable by status), `GET /admin/clients/:id` (full detail), `POST /admin/clients/:id/approve`, `POST /admin/clients/:id/retry` — all gated by the existing `clients:review` permission.
- Retry auto-infers which step to reset to from `ClientOnboarding.failureReasons`, rather than requiring the admin to specify it.

**Explicitly out of scope / deferred:**
- Any permanent "rejected" terminal status — per your decision, review outcomes are approve or retry-with-reset only; a client is never permanently locked out by this feature.
- Loan request/list data on the client detail view — a separate future sub-project (Loan Dashboard); this view stays scoped to onboarding/review data, though its response shape doesn't preclude adding a `loans` section later without a breaking change.
- Any change to the automated pipeline's own pass/fail logic (`ClientOnboardingService.submitIdentity`/`submitFaceMatch`) beyond the `PENDING_IPPIS` fix — this is a review *queue* on top of the existing pipeline, not a rework of it.

## 2. Schema changes

`ClientOnboarding` (already exists) gains three fields:

```prisma
model ClientOnboarding {
  // ...existing fields unchanged...
  reviewedBy String?
  reviewedAt DateTime?
  reviewNote String?
}
```

No new enum, no new model — `ClientStatus` (`PHONE_VERIFIED | PENDING_IPPIS | MANUAL_REVIEW | VERIFIED`) is used as originally defined, just actually exercised now.

## 3. The `PENDING_IPPIS` fix

`ClientOnboardingService.linkIppis` currently only writes to `ClientOnboarding`; it never touches `Client.status`. Add one line: after successfully creating the `ClientOnboarding` row, update `Client.status = PENDING_IPPIS`. This is the only change to the already-shipped pipeline code — `submitIdentity` and `submitFaceMatch` are untouched, since they already correctly resolve to `VERIFIED`/`MANUAL_REVIEW`.

## 4. Endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/clients` | `clients:review` | Filterable by `status` (query param), matching `GET /admin/documents/batches`'s existing filter convention. Returns `Client` rows with their `ClientOnboarding.step`/`failureReasons` joined in. |
| `GET /admin/clients/:id` | `clients:review` | Full detail: `Client` + complete `ClientOnboarding` row (pulled IPPIS snapshot fields, `bvn`/`nin`, `bvnSelfie`/`ninSelfie`/`liveSelfieKey` storage keys — not the raw images inline; an admin fetches those via the existing `GET /admin/documents/files/:key` download endpoint, same as any other stored file in this system — `identityVerified`, `faceMatchPassed`, `failureReasons`, `reviewedBy`/`reviewedAt`/`reviewNote`). **Note**: that download endpoint is gated by `documents:read`, not `clients:review` — a "Client Reviewer" admin role needs both permissions assigned to actually view the selfie images, not just `clients:review` alone. No code change to that endpoint is proposed here; this is a role-assignment note, not a gap to fix. |
| `POST /admin/clients/:id/approve` | `clients:review` | No body. Only valid when `Client.status === MANUAL_REVIEW` (409 otherwise). Sets `Client.status = VERIFIED`, `ClientOnboarding.step = COMPLETED`, records `reviewedBy` (the acting admin's id) and `reviewedAt`. |
| `POST /admin/clients/:id/retry` | `clients:review` | Body `{ note: string }` (required — matches the original spec's "required reason on rejection" precedent from Agent review, applied here to retry instead since there's no rejection path). Only valid when `Client.status === MANUAL_REVIEW`. |

## 5. Retry step inference

`ClientOnboarding.failureReasons` (already populated by `submitFaceMatch`) has the shape `{ identityVerified: boolean, faceMatchPassed: boolean }`. `retry` reads it to decide where to reset:

- `identityVerified === false` → reset to `step = IPPIS_LINKED`, clear `bvn`/`nin`/`bvnSelfie`/`ninSelfie`/`identityVerified`/`liveSelfieKey`/`faceMatchBvnScore`/`faceMatchNinScore`/`faceMatchPassed` (the client must resubmit identity from scratch — a bad BVN/NIN lookup invalidates everything downstream of it too).
- `identityVerified === true` but `faceMatchPassed === false` → reset to `step = IDENTITY_SUBMITTED`, clear only `liveSelfieKey`/`faceMatchBvnScore`/`faceMatchNinScore`/`faceMatchPassed` (BVN/NIN and their reference photos stay valid; the client only needs to retake their live selfie).

Either way: `Client.status = PENDING_IPPIS`, `failureReasons = null`, `reviewedBy`/`reviewedAt`/`reviewNote` recorded on the `ClientOnboarding` row (the review history isn't wiped even though the pipeline fields are — an admin looking at the client later can still see who sent them back and why, via `reviewedBy`/`reviewedAt`/`reviewNote`, even after a subsequent successful completion overwrites `step`).

## 6. Error handling

- `:id` doesn't resolve to a `Client` → `404`.
- Client has no `ClientOnboarding` row yet (still at bare `PHONE_VERIFIED`, hasn't started linking) → `GET /admin/clients/:id` still returns the `Client` with `onboarding: null`; approve/retry return `409` (nothing to review).
- `approve`/`retry` called when `Client.status !== MANUAL_REVIEW` → `409` with a message naming the actual current status.
- `retry` with a missing/empty `note` → `400` (DTO validation).

## 7. Testing strategy

Same pattern as every prior phase: a unit test suite for the new review service covering list/detail/approve/retry (mocked Prisma), specifically both branches of the retry step-inference logic, the 409 guards, and the `PENDING_IPPIS` fix's one-line addition to `ClientOnboardingService.linkIppis` (an update to that task's existing test file, not a new one).

One e2e test walking a client into `MANUAL_REVIEW`, then through the admin `retry` → resubmit → `approve` path to `VERIFIED`. `MockFaceVerificationProvider` always returns `passed: true` (built that way deliberately, so the happy-path onboarding e2e test is deterministic), so it can't be used to organically produce a face-match failure. Instead the test drives the real `/client/onboarding/*` endpoints up through `IDENTITY_SUBMITTED`, then writes directly via `PrismaService` to simulate the failed outcome (`step: FACE_MATCH_PENDING → MANUAL_REVIEW`, `faceMatchPassed: false`, `failureReasons: { identityVerified: true, faceMatchPassed: false }`, matching exactly what `submitFaceMatch` itself would have written had the real provider failed) before exercising the new admin endpoints against it.
