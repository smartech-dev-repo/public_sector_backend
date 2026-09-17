# Client/IPPIS Onboarding Pipeline — Design

**Date:** 2026-09-17
**Status:** Approved for planning
**Depends on:** Phase 1 Foundation (Client phone/OTP auth — `ClientAuthService`, already built), IPPIS Broadsheet ingestion (`IppisRecord`, already built), File storage abstraction (`FileStorageProvider`, already built).
**Supersedes/implements:** `docs/specs/2026-09-09-public-sector-backend-spec.md` §5 ("Client / IPPIS Onboarding (automated pipeline)"), previously unbuilt (listed there as "Phase 3").

This is sub-project 1 of 3 in the larger "Client Onboarding, Login, and Loan Request" feature. Sub-project 2 (Loan Request & Confirmation Workflow) and sub-project 3 (Client Loan Dashboard/History) depend on this one and are separate future specs.

## 1. Purpose and scope

Build the pipeline that takes a phone-verified `Client` (already possible today) through IPPIS linking, BVN/NIN identity verification, and face-match verification, to either auto-`VERIFIED` or `MANUAL_REVIEW`. Resumability ("log in and continue from wherever it stopped") falls out of the data model rather than needing separate tracking machinery.

**In scope:**
- Linking a `Client` to an `IppisRecord` by IPPIS number, with immutable snapshot fields pulled at link-time.
- BVN + NIN submission and lookup via a pluggable `IdentityVerificationProvider`, including a real `DojahIdentityVerificationProvider` (Dojah's plain lookup endpoints — no selfie sent to Dojah, since face-matching is a separate, self-built concern) and a mock for local dev/tests.
- Storing the BVN/NIN registries' own reference photos (`bvnSelfie`, `ninSelfie`) via the existing `FileStorageProvider`.
- Client captures a live selfie; a pluggable `FaceVerificationProvider` (mock only this round — a real implementation is a future follow-up once your own service is ready) compares it against **both** `bvnSelfie` and `ninSelfie`.
- Auto-completion logic: `VERIFIED` only if BVN/NIN lookup succeeded *and* both face-match comparisons passed; otherwise `MANUAL_REVIEW` with reasons attached (existing `clients:review` permission already covers visibility).
- A status endpoint so the client app can determine exactly which step to resume at after login.

**Explicitly out of scope / deferred:**
- The real face-verification service (yours, external) — only the pluggable interface + mock ship now.
- Loan request/confirmation workflow and the client loan dashboard (sub-projects 2 and 3).
- Retention/compliance encryption-at-rest for BVN/NIN columns — flagged as an open question in the original spec (§9); noted here again, not solved in this round.

## 2. Data model

`IppisRecord` (already built) is untouched — it stays purely the admin-uploaded reference table. A new model holds each client's own onboarding record, pulled from `IppisRecord` at link-time and independent of it afterward (an admin re-uploading the broadsheet later never retroactively changes an already-linked client's data):

```prisma
enum OnboardingStep {
  PHONE_VERIFIED
  IPPIS_LINKED
  IDENTITY_SUBMITTED
  FACE_MATCH_PENDING
  COMPLETED
}

model ClientOnboarding {
  id                String         @id @default(uuid())
  clientId          String         @unique
  client            Client         @relation(fields: [clientId], references: [id])
  ippisRecordId     String         @unique
  ippisRecord       IppisRecord    @relation(fields: [ippisRecordId], references: [id])
  employeeName      String
  agency            String
  bankName          String?
  accountNumber     String?
  bvn               String
  nin               String
  bvnSelfie         String?
  ninSelfie         String?
  liveSelfieKey     String?
  identityVerified  Boolean?
  faceMatchBvnScore Float?
  faceMatchNinScore Float?
  faceMatchPassed   Boolean?
  step              OnboardingStep @default(PHONE_VERIFIED)
  failureReasons    Json?
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
}
```

(`Client` and `IppisRecord` both need the reciprocal one-to-one relation field added — a small, mechanical addition alongside their existing fields, not a redesign of either model.)

**Resumability**: `step` says exactly where a client is. `GET /client/onboarding/status` returns it; the client app branches on that value. No separate state-machine service is needed — the field *is* the state machine.

