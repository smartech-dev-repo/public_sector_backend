# Admin-Initiated Client Onboarding Design

## 1. Purpose

Today, `ClientOnboarding` can only be created and progressed by the client
themselves, self-service, via `src/client-onboarding/` (`linkIppis` →
`submitIdentity` → `uploadDocument` ×4 → `submitFaceMatch` with a live
selfie). This adds a parallel path where an **admin** runs the same
journey on a client's behalf — e.g. the admin is on a call with the
client, or onboarding them at a physical desk — with two differences from
self-service:

- No live selfie capture. Instead, the uploaded **passport photo**
  document stands in as the comparison image against the BVN/NIN lookup
  photos.
- BVN/NIN verification is a hard gate here, not advisory — if the lookup
  doesn't verify, nothing is saved and the admin must retry with corrected
  values, rather than self-service's behavior of saving anyway and
  surfacing the failure later at manual review.

The existing `admin-client-review` manual-review mechanism is unchanged
and still applies when face-match fails.

## 2. Entry point: IPPIS-first lookup, not phone-first

`POST /admin/clients/onboarding/ippis-lookup { ippisNumber }` is the
starting point — there is no separate "create a Client by phone" step.

```typescript
async adminStartOnboarding(ippisNumber: string, adminId: string) {
  const ippisRecord = await this.prisma.ippisRecord.findFirst({
    where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
  });
  if (!ippisRecord) {
    throw new NotFoundException('IPPIS number not found');
  }

  const existing = await this.prisma.clientOnboarding.findUnique({
    where: { ippisRecordId: ippisRecord.id },
    include: { client: true },
  });
  if (existing) {
    return existing; // resume — covers admin-started, client-started, or a previous admin session
  }

  if (!ippisRecord.phone) {
    throw new UnprocessableEntityException(
      'No phone number on file for this IPPIS record — cannot resolve a client',
    );
  }

  const client = await this.prisma.client.upsert({
    where: { phone: ippisRecord.phone },
    update: {},
    create: { phone: ippisRecord.phone, createdById: adminId },
  });

  return this.linkIppisRecord(client.id, ippisRecord, { onboardedById: adminId });
}
```

`linkIppisRecord(clientId, ippisRecord, extra)` is `linkIppis`'s existing
record-creation body (the `clientOnboarding.create({...})` call and the
`client.update` to `PENDING_IPPIS`), extracted into a shared private
helper so both the self-service and admin paths build the identical
record shape; `extra` just merges in `onboardedById` when called from the
admin path (`undefined`/omitted for self-service).

`Client.createdById` is only set in the upsert's `create` branch above —
i.e. only when this call is what brings the `Client` into existence. A
client who already exists (self-signed-up via OTP, or created by a
previous admin-lookup call) keeps whatever `createdById` it already has.

## 3. Self-service `linkIppis` becomes resumable too

Today `linkIppis` throws `ConflictException('Onboarding already started
for this client')` if called again for the same client. That's replaced
with: if a `ClientOnboarding` already exists for this `clientId`, return
it as-is (current `step` and all) instead of throwing. This is what makes
"client logs in after admin already started/finished their onboarding"
work — the client's own `ippis-link` call just resumes instead of
conflicting, using the same record regardless of who created it.

## 4. Identity step: a stricter sibling, not a shared toggle

`ClientOnboardingService.submitIdentity`'s two Dojah/mock lookup calls and
`identityVerified` computation move into a private `lookupIdentity(bvn,
nin)` with no side effects (no selfie storage, no DB write) — just `{
bvnResult, ninResult, identityVerified }`. Both callers decide what to do
with the result:

- `submitIdentity` (client-facing, **unchanged behavior**) — calls it,
  saves regardless of `identityVerified`, exactly as today.
- new `submitIdentityVerified(clientId, bvn, nin)` (admin-facing) — calls
  it; if `identityVerified` is `false`, throws
  `UnprocessableEntityException('BVN/NIN verification failed — identity
  could not be confirmed')` with **no write at all** (`onboarding.step`
  stays at `IPPIS_LINKED`, so the admin simply retries with corrected
  BVN/NIN); if `true`, saves exactly like `submitIdentity` (same fields,
  same selfie-key storage from the lookup photos) and returns the record.

`POST /admin/clients/:clientId/onboarding/identity` calls
`submitIdentityVerified`.

## 5. Documents: reused as-is

