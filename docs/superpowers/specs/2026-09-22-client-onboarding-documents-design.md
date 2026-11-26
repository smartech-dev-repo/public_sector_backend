# Client Onboarding — Document Collection Design (Sub-project A)

## 1. Purpose

The first of three sub-projects extending client onboarding (A: document
collection; B: extended identity data from Dojah + manual marital status;
C: IPPIS-sourced fields — Command ID, length of service — each gets its
own spec/plan). Adds a required, gating step to the onboarding pipeline
where the client uploads four documents: NIN Card/Slip, Work Identity
Card, Passport Photograph, and Signature.

## 2. Schema

A new, generic-by-type table rather than four fixed columns — adding a
5th document type later is a new enum value, not a migration:

```prisma
enum ClientDocumentType {
  NIN_CARD
  WORK_ID
  PASSPORT_PHOTO
  SIGNATURE
}

model ClientDocument {
  id                 String             @id @default(uuid())
  clientOnboardingId String
  clientOnboarding   ClientOnboarding   @relation(fields: [clientOnboardingId], references: [id])
  documentType       ClientDocumentType
  storageKey         String
  uploadedAt         DateTime           @default(now())

  @@unique([clientOnboardingId, documentType])
}
```

`OnboardingStep` gains `DOCUMENTS_SUBMITTED`, inserted between the
existing `IDENTITY_SUBMITTED` and `FACE_MATCH_PENDING`:

```
PHONE_VERIFIED → IPPIS_LINKED → IDENTITY_SUBMITTED → DOCUMENTS_SUBMITTED → FACE_MATCH_PENDING / COMPLETED
```

## 3. Upload endpoint

`POST /client/onboarding/documents/:type` (Client JWT, `:type` validated
against `ClientDocumentType`, single-file multipart body). Allowed when
the onboarding's current step is `IDENTITY_SUBMITTED` or
`DOCUMENTS_SUBMITTED` (`409` otherwise, matching this pipeline's existing
per-step gating convention) — the latter lets a client re-upload one
document (e.g. a blurry scan) without needing to have all 4 still
outstanding. Re-uploading a type **replaces** its existing row (upsert on
`clientOnboardingId`+`documentType`), it doesn't create a duplicate.

After each successful upload, the service checks whether all 4
`ClientDocumentType` values now have a row for this onboarding; if so
(and the step isn't already past this point), it advances
`step: DOCUMENTS_SUBMITTED`.

**File validation**: this codebase has no file-size/mime-type limits
configured anywhere today (confirmed — neither Agent's nor Client's
existing upload endpoints restrict this). Since this is new code, not a
retrofit, it adds sensible ones: images (`jpeg`/`png`) and `pdf`, capped
at a reasonable size (e.g. 5MB) — enforced via Multer's `fileFilter`/
`limits` options on the interceptor, rejecting anything else with a
clear `400`.

## 4. Interaction with admin's existing `retry`

`AdminClientReviewService.retry` (already shipped) resets a client back
to `IPPIS_LINKED` (identity failed — clears BVN/NIN/selfies) or
`IDENTITY_SUBMITTED` (only face-match failed). With the new
`DOCUMENTS_SUBMITTED` step sitting between those two reset points and
`FACE_MATCH_PENDING`, a client whose documents were already fine before
the retry shouldn't be forced to re-upload them.

**Rule** (your call): whenever identity is (re)confirmed — either the
client resubmitting it via `submitIdentity`, or admin's `retry` landing
them back at `IDENTITY_SUBMITTED` — check whether all 4
`ClientDocument` rows already exist for this onboarding, and land on
`DOCUMENTS_SUBMITTED` directly instead of `IDENTITY_SUBMITTED` if so. A
small shared helper, `determineStepAfterIdentity(onboardingId):
Promise<OnboardingStep>` (returns `DOCUMENTS_SUBMITTED` if all 4 exist,
else `IDENTITY_SUBMITTED`), used by both `ClientOnboardingService
.submitIdentity` and `AdminClientReviewService.retry`'s face-match-only
branch. `retry`'s identity-failed branch (reset to `IPPIS_LINKED`)
doesn't need this check itself — it's `submitIdentity` (called next,
once the client resubmits BVN/NIN) that applies the rule.

This means `AdminClientReviewModule` gains a new dependency on
`ClientOnboardingService` (or the extracted helper) — a new, reasonable
cross-module reference, matching how other admin modules already depend
on domain services (e.g. `ReconciliationModule` importing `WalletModule`).

## 5. Admin visibility

`AdminClientReviewService.findById` (used by `GET /admin/clients/:id`)
also includes this client's `ClientDocument` rows, with each
`storageKey` resolved to an actual viewable URL via the existing
`FileStorageProvider.getSignedDownloadUrl` (already built, only ever
used today by the document-ingestion snapshot export — this is simply a
new caller, not new infrastructure). Response shape adds
`documents: [{ documentType, url, uploadedAt }]`.

## 6. Testing

- Unit: the upload service method — wrong-step rejection (`409`),
  successful upsert-on-reupload, step only advances once all 4 types are
  present (not on the 1st/2nd/3rd), `determineStepAfterIdentity`'s two
  branches, the file-type/size validation rejecting a bad upload.
- Unit: `AdminClientReviewService.retry`'s face-match-only branch calling
  the shared helper and landing on the correct step in both the
  "documents already complete" and "documents still missing" cases.
- Unit: `AdminClientReviewService.findById` resolving document keys to
  signed URLs.
- e2e: full flow — link IPPIS → submit identity → upload all 4 documents
  (step advances) → face-match → completed; uploading a document before
  identity is submitted is rejected; re-uploading a document at
  `DOCUMENTS_SUBMITTED` replaces it; admin retry-after-face-match-failure
  with documents already complete lands the client at
  `DOCUMENTS_SUBMITTED`, not `IDENTITY_SUBMITTED`; `GET
  /admin/clients/:id` returns viewable document URLs.

## 7. Postman

Per this repo's `CLAUDE.md`: new `POST /client/onboarding/documents/:type`
requests (one success example per document type is excessive — one
representative success, plus wrong-step `409` and bad-file-type `400`),
and an updated `GET /admin/clients/:id` example showing the new
`documents` array.
