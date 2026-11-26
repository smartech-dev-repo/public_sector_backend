# Extended Identity Data & IPPIS-Sourced Marital Status Design

## 1. Purpose

The deferred middle piece of the original client-onboarding extension
(Docs → **this** → IPPIS fields; Docs and IPPIS fields already shipped).
Two things: extend Dojah BVN/NIN identity-verification data extraction
beyond the 5 fields captured today (and even 2 of those — `dateOfBirth`,
`phoneNumber` — are extracted then silently dropped, never persisted),
and auto-populate marital status onto `ClientOnboarding` from the linked
`IppisRecord` (client-editable), replacing the original "collected
manually" framing per an earlier correction during this initiative.

Research against the real, current codebase (not a stale summary) found:
`ClientOnboarding` has zero address/gender/DOB/marital-status columns
today. `IppisRecord` already has `dateOfBirth`/`gender`/`phone` — these
stay logically separate from the new Dojah-sourced columns (no automatic
reconciliation; capture-and-surface, not cross-checking — a natural
future enhancement if mismatches turn out to matter in practice, not
built now). `ClientOnboardingService.submitIdentity` stores `bvn`/`nin`
in **plaintext**, and both `GET /client/onboarding/status` and
`GET /admin/clients/:id` currently leak the entire nested record via
unfiltered object spreads — a pre-existing gap this spec fixes because
the feature is adding meaningfully more PII into those exact same
unfiltered response paths.

Dojah's real field names were confirmed directly against
`docs.dojah.io` for the two endpoints this codebase already calls
(`/api/v1/kyc/bvn/advance`, `/api/v1/kyc/nin/advance`) — not guessed:

- **BVN advance**: `bvn, first_name, last_name, middle_name, gender, date_of_birth, phone_number1, phone_number2, image, email, enrollment_bank, enrollment_branch, level_of_account, lga_of_origin, lga_of_residence, marital_status, nationality, state_of_origin, state_of_residence, title, watch_listed`.
- **NIN advance**: `nin, first_name, middle_name, last_name, date_of_birth, gender, phone_number, photo, birth_country, birth_state, birth_lga, residence_address_line_1, residence_town, residence_lga, residence_state, residence_status, origin_place, origin_lga, origin_state, nok_*, tax_*`.

Notably: **BVN has no address/city field at all** (only NIN does, via
`residence_address_line_1`/`residence_town`), and **neither endpoint
returns a postal/zip code** for Nigerian BVN/NIN at any tier.

## 2. Dojah provider — extend typing to match the real response shapes

`src/identity-verification/dojah-identity-verification.provider.ts`:

```typescript
interface DojahBvnEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number1: string | null;
  image: string;
  gender: string | null;
  state_of_origin: string | null;
  lga_of_origin: string | null;
  state_of_residence: string | null;
  lga_of_residence: string | null;
  marital_status: string | null;
}

interface DojahNinEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number: string | null;
  photo: string;
  gender: string | null;
  residence_address_line_1: string | null;
  residence_town: string | null;
}
```

The shared `IdentityLookupResult` interface
(`src/identity-verification/identity-verification-provider.interface.ts`)
grows to carry every new field both `lookupBvn`/`lookupNin` now map:

```typescript
export interface IdentityLookupResult {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  photoBase64: string;
  gender: string | null;
  stateOfOrigin: string | null;
  lgaOfOrigin: string | null;
  stateOfResidence: string | null;
  lgaOfResidence: string | null;
  maritalStatus: string | null;
  address: string | null;
  city: string | null;
}
```

Each provider's `lookupBvn`/`lookupNin` sets whichever fields its own
entity actually has and `null` for the rest (BVN doesn't have
`address`/`city`; NIN doesn't have `stateOfOrigin`/`lgaOfOrigin`/
`stateOfResidence`/`lgaOfResidence`/`maritalStatus`). The mock provider
(`src/identity-verification/mock-identity-verification.provider.ts`,
confirmed the exact current file) needs matching fields added so it
stays a faithful stand-in for both real providers.

## 3. `ClientOnboarding` gains 10 new columns

Populated at the existing `submitIdentity` step — no new endpoint needed
for extraction, since the Dojah lookups already happen there:

```prisma
model ClientOnboarding {
  # ...existing fields...
  identityDateOfBirth  DateTime?
  identityGender       String?
  identityPhoneNumber  String?
  stateOfOrigin        String?
  lgaOfOrigin          String?
  stateOfResidence     String?
  lgaOfResidence       String?
  address              String?
  city                 String?
  zipCode              String?  // Dojah returns no postal code for
                                 // Nigerian BVN/NIN at any tier — this
                                 // column is kept for future-proofing
                                 // but is never populated by any known
                                 // data source today. Not a bug.
  maritalStatus        String?
}
```

BVN is the source for `identityDateOfBirth`/`identityGender`/
`identityPhoneNumber`/`stateOfOrigin`/`lgaOfOrigin`/`stateOfResidence`/
`lgaOfResidence` (the richer, demographic-focused lookup). NIN is the
only source for `address`/`city`. `ClientOnboardingService.submitIdentity`
sets these directly from `bvnResult`/`ninResult` alongside its existing
writes — no change to the method's preconditions, step-transition logic,
or the `identityVerified` derivation.