`POST /admin/clients/:clientId/onboarding/documents/:type` calls the
existing `uploadDocument(clientId, type, file)` unchanged — same four
`ClientDocumentType` values, same step-advancement logic
(`determineStepAfterIdentity`), same file-type filter. The admin uploads
`PASSPORT_PHOTO` as one of the four, same as self-service.

## 6. Face-match: passport photo in place of a live selfie

`submitFaceMatch`'s logic after selfie storage (the two `compare()` calls
+ the `completed`/status-transition block) moves into a new private
`completeFaceMatch(clientId, onboarding, liveSelfieKey)`. Both callers
feed it a `liveSelfieKey` from a different source:

- `submitFaceMatch(clientId, selfieBuffer)` (client-facing, **unchanged
  behavior**) — stores the buffer under
  `client-onboarding/${clientId}/live-selfie.jpg`, then calls
  `completeFaceMatch` with that key.
- new `submitFaceMatchFromPassportPhoto(clientId)` (admin-facing, no file
  upload — it reads a document already on file):

```typescript
async submitFaceMatchFromPassportPhoto(clientId: string) {
  const onboarding = await this.requireOnboarding(clientId);
  if (onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
    throw new ConflictException(
      `Expected step DOCUMENTS_SUBMITTED, but client is at ${onboarding.step}`,
    );
  }

  const passportDoc = await this.prisma.clientDocument.findUnique({
    where: {
      clientOnboardingId_documentType: {
        clientOnboardingId: onboarding.id,
        documentType: ClientDocumentType.PASSPORT_PHOTO,
      },
    },
  });
  if (!passportDoc) {
    throw new ConflictException('Passport photo has not been uploaded yet');
  }
  if (passportDoc.storageKey.toLowerCase().endsWith('.pdf')) {
    throw new UnprocessableEntityException(
      'Passport photo was uploaded as a PDF — an image (JPEG/PNG) is required for face comparison',
    );
  }

  return this.completeFaceMatch(clientId, onboarding, passportDoc.storageKey);
}
```

`POST /admin/clients/:clientId/onboarding/face-match` (no body/file) calls
this.

`completeFaceMatch` itself is unchanged in behavior: `completed =
identityVerified && faceMatchPassed`; on `completed`, `step=COMPLETED` and
`Client.status=VERIFIED`; otherwise `step=FACE_MATCH_PENDING` and
`Client.status=MANUAL_REVIEW` — the existing `admin-client-review` flow
picks up manual-review cases exactly as it does for self-service failures
today. `Client.status=VERIFIED` here means usable right away (e.g. can
request a loan) — admin's passport-based pass is treated as full
verification, not a provisional one.

## 7. Client can still confirm with a real selfie after admin completes it

`submitFaceMatch`'s precondition (`step` must be `IDENTITY_SUBMITTED` or
`DOCUMENTS_SUBMITTED`) is relaxed to also accept `COMPLETED`:

```typescript
if (
  onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED &&
  onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED &&
  onboarding.step !== OnboardingStep.COMPLETED
) {
  throw new ConflictException(/* ... */);
}
```

This lets a client who logs in after an admin already completed their
onboarding via passport photo submit a real selfie through the normal
`client/onboarding/face-match` endpoint. It re-runs `completeFaceMatch`
with the live selfie, overwriting the previous result —
reinforcing `VERIFIED` if it matches, or dropping to `MANUAL_REVIEW` if it
doesn't. This applies uniformly (not gated on how `COMPLETED` was
reached) — resubmitting a selfie to refresh an already-completed
onboarding is harmless in the self-service case too.

## 8. Schema

```prisma
// Client
createdById    String?
createdByAdmin AdminUser? @relation("ClientCreatedByAdmin", fields: [createdById], references: [id])

// ClientOnboarding — reviewedByAdmin's relation needs a name too, since this
// adds a second AdminUser relation on the same model (Prisma requires
// naming once there's more than one relation between the same two models).
reviewedByAdmin  AdminUser? @relation("ClientOnboardingReviewedBy", fields: [reviewedBy], references: [id])
onboardedById    String?
onboardedByAdmin AdminUser? @relation("ClientOnboardingByAdmin", fields: [onboardedById], references: [id])

// AdminUser
reviewedOnboardings ClientOnboarding[] @relation("ClientOnboardingReviewedBy")
onboardedClients    ClientOnboarding[] @relation("ClientOnboardingByAdmin")
createdClients      Client[]           @relation("ClientCreatedByAdmin")
```

