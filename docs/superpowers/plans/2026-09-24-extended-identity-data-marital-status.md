# Extended Identity Data & IPPIS-Sourced Marital Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Dojah BVN/NIN identity-verification extraction to capture 10 new demographic/address fields onto `ClientOnboarding`, auto-populate marital status from the linked `IppisRecord` (client-editable), and fix the pre-existing response-exposure gap on both the client-status and admin-detail endpoints while touching those same response paths.

**Architecture:** Provider typing extends first (both real and mock, since the mock is the dev/test stand-in for both). `ClientOnboardingService.submitIdentity`/`linkIppis` write the new fields at their existing call sites — no new extraction endpoint needed. Two existing read methods (`ClientOnboardingService.getStatus`, `AdminClientReviewService.findById`) get their response shapes rewritten from raw Prisma spreads to curated/trimmed objects.

**Tech Stack:** NestJS, Prisma, `class-validator`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-24-extended-identity-data-marital-status-design.md`

## Global Constraints

- BVN is the source for `identityDateOfBirth`/`identityGender`/`identityPhoneNumber`/`stateOfOrigin`/`lgaOfOrigin`/`stateOfResidence`/`lgaOfResidence`. NIN is the only source for `address`/`city`. `zipCode` is added but never populated by any known source — documented as a known gap, not a bug.
- `maritalStatus` is copied from `IppisRecord.maritalStatus` at `linkIppis` time, client-editable via a new endpoint. Dojah's own `marital_status` field is captured into the shared interface for completeness but never used to populate this column.
- No automatic reconciliation between Dojah-extracted fields and `IppisRecord`'s own `dateOfBirth`/`gender`/`phone` — these are separate, independently-stored values.
- `GET /client/onboarding/status` and `GET /admin/clients/:id` both move from raw Prisma spreads to curated response shapes — exact field lists are in Task 3.
- No `Co-Authored-By: Claude` trailer on any commit.
- This plan is its own complete phase — its closing task runs the full unit + e2e suite.
- **Deliberate deviation from spec §5:** the spec's curated `getStatus` shape lists a `documents: onboarding.documents` field. The actual current `getStatus` implementation never includes `documents` in its Prisma query (`include: { ippisRecord: true }` only), and a strict existing test locks that exact `include` clause. Task 3 omits `documents` from the curated shape rather than expanding the query — adding it would be a second, unrelated feature (documents aren't fetched by this endpoint today) disguised as this one. If document visibility on the client status endpoint turns out to matter, that's its own follow-up.

---

### Task 1: Extend Dojah/mock provider typing

**Files:**
- Modify: `src/identity-verification/identity-verification-provider.interface.ts`
- Modify: `src/identity-verification/dojah-identity-verification.provider.ts`
- Modify: `src/identity-verification/dojah-identity-verification.provider.spec.ts`
- Modify: `src/identity-verification/mock-identity-verification.provider.ts`

**Interfaces:**
- Produces: `IdentityLookupResult` gains `gender`, `stateOfOrigin`, `lgaOfOrigin`, `stateOfResidence`, `lgaOfResidence`, `maritalStatus`, `address`, `city` (all `string | null`) — consumed by Task 2's `submitIdentity` rewrite.

- [ ] **Step 1: Write the failing provider tests**

Read `src/identity-verification/dojah-identity-verification.provider.spec.ts` in full first. Replace the first test:

```typescript
  it('calls the advance BVN endpoint with the correct headers and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number1: '08000000000',
          image: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: 'ZmFrZS1waG90bw==',
    });
  });
```

with:

```typescript
  it('calls the advance BVN endpoint with the correct headers and maps the response, including the new demographic fields', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number1: '08000000000',
          image: 'ZmFrZS1waG90bw==',
          gender: 'Female',
          state_of_origin: 'Lagos',
          lga_of_origin: 'Ikeja',
          state_of_residence: 'Abuja',
          lga_of_residence: 'AMAC',
          marital_status: 'Single',
        },
      }),
    });

    const result = await provider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: 'ZmFrZS1waG90bw==',
      gender: 'Female',
      stateOfOrigin: 'Lagos',
      lgaOfOrigin: 'Ikeja',
      stateOfResidence: 'Abuja',
      lgaOfResidence: 'AMAC',
      maritalStatus: 'Single',
      address: null,
      city: null,
    });
  });