**Natural-key protections** (mirroring the "no other Client already linked" rule from the original spec): `ippisRecordId` is `@unique` on `ClientOnboarding`, so the DB itself rejects a second client claiming the same IPPIS record; the service layer turns that into a clean `409 Conflict` rather than a raw constraint error.

## 3. Pipeline

1. **Phone + OTP** (already built, unchanged) → `Client` at `PHONE_VERIFIED`.
2. **`POST /client/onboarding/ippis-link`** — body `{ ippisNumber }`. Looks up `IppisRecord` by `staffId` (case-insensitive, matching the ingestion parser's own convention). Not found → `404`. Already claimed by another client → `409`. Otherwise creates `ClientOnboarding`, copying `employeeName`, `agency`, `bankName`, `accountNumber` from the matched record. Step → `IPPIS_LINKED`.
3. **`POST /client/onboarding/identity`** — body `{ bvn, nin }` (no file upload here — the reference photos come from the registries, not the client). Calls `IdentityVerificationProvider.lookupBvn(bvn)` and `.lookupNin(nin)`. Each call returns bio-data plus a base64 photo; the photo is decoded and stored via `FileStorageProvider`, and the resulting storage key saved as `bvnSelfie`/`ninSelfie`. `identityVerified` is set based on whether both lookups succeeded and the returned names/DOB are plausible matches for what's on the linked `IppisRecord` (exact-match on normalized name is brittle for real-world data — a lookup succeeding at all, plus the provider not flagging a mismatch, is enough to set `identityVerified = true`; anything the provider itself reports as inconclusive routes to `MANUAL_REVIEW` immediately without waiting for the face-match step). Step → `IDENTITY_SUBMITTED`.
4. **`POST /client/onboarding/face-match`** — multipart file upload, the client's live selfie. Saved via `FileStorageProvider` as `liveSelfieKey`. Step → `FACE_MATCH_PENDING` while running, then: `FaceVerificationProvider.compare(bvnSelfie, liveSelfieKey)` and `.compare(ninSelfie, liveSelfieKey)` are both called; `faceMatchBvnScore`/`faceMatchNinScore` store each result, `faceMatchPassed = true` only if **both** comparisons pass (per your decision — stricter than either-or, since a real fraud attempt would only need to fool one registry's photo under an either-or rule).
5. **Auto-completion**: if `identityVerified && faceMatchPassed` → `Client.status = VERIFIED`, `ClientOnboarding.step = COMPLETED`. Otherwise → `Client.status = MANUAL_REVIEW`, `failureReasons` populated with which check(s) failed, visible to admins holding the existing `clients:review` permission.
6. **`GET /client/onboarding/status`** — returns `{ step, client: { status } }` (and enough of the pulled IPPIS snapshot to render a "confirm your details" screen) so the client app can resume at the right screen after any login.

## 4. Provider interfaces

### `IdentityVerificationProvider`

```typescript
export interface IdentityLookupResult {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  photoBase64: string;
}

export interface IdentityVerificationProvider {
  lookupBvn(bvn: string): Promise<IdentityLookupResult>;
  lookupNin(nin: string): Promise<IdentityLookupResult>;
}
```

Ordered-list-with-failover dispatch (`IDENTITY_VERIFICATION_PROVIDERS`), matching the existing `OtpProvider`/`EmailProvider` pattern exactly — a provider that times out or errors falls through to the next configured one.