## 4. Marital status — IPPIS-sourced, client-editable

`ClientOnboarding.maritalStatus` (already listed above) is copied from
`IppisRecord.maritalStatus` inside `ClientOnboardingService.linkIppis`,
the same copy-on-link pattern already used for `employeeStatus`/
`legacyId`/`bankName`/`accountNumber`. Dojah's own `marital_status`
(confirmed to exist on the BVN advance response, captured into
`IdentityLookupResult` for completeness in §2) is deliberately **not**
used to populate this field — IPPIS stays the single source of truth.

New endpoint: `PATCH /client/onboarding/marital-status` (client JWT,
`ClientOnlyGuard`), body `{ maritalStatus: string }` — lets the client
correct it if the IPPIS-sourced value is wrong. New
`ClientOnboardingService.updateMaritalStatus(clientId, maritalStatus)`,
no step/state precondition (editable regardless of onboarding step, same
as how a client can always see their own status).

## 5. Response shaping — client and admin endpoints

Both currently return the raw Prisma object via an unfiltered spread.

**`ClientOnboardingService.getStatus`** — replace the raw
`onboarding` pass-through with a curated object:

```typescript
{
  step, clientStatus, lengthOfService,
  onboarding: onboarding ? {
    employeeName: onboarding.employeeName,
    agency: onboarding.agency,
    bankName: onboarding.bankName,
    accountNumber: onboarding.accountNumber,
    employeeStatus: onboarding.employeeStatus,
    identityDateOfBirth: onboarding.identityDateOfBirth,
    identityGender: onboarding.identityGender,
    identityPhoneNumber: onboarding.identityPhoneNumber,
    stateOfOrigin: onboarding.stateOfOrigin,
    lgaOfOrigin: onboarding.lgaOfOrigin,
    stateOfResidence: onboarding.stateOfResidence,
    lgaOfResidence: onboarding.lgaOfResidence,
    address: onboarding.address,
    city: onboarding.city,
    zipCode: onboarding.zipCode,
    maritalStatus: onboarding.maritalStatus,
    step: onboarding.step,
    documents: onboarding.documents,
  } : null,
}
```

Drops `bvn`/`nin` plaintext, `bvnSelfie`/`ninSelfie`/`liveSelfieKey`
(internal storage keys), `failureReasons`/`reviewedBy`/`reviewedAt`/
`reviewNote` (internal review metadata, not the client's business), and
the raw nested `ippisRecord` entirely (already summarized via
`lengthOfService`, which the method already computes today).

**`AdminClientReviewService.findById`** — keeps `bvn`/`nin` plaintext
(legitimate for manual identity review) and every onboarding field
(including all new ones), but:

- Trims the nested `ippisRecord` to review-relevant fields only:
  `agency`, `staffId`, `employeeName`, `employeeStatus`, `hireDate`,
  `department`, `grade`, `bankName`, `accountNumber` — dropping
  `salary`, `pinNumber`, `pfaName`, `bvn` (IppisRecord's own separate
  field), and `rawFields` (raw ingestion JSON).
- Resolves `bvnSelfie`/`ninSelfie`/`liveSelfieKey` into signed,
  admin-viewable URLs via the existing `FileStorageProvider
  .getSignedDownloadUrl` — the same resolution `ClientDocument`s already
  get in this same method, just applied to the three identity-photo
  keys too, so an admin reviewing identity can actually see the BVN
  selfie, NIN selfie, and live selfie instead of an opaque storage key.

## 6. Testing

- Unit: both Dojah providers' `lookupBvn`/`lookupNin` map every new
  field correctly, `null` for fields the given lookup doesn't have.
- Unit: `submitIdentity` persists all 10 new `ClientOnboarding` columns
  from `bvnResult`/`ninResult`.
- Unit: `linkIppis` copies `maritalStatus` alongside the existing
  copied fields.
- Unit: `updateMaritalStatus` — updates the field, no step guard.
- Unit: `getStatus` returns the curated shape — confirm `bvn`/`nin`/
  selfie keys/raw `ippisRecord` are absent, confirm every new field is
  present.
- Unit: `findById` — confirm the trimmed `ippisRecord` shape (no
  `salary`/`pinNumber`/`pfaName`/`rawFields`), confirm `bvnSelfie`/
  `ninSelfie`/`liveSelfieKey` resolve to signed URLs alongside
  `ClientDocument`s.
- e2e: full pipeline through `submitIdentity` with a mock provider
  returning the new fields, confirm `GET /client/onboarding/status`
  shows them and doesn't leak `bvn`/`nin`/selfie keys/raw `ippisRecord`;
  confirm `GET /admin/clients/:id` shows the trimmed `ippisRecord` and
  resolved selfie URLs; `PATCH /client/onboarding/marital-status`
  updates the value.

## 7. Postman

Per this repo's `CLAUDE.md`: update `GET /client/onboarding/status`'s
and `GET /admin/clients/:id`'s saved response examples to the new
shapes; add `PATCH /client/onboarding/marital-status` (success +
validation-error scenarios) under Client's onboarding folder.