```

Replace the second test:

```typescript
  it('calls the advance NIN endpoint and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number: '08000000000',
          photo: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupNin('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/nin/advance?nin=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result.photoBase64).toBe('ZmFrZS1waG90bw==');
  });
```

with:

```typescript
  it('calls the advance NIN endpoint and maps the response, including address fields', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number: '08000000000',
          photo: 'ZmFrZS1waG90bw==',
          gender: 'Female',
          residence_address_line_1: '12 Example Street',
          residence_town: 'Wuse',
        },
      }),
    });

    const result = await provider.lookupNin('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/nin/advance?nin=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result.photoBase64).toBe('ZmFrZS1waG90bw==');
    expect(result.gender).toBe('Female');
    expect(result.address).toBe('12 Example Street');
    expect(result.city).toBe('Wuse');
    expect(result.stateOfOrigin).toBeNull();
    expect(result.maritalStatus).toBeNull();
  });
```

The third and fourth tests (`'throws when Dojah returns a non-ok response'`, `'uses DOJAH_BASE_URL when set'`) are unaffected by this change — leave them as-is, but the fourth test's mock `entity` object (`{ first_name: 'A', last_name: 'B', date_of_birth: null, phone_number1: null, image: 'x' }`) will still work unchanged since the new fields are all optional on the interface and the provider code (Step 3 below) reads them with `?? null` fallbacks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/identity-verification/dojah-identity-verification.provider.spec.ts`
Expected: FAIL — the new fields aren't mapped yet.

- [ ] **Step 3: Update the shared interface**

Replace the full contents of `src/identity-verification/identity-verification-provider.interface.ts`:

```typescript
export const IDENTITY_VERIFICATION_PROVIDERS = Symbol('IDENTITY_VERIFICATION_PROVIDERS');

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

export interface IdentityVerificationProvider {
  readonly name: string;
  lookupBvn(bvn: string): Promise<IdentityLookupResult>;
  lookupNin(nin: string): Promise<IdentityLookupResult>;
}
```

- [ ] **Step 4: Update `DojahIdentityVerificationProvider`**

Replace the full contents of `src/identity-verification/dojah-identity-verification.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

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

@Injectable()
export class DojahIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'dojah';

  constructor(private readonly configService: ConfigService) {}

  private baseUrl(): string {
    return this.configService.get<string>('DOJAH_BASE_URL', 'https://sandbox.dojah.io');
  }

  // Credentials are read lazily (on first use), not in the constructor —
  // same reasoning as every other lazy-init provider in this codebase
  // (S3FileStorageProvider, GcsFileStorageProvider): this provider is
  // always constructed for DI purposes, but shouldn't break app startup
  // when it isn't the active provider (see identity-verification.module.ts).
  private headers(): Record<string, string> {
    return {
      AppId: this.configService.getOrThrow<string>('DOJAH_APP_ID'),
      Authorization: this.configService.getOrThrow<string>('DOJAH_SECRET_KEY'),
    };
  }

  async lookupBvn(bvn: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/bvn/advance?bvn=${encodeURIComponent(bvn)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah BVN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahBvnEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number1,
      photoBase64: body.entity.image,
      gender: body.entity.gender ?? null,
      stateOfOrigin: body.entity.state_of_origin ?? null,
      lgaOfOrigin: body.entity.lga_of_origin ?? null,
      stateOfResidence: body.entity.state_of_residence ?? null,
      lgaOfResidence: body.entity.lga_of_residence ?? null,
      maritalStatus: body.entity.marital_status ?? null,
      address: null,
      city: null,
    };
  }

  async lookupNin(nin: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/nin/advance?nin=${encodeURIComponent(nin)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah NIN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahNinEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number,
      photoBase64: body.entity.photo,
      gender: body.entity.gender ?? null,
      stateOfOrigin: null,
      lgaOfOrigin: null,
      stateOfResidence: null,
      lgaOfResidence: null,
      maritalStatus: null,
      address: body.entity.residence_address_line_1 ?? null,
      city: body.entity.residence_town ?? null,
    };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/identity-verification/dojah-identity-verification.provider.spec.ts`