**`DojahIdentityVerificationProvider`** (built this round, real HTTP calls, lazy-initialized exactly like `S3FileStorageProvider`/`GcsFileStorageProvider` so it's inert without credentials) — uses Dojah's **advance** lookup tier (per your direction), which returns a materially richer record than their basic tier (useful later for reconciliation-style cross-checks against `IppisRecord`, e.g. state of origin/residence, beyond just name/DOB):
- `GET {DOJAH_BASE_URL}/api/v1/kyc/bvn/advance?bvn={bvn}` → `entity.first_name`/`last_name`/`middle_name`/`date_of_birth`/`phone_number1`/`phone_number2`/`image` (base64) plus `enrollment_bank`/`enrollment_branch`/`level_of_account`/`lga_of_origin`/`lga_of_residence`/`marital_status`/`nationality`/`state_of_origin`/`state_of_residence`/`title`/`watch_listed` (captured into `IdentityLookupResult`'s bio-data but not all persisted onto `ClientOnboarding` — only the fields the model above actually declares; the rest are available to log/inspect if a future manual-review screen wants them, without a schema change).
- `GET {DOJAH_BASE_URL}/api/v1/kyc/nin/advance?nin={nin}` → `entity.first_name`/`last_name`/`middle_name`/`date_of_birth`/`phone_number`/`photo` (base64) plus birth/residence/next-of-kin fields (`birth_state`, `residence_state`, `nok_first_name`, etc. — same "available but not persisted" treatment as the BVN advance fields above).
- Headers: `AppId: {DOJAH_APP_ID}`, `Authorization: {DOJAH_SECRET_KEY}` (raw, not `Bearer` — confirmed from Dojah's own docs).
- `DOJAH_BASE_URL` defaults to `https://sandbox.dojah.io`; set to `https://api.dojah.io` for production. `DOJAH_APP_ID`/`DOJAH_SECRET_KEY` required only when this provider is actually invoked (lazy `getOrThrow`, same reasoning as every other lazy-init provider in this codebase).
- A `NotFoundException`-style mapping for Dojah's own "record not found" response (exact shape to be confirmed once real sandbox credentials are available — the mock provider and unit tests don't depend on this).

**`MockIdentityVerificationProvider`** (built this round, used in local dev by default and in all automated tests): returns a fixed, fabricated `IdentityLookupResult` (never data resembling any real BVN/NIN) including a tiny embedded placeholder base64 image, so the whole pipeline is exercisable end-to-end without any external dependency.

### `FaceVerificationProvider`

```typescript
export interface FaceMatchResult {
  score: number;
  passed: boolean;
}

export interface FaceVerificationProvider {
  compare(referencePhotoKey: string, candidatePhotoKey: string): Promise<FaceMatchResult>;
}
```

Single-provider (no failover list — same reasoning as the original spec's §6: only one vendor is in play). **`MockFaceVerificationProvider`** ships this round — deterministic in tests (e.g. always returns `passed: true` unless a specific test fixture key signals otherwise), swapped for your own external service later via the same interface with zero changes to `ClientOnboardingService`.

## 5. Endpoints and permissions

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /client/onboarding/ippis-link` | Client JWT | `{ ippisNumber }` |
| `POST /client/onboarding/identity` | Client JWT | `{ bvn, nin }` |
| `POST /client/onboarding/face-match` | Client JWT | multipart, field `selfie` |
| `GET /client/onboarding/status` | Client JWT | resumability |

No new admin permissions needed — `clients:review` (existing) already governs the manual-review queue; a `GET /admin/clients?status=MANUAL_REVIEW`-style listing endpoint is a natural next addition but isn't required to ship this pipeline (the audit log and direct DB access cover it in the meantime, matching this project's habit of not building admin UI surface ahead of a proven need).

## 6. Error handling

- IPPIS number not found → `404`.
- IPPIS number already linked to another client → `409`.
- Client attempting a step out of order (e.g. calling `/identity` before `/ippis-link`) → `409` with a message naming the expected current step.
- BVN/NIN lookup provider failure (after exhausting the ordered list) → the whole request fails `502`-style (not silently routed to `MANUAL_REVIEW` — a provider outage is an infrastructure problem the client should retry, not a identity concern).
- Face-match comparison failure (not a mismatch — an actual provider error) → same `502`-style treatment as identity lookup.
- An actual mismatch (provider ran fine, returned `passed: false` or `identityVerified: false`) → routes to `MANUAL_REVIEW`, not an HTTP error — the request itself succeeds; the *outcome* is what differs.

## 7. Testing strategy

Same pattern as every prior phase: unit tests per provider (`MockIdentityVerificationProvider`/`DojahIdentityVerificationProvider` with its HTTP client mocked/`MockFaceVerificationProvider`), a `ClientOnboardingService` unit test suite (mocked Prisma) covering each step transition and both the auto-`VERIFIED` and `MANUAL_REVIEW` outcomes, and e2e tests walking a fake client through all four steps against the real DB (using the mock providers — real Dojah/face-service calls never happen in automated tests, matching this project's standing rule).