Both new FK columns are nullable, additive, no backfill needed — a
standard Prisma migration.

`createdByAdmin`/`onboardedByAdmin` get hydrated into the same responses
that already hydrate `reviewedByAdmin` today: `GET /admin/clients`,
`GET /admin/clients/:id` (both in `admin-client-review.service.ts`), and
the new admin onboarding `status` response.

## 9. New controller and permission

New `src/client-onboarding/admin-client-onboarding.controller.ts`,
`@Controller('admin/clients')`, `JwtAuthGuard` + `PermissionsGuard`, all
routes gated by a new permission `clients:onboard` (distinct from
`clients:review`, following this repo's one-permission-per-capability
convention):

```
POST /admin/clients/onboarding/ippis-lookup       { ippisNumber }
POST /admin/clients/:clientId/onboarding/identity  { bvn, nin }
POST /admin/clients/:clientId/onboarding/documents/:type   (file upload)
POST /admin/clients/:clientId/onboarding/face-match        (no body)
GET  /admin/clients/:clientId/onboarding/status
```

`status` calls the existing `getStatus(clientId)` unchanged.

## 10. Testing

- Unit: `lookupIdentity` extraction — `submitIdentity` behavior unchanged
  (saves regardless); `submitIdentityVerified` throws `422` with no DB
  write when unverified, saves when verified.
- Unit: `adminStartOnboarding` — creates `Client`+`ClientOnboarding` with
  `createdById`/`onboardedById` set when none exists; returns the
  existing record untouched (no duplicate write, no id overwrite) when
  one does; `404` for unknown IPPIS number; `422` when `IppisRecord.phone`
  is empty.
- Unit: `linkIppis` — no longer throws on a second call for the same
  client; returns the existing record.
- Unit: `completeFaceMatch` extraction — `submitFaceMatch` behavior
  unchanged; `submitFaceMatchFromPassportPhoto` throws `409` if called
  before `DOCUMENTS_SUBMITTED` or if no passport photo exists, `422` if
  the passport photo's key ends in `.pdf`, otherwise produces the same
  `VERIFIED`/`MANUAL_REVIEW` outcome as the live-selfie path given the
  same match result.
- Unit: `submitFaceMatch`'s relaxed guard — now succeeds (doesn't throw)
  when `step === COMPLETED`, and correctly overwrites a prior
  admin-passport result.
- e2e: full admin journey — ippis-lookup (new client) → identity
  (verified) → 4 documents → face-match (passport) → `COMPLETED`/
  `VERIFIED`.
- e2e: admin identity step with a non-verifying BVN/NIN — `422`, no
  onboarding row mutated, retry with correct values succeeds.
- e2e: resume scenario — admin starts onboarding (ippis-lookup +
  identity), then the client logs in via their own OTP and calls
  `client/onboarding/ippis-link` with the same IPPIS number — gets back
  the existing record at `IDENTITY_SUBMITTED` instead of a conflict, and
  can finish the remaining steps (documents, live-selfie face-match)
  themselves.
- e2e: admin completes via passport photo (`VERIFIED`), then the client
  logs in and submits a real selfie via `client/onboarding/face-match` —
  succeeds, result reflects the live-selfie match (confirms `VERIFIED` in
  the matching case).

## 11. Postman

Per this repo's `CLAUDE.md`: new "Client Onboarding" sub-folder under the
Admin group (admin-authenticated, matching the new controller), with
requests for all 5 endpoints — each carrying a success example plus the
relevant failure scenarios (`404` unknown IPPIS, `422` unverified
BVN/NIN, `422` phone-less IPPIS record, `409` out-of-order steps, `403`
missing `clients:onboard`). Update `GET /admin/clients` and
`GET /admin/clients/:id` saved examples in the existing Admin → Client
Review folder to show the new `createdByAdmin`/`onboardedByAdmin` fields.

## 12. Out of scope

- No new OTP-less client-creation endpoint independent of IPPIS lookup —
  a `Client` is only created via self-service OTP or via this IPPIS-first
  admin lookup.
- Admin-side correction/editing of IPPIS-sourced fields (name, bank
  details, etc.) during onboarding — not requested, unchanged from
  self-service.
- Distinguishing, after the fact, whether a `COMPLETED` onboarding's
  current `liveSelfieKey` came from an admin's passport photo or a real
  client selfie — `completeFaceMatch` overwrites the key each time it
  runs, so only the most recent result is kept. Not tracked separately,
  since nothing has asked for that history.