Expected: PASS — 4/4.

- [ ] **Step 6: Update the mock provider**

Replace the full contents of `src/identity-verification/mock-identity-verification.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

const PLACEHOLDER_PHOTO_BASE64 = Buffer.from('mock-identity-photo').toString('base64');

@Injectable()
export class MockIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'mock';

  async lookupBvn(_bvn: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
      gender: 'Female',
      stateOfOrigin: 'Lagos',
      lgaOfOrigin: 'Ikeja',
      stateOfResidence: 'Lagos',
      lgaOfResidence: 'Ikeja',
      maritalStatus: 'Single',
      address: null,
      city: null,
    };
  }

  async lookupNin(_nin: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
      gender: 'Female',
      stateOfOrigin: null,
      lgaOfOrigin: null,
      stateOfResidence: null,
      lgaOfResidence: null,
      maritalStatus: null,
      address: '1 Mock Street',
      city: 'Mocktown',
    };
  }
}
```

- [ ] **Step 7: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/identity-verification/identity-verification-provider.interface.ts src/identity-verification/dojah-identity-verification.provider.ts src/identity-verification/dojah-identity-verification.provider.spec.ts src/identity-verification/mock-identity-verification.provider.ts
git commit -m "feat: extend Dojah/mock identity providers with demographic and address fields"
```

---

### Task 2: Persist the new fields — schema, `submitIdentity`, `linkIppis`, and the marital-status override endpoint

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`
- Create: `src/client-onboarding/dto/update-marital-status.dto.ts`
- Modify: `src/client-onboarding/client-onboarding.controller.ts`

**Interfaces:**
- Consumes: `IdentityLookupResult`'s new fields (Task 1).
- Produces: `ClientOnboardingService.updateMaritalStatus(clientId: string, maritalStatus: string): Promise<ClientOnboarding>`.

- [ ] **Step 1: Add the 10 new columns to `ClientOnboarding`**

In `prisma/schema.prisma`, find the `ClientOnboarding` model and add the new fields right after `legacyId`:

```prisma
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
  employeeStatus    String?
  legacyId          String?
  identityDateOfBirth DateTime?
  identityGender      String?
  identityPhoneNumber String?
  stateOfOrigin       String?
  lgaOfOrigin         String?
  stateOfResidence    String?
  lgaOfResidence      String?
  address             String?
  city                String?
  zipCode             String?
  maritalStatus       String?
  bvn               String?
  nin               String?
  bvnSelfie         String?
  ninSelfie         String?
  liveSelfieKey     String?
  identityVerified  Boolean?
  faceMatchBvnScore Float?
  faceMatchNinScore Float?
  faceMatchPassed   Boolean?
  step              OnboardingStep @default(PHONE_VERIFIED)
  failureReasons    Json?
  reviewedBy String?
  reviewedAt DateTime?
  reviewNote String?
  documents         ClientDocument[]
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
}
```

Run: `npx prisma migrate dev --name clientonboarding_add_identity_and_marital_status_fields`
Expected: new migration created and applied. Note: `zipCode` is a genuinely permanent no-op field per this plan's Global Constraints — do not treat the "never populated" state as a bug during review.

- [ ] **Step 2: Write the failing unit tests**

Read `src/client-onboarding/client-onboarding.service.spec.ts` in full first. Replace the `'creates a ClientOnboarding row pulling the matched IppisRecord fields'` test's `prisma.ippisRecord.findFirst.mockResolvedValue({...})` and the following assertion to also cover `maritalStatus`:

```typescript
    it('creates a ClientOnboarding row pulling the matched IppisRecord fields', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.linkIppis('client-1', 'NPF/1');

      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          employeeName: 'Jane Doe',
          agency: 'NPF',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          employeeStatus: 'ACTIVE',
          legacyId: 'LEGACY-001',
          maritalStatus: 'Married',
          step: 'IPPIS_LINKED',
        }),
      });
    });
```

Replace the `'looks up BVN and NIN, stores both photos, and marks identityVerified'` test:

```typescript
    it('looks up BVN and NIN, stores both photos, marks identityVerified, and persists the extended identity fields', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01', phoneNumber: '08011111111', photoBase64: 'YnZuLXBob3Rv',
        gender: 'Female', stateOfOrigin: 'Lagos', lgaOfOrigin: 'Ikeja', stateOfResidence: 'Abuja', lgaOfResidence: 'AMAC',
        maritalStatus: 'Single', address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01', phoneNumber: '08011111111', photoBase64: 'bmluLXBob3Rv',
        gender: 'Female', stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: '12 Example Street', city: 'Wuse',
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitIdentity('client-1', '12345678901', '98765432109');

      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          bvn: '12345678901',
          nin: '98765432109',
          identityVerified: true,
          step: 'IDENTITY_SUBMITTED',
          identityDateOfBirth: new Date('1990-01-01'),
          identityGender: 'Female',
          identityPhoneNumber: '08011111111',
          stateOfOrigin: 'Lagos',
          lgaOfOrigin: 'Ikeja',
          stateOfResidence: 'Abuja',
          lgaOfResidence: 'AMAC',
          address: '12 Example Street',
          city: 'Wuse',
        }),
      });
    });

    it('stores a null identityDateOfBirth when Dojah returns no date of birth', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'YnZuLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'bmluLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitIdentity('client-1', '12345678901', '98765432109');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ identityDateOfBirth: null }) }),
      );
    });
```

Add a new top-level `describe` block for the new method, right after the `getStatus` block (before the final closing `});` of the outer `describe`):

```typescript
  describe('updateMaritalStatus', () => {
    it('updates the maritalStatus field', async () => {
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', maritalStatus: 'Divorced' });

      const result = await service.updateMaritalStatus('client-1', 'Divorced');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: { maritalStatus: 'Divorced' },
      });
      expect(result.maritalStatus).toBe('Divorced');
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: FAIL — `linkIppis`/`submitIdentity` don't write the new fields yet, `updateMaritalStatus` doesn't exist.

- [ ] **Step 4: Update `ClientOnboardingService`**

In `src/client-onboarding/client-onboarding.service.ts`, replace `linkIppis`'s `create` call's `data` object:

```typescript
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });
```

with:

```typescript
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        maritalStatus: ippisRecord.maritalStatus,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });
```

Replace `submitIdentity`'s final `update` call:

```typescript
    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        bvn,
        nin,
        bvnSelfie: bvnSelfieKey,
        ninSelfie: ninSelfieKey,
        identityVerified,
        step,
      },
    });
  }
```

with:

```typescript
    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        bvn,
        nin,
        bvnSelfie: bvnSelfieKey,
        ninSelfie: ninSelfieKey,
        identityVerified,
        step,
        identityDateOfBirth: bvnResult.dateOfBirth ? new Date(bvnResult.dateOfBirth) : null,
        identityGender: bvnResult.gender,
        identityPhoneNumber: bvnResult.phoneNumber,
        stateOfOrigin: bvnResult.stateOfOrigin,
        lgaOfOrigin: bvnResult.lgaOfOrigin,
        stateOfResidence: bvnResult.stateOfResidence,
        lgaOfResidence: bvnResult.lgaOfResidence,
        address: ninResult.address,
        city: ninResult.city,
      },
    });
  }
```

Add this method right after `getStatus` (the last method in the class):

```typescript
  async updateMaritalStatus(clientId: string, maritalStatus: string) {
    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: { maritalStatus },
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 6: Create the DTO**

Create `src/client-onboarding/dto/update-marital-status.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class UpdateMaritalStatusDto {
  @IsString()
  @MinLength(1)
  maritalStatus: string;
}
```

- [ ] **Step 7: Add the controller route**

In `src/client-onboarding/client-onboarding.controller.ts`, add `Patch` to the `@nestjs/common` import and `import { UpdateMaritalStatusDto } from './dto/update-marital-status.dto';`. Add this route right after `getStatus`:

```typescript
  @Patch('marital-status')
  updateMaritalStatus(@Body() dto: UpdateMaritalStatusDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.updateMaritalStatus(req.user.sub, dto.maritalStatus);
  }
```

- [ ] **Step 8: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts src/client-onboarding/dto/update-marital-status.dto.ts src/client-onboarding/client-onboarding.controller.ts
git commit -m "feat: persist extended identity fields and IPPIS-sourced marital status"
```

---

### Task 3: Response shaping — client status and admin detail endpoints

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1/2 directly, but both methods being rewritten already return the new fields Task 2 added (since they spread/select onboarding fields).

- [ ] **Step 1: Write the failing unit tests for `getStatus`**

Read `src/client-onboarding/client-onboarding.service.spec.ts`'s `describe('getStatus', ...)` block in full first (it has 3 tests, none of which assert on `result.onboarding`'s shape today — they only check `result.step`/`result.lengthOfService`, so they keep passing unchanged). Add a new test to this block:

```typescript
    it('returns a curated onboarding shape without bvn/nin/selfie keys or the raw ippisRecord', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'COMPLETED',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        identityDateOfBirth: new Date('1990-01-01'),
        identityGender: 'Female',
        identityPhoneNumber: '08011111111',
        stateOfOrigin: 'Lagos',
        lgaOfOrigin: 'Ikeja',
        stateOfResidence: 'Abuja',
        lgaOfResidence: 'AMAC',
        address: '12 Example Street',
        city: 'Wuse',
        zipCode: null,
        maritalStatus: 'Single',
        bvn: '12345678901',
        nin: '98765432109',
        bvnSelfie: 'client-onboarding/client-1/bvn-selfie.jpg',
        ninSelfie: 'client-onboarding/client-1/nin-selfie.jpg',
        liveSelfieKey: 'client-onboarding/client-1/live-selfie.jpg',
        ippisRecord: { hireDate: new Date('2020-01-01') },
      });

      const result = await service.getStatus('client-1');

      expect(result.onboarding).toEqual({
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        identityDateOfBirth: new Date('1990-01-01'),
        identityGender: 'Female',
        identityPhoneNumber: '08011111111',
        stateOfOrigin: 'Lagos',
        lgaOfOrigin: 'Ikeja',
        stateOfResidence: 'Abuja',
        lgaOfResidence: 'AMAC',
        address: '12 Example Street',
        city: 'Wuse',
        zipCode: null,
        maritalStatus: 'Single',
        step: 'COMPLETED',
      });
      expect(result.onboarding).not.toHaveProperty('bvn');
      expect(result.onboarding).not.toHaveProperty('nin');
      expect(result.onboarding).not.toHaveProperty('bvnSelfie');
      expect(result.onboarding).not.toHaveProperty('ninSelfie');
      expect(result.onboarding).not.toHaveProperty('liveSelfieKey');
      expect(result.onboarding).not.toHaveProperty('ippisRecord');
    });

    it('returns a null onboarding view when there is no onboarding row yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.onboarding).toBeNull();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts -t "curated onboarding shape|null onboarding view"`
Expected: FAIL — `getStatus` still returns the raw onboarding object.

- [ ] **Step 3: Rewrite `getStatus`**

In `src/client-onboarding/client-onboarding.service.ts`, replace:

```typescript
  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding,
      lengthOfService: computeLengthOfService(onboarding?.ippisRecord?.hireDate ?? null),
    };
  }
```

with:

```typescript
  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding: onboarding
        ? {
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
          }
        : null,
      lengthOfService: computeLengthOfService(onboarding?.ippisRecord?.hireDate ?? null),
    };
  }
```

- [ ] **Step 4: Run the `getStatus` tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — full file, including the 3 pre-existing `getStatus` tests (they never asserted on `result.onboarding`'s shape, so they're unaffected).

- [ ] **Step 5: Write the failing unit test for `AdminClientReviewService.findById`**

Read `src/admin-client-review/admin-client-review.service.spec.ts`'s `describe('findById', ...)` block in full first. Add a new test:

```typescript
    it('trims the nested ippisRecord and resolves identity selfie keys to signed URLs', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: {
          id: 'o1',
          bvnSelfie: 'client-onboarding/c1/bvn-selfie.jpg',
          ninSelfie: 'client-onboarding/c1/nin-selfie.jpg',
          liveSelfieKey: 'client-onboarding/c1/live-selfie.jpg',
          ippisRecord: {
            agency: 'NPF',
            staffId: 'NPF-001',
            employeeName: 'Jane Doe',
            employeeStatus: 'ACTIVE',
            hireDate: new Date('2020-01-01'),
            department: 'Finance',
            grade: 'GL-08',
            bankName: 'GTBank',
            accountNumber: '0123456789',
            salary: 500000,
            pinNumber: 'secret-pin',
            pfaName: 'Some PFA',
            bvn: '99999999999',
            rawFields: { anything: 'here' },
          },
        },
      });
      fileStorageProvider.getSignedDownloadUrl.mockImplementation(
        async (key: string) => `https://signed-url.example/${key}`,
      );

      const result = await service.findById('c1');

      expect(result.onboarding.ippisRecord).toEqual({
        agency: 'NPF',
        staffId: 'NPF-001',
        employeeName: 'Jane Doe',
        employeeStatus: 'ACTIVE',
        hireDate: new Date('2020-01-01'),
        department: 'Finance',
        grade: 'GL-08',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });
      expect(result.onboarding.bvnSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/bvn-selfie.jpg');
      expect(result.onboarding.ninSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/nin-selfie.jpg');
      expect(result.onboarding.liveSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/live-selfie.jpg');
    });

    it('does not attempt to resolve selfie URLs that are not set', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'PENDING_IPPIS',
        onboarding: { id: 'o1' },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.bvnSelfieUrl).toBeNull();
      expect(result.onboarding.ninSelfieUrl).toBeNull();
      expect(result.onboarding.liveSelfieUrl).toBeNull();
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts -t "trims the nested ippisRecord|does not attempt to resolve"`
Expected: FAIL — `findById` doesn't trim `ippisRecord` or resolve selfie URLs yet.

- [ ] **Step 7: Rewrite `AdminClientReviewService.findById`**

In `src/admin-client-review/admin-client-review.service.ts`, replace:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true, ippisRecord: true } } },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (client.onboarding) {
      const documents = await Promise.all(
        (client.onboarding.documents ?? []).map(async (document) => ({
          documentType: document.documentType,
          url: await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey),
          uploadedAt: document.uploadedAt,
        })),
      );
      const lengthOfService = computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null);
      return { ...client, onboarding: { ...client.onboarding, documents, lengthOfService } };
    }

    return { ...client, onboarding: null };
  }
```

with:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true, ippisRecord: true } } },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (client.onboarding) {
      const documents = await Promise.all(
        (client.onboarding.documents ?? []).map(async (document) => ({
          documentType: document.documentType,
          url: await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey),
          uploadedAt: document.uploadedAt,
        })),
      );
      const lengthOfService = computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null);

      const ippisRecord = client.onboarding.ippisRecord
        ? {
            agency: client.onboarding.ippisRecord.agency,
            staffId: client.onboarding.ippisRecord.staffId,
            employeeName: client.onboarding.ippisRecord.employeeName,
            employeeStatus: client.onboarding.ippisRecord.employeeStatus,
            hireDate: client.onboarding.ippisRecord.hireDate,
            department: client.onboarding.ippisRecord.department,
            grade: client.onboarding.ippisRecord.grade,
            bankName: client.onboarding.ippisRecord.bankName,
            accountNumber: client.onboarding.ippisRecord.accountNumber,
          }
        : undefined;

      const bvnSelfieUrl = client.onboarding.bvnSelfie
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.bvnSelfie)
        : null;
      const ninSelfieUrl = client.onboarding.ninSelfie
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.ninSelfie)
        : null;
      const liveSelfieUrl = client.onboarding.liveSelfieKey
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.liveSelfieKey)
        : null;

      return {
        ...client,
        onboarding: {
          ...client.onboarding,
          documents,
          lengthOfService,
          ippisRecord,
          bvnSelfieUrl,
          ninSelfieUrl,
          liveSelfieUrl,
        },
      };
    }

    return { ...client, onboarding: null };
  }
```

(This keeps the raw `bvnSelfie`/`ninSelfie`/`liveSelfieKey` storage-key fields present on the spread `...client.onboarding` alongside the new `*Url` fields — only `ippisRecord` is replaced with the trimmed version. Trimming the raw keys out entirely is unnecessary scope beyond what the spec asked for; the spec's concern was the *nested `ippisRecord`* over-exposure and adding *viewable URLs*, not hiding the storage keys from admins.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — full file, including the pre-existing `'includes a computed lengthOfService...'` test, which asserts the exact `include` clause passed to `prisma.client.findUnique` — unchanged by this task, so it still passes.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: curate client-status and admin-detail onboarding response shapes"
```

---

### Task 4: e2e coverage, README, Postman, and the full test suite

**Files:**
- Modify: `test/client-onboarding.e2e-spec.ts`
- Modify: `test/admin-client-visibility.e2e-spec.ts` (or wherever `GET /admin/clients/:id` is currently e2e-tested — confirm exact file via `grep -rln "admin/clients/" test/*.e2e-spec.ts` first)
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-3.

- [ ] **Step 1: Extend the client-onboarding e2e test**

Read `test/client-onboarding.e2e-spec.ts` in full first — it already runs a full pipeline test (link → identity → documents → face-match → completed) using the `mock` identity-verification provider (confirm via the test's env/module setup which provider is active — it should be `mock`, matching `MockIdentityVerificationProvider`'s fields from Task 1 Step 6). After the identity-submission step in that existing pipeline test, add assertions that `GET /client/onboarding/status` shows the new fields and does not leak `bvn`/`nin`/selfie keys:

```typescript
    const statusRes = await request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(statusRes.body.onboarding.identityGender).toBe('Female');
    expect(statusRes.body.onboarding.stateOfOrigin).toBe('Lagos');
    expect(statusRes.body.onboarding.address).toBe('1 Mock Street');
    expect(statusRes.body.onboarding.city).toBe('Mocktown');
    expect(statusRes.body.onboarding).not.toHaveProperty('bvn');
    expect(statusRes.body.onboarding).not.toHaveProperty('nin');
    expect(statusRes.body.onboarding).not.toHaveProperty('bvnSelfie');
```

Read the exact surrounding variable names (`accessToken`/`app`/etc.) from the file's existing pipeline test before inserting — match them exactly, don't guess.

Add a new, separate test for the marital-status override:

```typescript
  it('lets the client override their IPPIS-sourced marital status', async () => {
    const { accessToken } = await createVerifiedClient('0000099', 'MaritalTest');

    const before = await request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(before.body.onboarding.maritalStatus).toBeDefined();

    await request(app.getHttpServer())
      .patch('/client/onboarding/marital-status')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ maritalStatus: 'Widowed' })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.onboarding.maritalStatus).toBe('Widowed');
  });
```

Read the file's existing helper functions first (e.g. a `createVerifiedClient` helper or equivalent full-pipeline setup) to see whether one already exists to reuse — if the file doesn't have a reusable "get a client through to a linked/verified state" helper, write this test using the same inline step sequence (phone-verify, ippis-link, identity-submit at minimum) as the file's main pipeline test, reading that test first to copy its exact setup calls.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-onboarding.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 3: Fix/extend the admin-detail e2e coverage**

Run: `grep -rln "admin/clients/" test/*.e2e-spec.ts` to find every e2e file exercising `GET /admin/clients/:id`. Read whichever file(s) come back in full. For each existing assertion that reads `res.body.onboarding.ippisRecord` (if any) as the old, untrimmed shape, update it to expect only the trimmed field set (`agency`, `staffId`, `employeeName`, `employeeStatus`, `hireDate`, `department`, `grade`, `bankName`, `accountNumber`) — confirm no test currently asserts on `salary`/`pinNumber`/`pfaName`/`rawFields` being present (if one does, per this plan it should now expect those fields to be *absent*, since Task 3 removed them). Add one new assertion (in whichever file is the natural home, e.g. the same file covering the full onboarding pipeline through admin review) confirming `res.body.onboarding.bvnSelfieUrl`/`ninSelfieUrl`/`liveSelfieUrl` are present and are non-empty strings once a client has completed identity submission.

- [ ] **Step 4: Run that e2e file**

Run: `npx jest --config ./test/jest-e2e.json <the file(s) found in Step 3> --runInBand`
Expected: PASS.

- [ ] **Step 5: Update the README**

Document: the new `ClientOnboarding` identity/address fields and their sources (BVN vs NIN, per the Global Constraints table); that `zipCode` exists but is never populated by any current data source; the new `PATCH /client/onboarding/marital-status` endpoint; and that both `GET /client/onboarding/status` and `GET /admin/clients/:id` now return curated/trimmed shapes instead of raw Prisma objects (list what's newly excluded from each).

- [ ] **Step 6: Update Postman**

Per this repo's `CLAUDE.md`:
- Update `GET /client/onboarding/status`'s saved response examples to the new curated shape (drop `bvn`/`nin`/selfie keys/raw `ippisRecord`, add the new identity/address/marital-status fields).
- Update `GET /admin/clients/:id`'s saved response examples to show the trimmed `ippisRecord` and the new `bvnSelfieUrl`/`ninSelfieUrl`/`liveSelfieUrl` fields.
- Add `PATCH /client/onboarding/marital-status` (success + validation-error scenarios) under Client's onboarding folder.
- Trace every `pm.test` script touching these two endpoints for anything reading a field this task removed (`bvn`, `nin`, `bvnSelfie`, `ninSelfie`, `salary`, `pinNumber`, `pfaName`, `rawFields` on the nested ippisRecord) — this has been a real, recurring finding in every closing task this session.
- Use surgical text-based/`Edit`-tool edits only, never a full-document rewrite. Verify with a byte-level em-dash/naira-sign check against `HEAD`.

- [ ] **Step 7: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 8: Commit**

```bash
git add test/client-onboarding.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add e2e coverage and docs for extended identity data and marital status"
```

(If Step 3 modified a second e2e file beyond `test/client-onboarding.e2e-spec.ts`, `git add` that file too in this same commit.)

- [ ] **Step 9: Run the full test suite**

This plan is its own complete phase — run the true full suite.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run it in isolation to confirm pre-existing environmental flakiness rather than a real regression (this codebase's full e2e run has hit this before, multiple times, always benignly), and report that distinction clearly.

## Exit criteria

- [ ] Dojah/mock providers extract gender, state/LGA of origin and residence, marital status (BVN), address/city (NIN) — real field names confirmed against `docs.dojah.io`, not guessed.
- [ ] `ClientOnboarding` persists all 10 new fields at `submitIdentity`/`linkIppis` time.
- [ ] Marital status is IPPIS-sourced by default, client-editable via `PATCH /client/onboarding/marital-status`.
- [ ] `GET /client/onboarding/status` no longer leaks `bvn`/`nin`/selfie keys/the raw nested `ippisRecord`.
- [ ] `GET /admin/clients/:id` trims the nested `ippisRecord` to review-relevant fields and resolves all three selfie keys to signed URLs.
- [ ] Full unit + e2e suite passes clean.
