# Admin-Initiated Client Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Note for this repo:** neither sub-skill is installed here — replicate the pattern manually: one fresh Agent-tool call per task, review its diff before starting the next task, run only the touched file's tests per task (full suite at the end of this plan, not per-task).

**Goal:** Let an admin run the client-onboarding journey (IPPIS lookup → identity verification → 4 documents → face-match) on a client's behalf, substituting the uploaded passport photo for a live selfie, while keeping the existing self-service flow fully interoperable (resumable either direction, and re-confirmable with a real selfie after an admin completes it).

**Architecture:** Extend `ClientOnboardingService` with admin-facing sibling methods that share private helpers with the existing self-service methods (`createOnboardingRecord`, `lookupIdentity`, `completeFaceMatch`) rather than forking the flow. A new `AdminClientOnboardingController` exposes these under `admin/clients/...`, gated by a new `clients:onboard` permission. Two nullable `AdminUser` FK columns track who created/onboarded a client, surfaced through the existing `admin-client-review` hydration pattern.

**Tech Stack:** NestJS, Prisma (PostgreSQL), Jest (unit + e2e via supertest), existing `IdentityVerificationService`/`FaceVerificationProvider`/`FileStorageProvider` abstractions.

**Spec:** `docs/superpowers/specs/2026-10-02-admin-client-onboarding-design.md`

## Global Constraints

- No placeholder/TBD values anywhere — every Postman example, error message, and test assertion uses real, concrete content.
- Follow this repo's `CLAUDE.md`: every new/changed endpoint gets a matching Postman request (success + meaningful failure scenarios) with a saved response example, in the same change as the code.
- Per project convention: run only the current task's touched-file tests as you go; run the full suite only once, at the end of Task 7.
- Never commit with a `Co-Authored-By: Claude` trailer (this repo's standing instruction).
- `IdentityVerificationService`'s mock provider (`IDENTITY_VERIFICATION_PROVIDER=mock` in this repo's `.env`) always returns a verified result, and the mock face-verification provider always passes — so the "BVN/NIN fails to verify" (422) and "face match fails → MANUAL_REVIEW" paths are only reachable in **unit** tests (service methods called directly with mocked dependencies), not in e2e. Don't attempt to force these through e2e HTTP calls; e2e coverage in Task 7 is scoped accordingly.

---

### Task 1: Schema — admin-tracking columns and the `clients:onboard` permission

**Files:**
- Modify: `prisma/schema.prisma:132-143` (`Client` model)
- Modify: `prisma/schema.prisma:361-362` (`ClientOnboarding.reviewedByAdmin`)
- Modify: `prisma/schema.prisma:66-68` (`AdminUser`'s back-relation fields)
- Modify: `prisma/seed.ts:30-32` (`BOOTSTRAP_PERMISSIONS`)

**Interfaces:**
- Produces: `Client.createdById` (nullable string FK), `ClientOnboarding.onboardedById` (nullable string FK) — both consumed by Task 4's service methods and Task 6's hydration.
- Produces: permission key `'clients:onboard'` — consumed by Task 5's controller guards.

- [ ] **Step 1: Add `createdById`/`createdByAdmin` to `Client`**

In `prisma/schema.prisma`, find:

```prisma
model Client {
  id        String       @id @default(uuid())
  phone     String       @unique
  status    ClientStatus @default(PHONE_VERIFIED)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  onboarding ClientOnboarding?
  loanRequests LoanRequest[]
  walletEntries WalletEntry[]
  clientLoans ClientLoan[]
}
```

Replace with:

```prisma
model Client {
  id        String       @id @default(uuid())
  phone     String       @unique
  status    ClientStatus @default(PHONE_VERIFIED)
  createdById String?
  createdByAdmin AdminUser? @relation("ClientCreatedByAdmin", fields: [createdById], references: [id])
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  onboarding ClientOnboarding?
  loanRequests LoanRequest[]
  walletEntries WalletEntry[]
  clientLoans ClientLoan[]
}
```

- [ ] **Step 2: Add `onboardedById`/`onboardedByAdmin` to `ClientOnboarding`, name the existing `reviewedByAdmin` relation**

In `prisma/schema.prisma`, find:

```prisma
  reviewedBy String?
  reviewedByAdmin AdminUser? @relation(fields: [reviewedBy], references: [id])
  reviewedAt DateTime?
  reviewNote String?
```

Replace with:

```prisma
  reviewedBy String?
  reviewedByAdmin AdminUser? @relation("ClientOnboardingReviewedBy", fields: [reviewedBy], references: [id])
  onboardedById String?
  onboardedByAdmin AdminUser? @relation("ClientOnboardingByAdmin", fields: [onboardedById], references: [id])
  reviewedAt DateTime?
  reviewNote String?
```

(This model has two separate `reviewedBy`/`reviewedByAdmin` blocks at two different line ranges in the file — one near line 106 belongs to a different model. Only edit the one inside the `ClientOnboarding` model, identified by the surrounding `bvnSelfie`/`ninSelfie`/`liveSelfieKey`/`step`/`failureReasons` fields immediately above it and `documents ClientDocument[]` immediately below.)

- [ ] **Step 3: Name `AdminUser`'s existing `reviewedOnboardings` relation, add the two new back-relations**

In `prisma/schema.prisma`, find:

```prisma
  sentInvites  AdminInvite[]
  reviewedOnboardings ClientOnboarding[]
  reviewedAgents      Agent[]
  uploadedDocumentBatches DocumentUploadBatch[]
```

Replace with:

```prisma
  sentInvites  AdminInvite[]
  reviewedOnboardings ClientOnboarding[] @relation("ClientOnboardingReviewedBy")
  onboardedClients    ClientOnboarding[] @relation("ClientOnboardingByAdmin")
  createdClients      Client[]           @relation("ClientCreatedByAdmin")
  reviewedAgents      Agent[]
  uploadedDocumentBatches DocumentUploadBatch[]
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npx prisma migrate dev --name client_onboarding_admin_tracking`
Expected: succeeds, creates a new folder under `prisma/migrations/` whose SQL adds two nullable columns (`createdById` on `Client`, `onboardedById` on `ClientOnboarding`) with their FK constraints — no data loss, no required-column backfill.

- [ ] **Step 5: Add the `clients:onboard` permission to the seed**

In `prisma/seed.ts`, find:

```typescript
  { key: 'departments:manage', description: 'Create, edit, and delete department definitions' },
];
```

Replace with:

```typescript
  { key: 'departments:manage', description: 'Create, edit, and delete department definitions' },
  { key: 'clients:onboard', description: "Onboard a client on the client's behalf (admin-initiated onboarding)" },
];
```

- [ ] **Step 6: Re-seed and verify**

Run: `npx prisma db seed`
Expected: succeeds; the bootstrap `SUPER_ADMIN` role now also has `clients:onboard` (seed attaches every permission in `BOOTSTRAP_PERMISSIONS` to that role).

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/seed.ts prisma/migrations
git commit -m "feat: add admin-tracking columns for client onboarding and clients:onboard permission"
```

---

### Task 2: `lookupIdentity` extraction + `submitIdentityVerified`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts:1,70-110`
- Test: `src/client-onboarding/client-onboarding.service.spec.ts:1,113-181`

**Interfaces:**
- Consumes: nothing new (uses existing `identityVerificationService.lookupBvn/lookupNin`, `fileStorageProvider.putObject`, `prisma.clientOnboarding.update`).
- Produces: `ClientOnboardingService.submitIdentityVerified(clientId: string, bvn: string, nin: string): Promise<ClientOnboarding>` — throws `UnprocessableEntityException` with no DB write if unverified. Consumed by Task 5's controller.

- [ ] **Step 1: Write the failing tests**

In `src/client-onboarding/client-onboarding.service.spec.ts`, change the top import line:

Find:
```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
```
Replace with:
```typescript
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
```

Then find (the end of the `submitIdentity` describe block, right before `determineStepAfterIdentity`'s):

```typescript
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ identityDateOfBirth: null }) }),
      );
    });
  });

  describe('determineStepAfterIdentity', () => {
```

Replace with:

```typescript
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ identityDateOfBirth: null }) }),
      );
    });
  });

  describe('submitIdentityVerified', () => {
    it('rejects when the client is not at the IPPIS_LINKED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IDENTITY_SUBMITTED' });
      await expect(
        service.submitIdentityVerified('client-1', '12345678901', '12345678901'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws UnprocessableEntityException and writes nothing when BVN/NIN do not verify', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: '', lastName: '', dateOfBirth: null, phoneNumber: null, photoBase64: 'YnZuLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: '', lastName: '', dateOfBirth: null, phoneNumber: null, photoBase64: 'bmluLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });

      await expect(
        service.submitIdentityVerified('client-1', '12345678901', '98765432109'),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(fileStorageProvider.putObject).not.toHaveBeenCalled();
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });

    it('saves and returns the record when BVN/NIN both verify', async () => {
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
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });

      const result = await service.submitIdentityVerified('client-1', '12345678901', '98765432109');

      expect(result).toEqual({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({ identityVerified: true, step: 'IDENTITY_SUBMITTED' }),
      });
    });
  });

  describe('determineStepAfterIdentity', () => {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts -t submitIdentityVerified`
Expected: FAIL with "service.submitIdentityVerified is not a function"

- [ ] **Step 3: Extract `lookupIdentity` and add `submitIdentityVerified`**

In `src/client-onboarding/client-onboarding.service.ts`, change the import line:

Find:
```typescript
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
```
Replace with:
```typescript
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
```

Then find the entire `submitIdentity` method:

```typescript
  async submitIdentity(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }

    const [bvnResult, ninResult] = await Promise.all([
      this.identityVerificationService.lookupBvn(bvn),
      this.identityVerificationService.lookupNin(nin),
    ]);

    const bvnSelfieKey = `client-onboarding/${clientId}/bvn-selfie.jpg`;
    const ninSelfieKey = `client-onboarding/${clientId}/nin-selfie.jpg`;
    await this.fileStorageProvider.putObject(bvnSelfieKey, Buffer.from(bvnResult.photoBase64, 'base64'));
    await this.fileStorageProvider.putObject(ninSelfieKey, Buffer.from(ninResult.photoBase64, 'base64'));

    const identityVerified = Boolean(bvnResult.firstName) && Boolean(ninResult.firstName);

    const step = await this.determineStepAfterIdentity(onboarding.id);

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

Replace with:

```typescript
  private async lookupIdentity(bvn: string, nin: string) {
    const [bvnResult, ninResult] = await Promise.all([
      this.identityVerificationService.lookupBvn(bvn),
      this.identityVerificationService.lookupNin(nin),
    ]);
    const identityVerified = Boolean(bvnResult.firstName) && Boolean(ninResult.firstName);
    return { bvnResult, ninResult, identityVerified };
  }

  private async saveIdentity(
    clientId: string,
    onboarding: { id: string },
    bvn: string,
    nin: string,
    bvnResult: IdentityLookupResult,
    ninResult: IdentityLookupResult,
    identityVerified: boolean,
  ) {
    const bvnSelfieKey = `client-onboarding/${clientId}/bvn-selfie.jpg`;
    const ninSelfieKey = `client-onboarding/${clientId}/nin-selfie.jpg`;
    await this.fileStorageProvider.putObject(bvnSelfieKey, Buffer.from(bvnResult.photoBase64, 'base64'));
    await this.fileStorageProvider.putObject(ninSelfieKey, Buffer.from(ninResult.photoBase64, 'base64'));

    const step = await this.determineStepAfterIdentity(onboarding.id);

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

  async submitIdentity(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }
    const { bvnResult, ninResult, identityVerified } = await this.lookupIdentity(bvn, nin);
    return this.saveIdentity(clientId, onboarding, bvn, nin, bvnResult, ninResult, identityVerified);
  }

  async submitIdentityVerified(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }
    const { bvnResult, ninResult, identityVerified } = await this.lookupIdentity(bvn, nin);
    if (!identityVerified) {
      throw new UnprocessableEntityException('BVN/NIN verification failed — identity could not be confirmed');
    }
    return this.saveIdentity(clientId, onboarding, bvn, nin, bvnResult, ninResult, identityVerified);
  }
```

Add the `IdentityLookupResult` import alongside the existing `IdentityVerificationService` import:

Find:
```typescript
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
```
Replace with:
```typescript
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { IdentityLookupResult } from '../identity-verification/identity-verification-provider.interface';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS, all tests (existing `submitIdentity` tests unchanged in behavior, new `submitIdentityVerified` tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat: add strict submitIdentityVerified for admin-initiated onboarding"
```

---

### Task 3: `completeFaceMatch` extraction + `submitFaceMatchFromPassportPhoto` + relax `submitFaceMatch`'s guard

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts:146-185`
- Test: `src/client-onboarding/client-onboarding.service.spec.ts` (mock setup + `submitFaceMatch`/new describe block)

**Interfaces:**
- Consumes: `ClientDocumentType` enum (already imported).
- Produces: `ClientOnboardingService.submitFaceMatchFromPassportPhoto(clientId: string): Promise<ClientOnboarding>` — consumed by Task 5's controller. `submitFaceMatch` now also accepts `step === COMPLETED` without throwing.

- [ ] **Step 1: Extend the test mock shape**

In `src/client-onboarding/client-onboarding.service.spec.ts`, find:

```typescript
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    ippisRecord: { findFirst: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    clientDocument: { count: jest.Mock; upsert: jest.Mock };
  };
```
Replace with:
```typescript
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    ippisRecord: { findFirst: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    clientDocument: { count: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock };
  };
```

Find:
```typescript
      clientDocument: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn() },
```
Replace with:
```typescript
      clientDocument: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn(), findUnique: jest.fn() },
```

- [ ] **Step 2: Write the failing tests**

Find (end of `submitFaceMatch`'s last test, before `getStatus`'s describe block):

```typescript
      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'MANUAL_REVIEW' },
      });
    });
  });

  describe('getStatus', () => {
```

Replace with:

```typescript
      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'MANUAL_REVIEW' },
      });
    });

    it('allows re-submission when step is already COMPLETED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'COMPLETED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare.mockResolvedValue({ score: 0.95, passed: true });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });
  });

  describe('submitFaceMatchFromPassportPhoto', () => {
    it('rejects when the client is not at DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when no passport photo has been uploaded', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.findUnique.mockResolvedValue(null);
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(ConflictException);
    });

    it('rejects with UnprocessableEntityException when the passport photo was uploaded as a PDF', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.findUnique.mockResolvedValue({
        storageKey: 'client-onboarding/client-1/documents/passport_photo.pdf',
      });
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('compares the passport photo against the BVN/NIN selfies and completes on a pass', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'onboarding-1',
        step: 'DOCUMENTS_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      prisma.clientDocument.findUnique.mockResolvedValue({
        storageKey: 'client-onboarding/client-1/documents/passport_photo.jpg',
      });
      faceVerificationProvider.compare.mockResolvedValue({ score: 0.95, passed: true });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatchFromPassportPhoto('client-1');

      expect(faceVerificationProvider.compare).toHaveBeenCalledWith(
        'bvn-key',
        'client-onboarding/client-1/documents/passport_photo.jpg',
      );
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });
  });

  describe('getStatus', () => {
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts -t submitFaceMatchFromPassportPhoto`
Expected: FAIL with "service.submitFaceMatchFromPassportPhoto is not a function"

- [ ] **Step 4: Extract `completeFaceMatch`, relax `submitFaceMatch`'s guard, add `submitFaceMatchFromPassportPhoto`**

In `src/client-onboarding/client-onboarding.service.ts`, find the entire `submitFaceMatch` method:

```typescript
  async submitFaceMatch(clientId: string, selfieBuffer: Buffer) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED && onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      throw new ConflictException(
        `Expected step IDENTITY_SUBMITTED or DOCUMENTS_SUBMITTED, but client is at ${onboarding.step}`,
      );
    }

    const liveSelfieKey = `client-onboarding/${clientId}/live-selfie.jpg`;
    await this.fileStorageProvider.putObject(liveSelfieKey, selfieBuffer);

    const [bvnMatch, ninMatch] = await Promise.all([
      this.faceVerificationProvider.compare(onboarding.bvnSelfie!, liveSelfieKey),
      this.faceVerificationProvider.compare(onboarding.ninSelfie!, liveSelfieKey),
    ]);

    const faceMatchPassed = bvnMatch.passed && ninMatch.passed;
    const completed = Boolean(onboarding.identityVerified) && faceMatchPassed;

    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        liveSelfieKey,
        faceMatchBvnScore: bvnMatch.score,
        faceMatchNinScore: ninMatch.score,
        faceMatchPassed,
        step: completed ? OnboardingStep.COMPLETED : OnboardingStep.FACE_MATCH_PENDING,
        failureReasons: completed
          ? null
          : { identityVerified: onboarding.identityVerified, faceMatchPassed },
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: completed ? ClientStatus.VERIFIED : ClientStatus.MANUAL_REVIEW },
    });

    return updated;
  }
```

Replace with:

```typescript
  private async completeFaceMatch(
    clientId: string,
    onboarding: { identityVerified: boolean | null; bvnSelfie: string | null; ninSelfie: string | null },
    liveSelfieKey: string,
  ) {
    const [bvnMatch, ninMatch] = await Promise.all([
      this.faceVerificationProvider.compare(onboarding.bvnSelfie!, liveSelfieKey),
      this.faceVerificationProvider.compare(onboarding.ninSelfie!, liveSelfieKey),
    ]);

    const faceMatchPassed = bvnMatch.passed && ninMatch.passed;
    const completed = Boolean(onboarding.identityVerified) && faceMatchPassed;

    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        liveSelfieKey,
        faceMatchBvnScore: bvnMatch.score,
        faceMatchNinScore: ninMatch.score,
        faceMatchPassed,
        step: completed ? OnboardingStep.COMPLETED : OnboardingStep.FACE_MATCH_PENDING,
        failureReasons: completed
          ? null
          : { identityVerified: onboarding.identityVerified, faceMatchPassed },
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: completed ? ClientStatus.VERIFIED : ClientStatus.MANUAL_REVIEW },
    });

    return updated;
  }

  async submitFaceMatch(clientId: string, selfieBuffer: Buffer) {
    const onboarding = await this.requireOnboarding(clientId);
    if (
      onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED &&
      onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED &&
      onboarding.step !== OnboardingStep.COMPLETED
    ) {
      throw new ConflictException(
        `Expected step IDENTITY_SUBMITTED, DOCUMENTS_SUBMITTED, or COMPLETED, but client is at ${onboarding.step}`,
      );
    }

    const liveSelfieKey = `client-onboarding/${clientId}/live-selfie.jpg`;
    await this.fileStorageProvider.putObject(liveSelfieKey, selfieBuffer);

    return this.completeFaceMatch(clientId, onboarding, liveSelfieKey);
  }

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat: add passport-photo face-match for admin onboarding, allow live-selfie re-confirmation after COMPLETED"
```

---

### Task 4: `createOnboardingRecord` extraction + resumable `linkIppis` + `adminStartOnboarding`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts:27-68`
- Test: `src/client-onboarding/client-onboarding.service.spec.ts` (mock setup + `linkIppis`/new describe block)

**Interfaces:**
- Produces: `ClientOnboardingService.adminStartOnboarding(ippisNumber: string, adminId: string): Promise<ClientOnboarding>` — consumed by Task 5's controller. `linkIppis` now returns the existing record instead of throwing when one already exists.

- [ ] **Step 1: Extend the test mock shape**

In `src/client-onboarding/client-onboarding.service.spec.ts`, find:

```typescript
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
```
Replace with:
```typescript
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock; upsert: jest.Mock };
```

Find:
```typescript
      client: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
```
Replace with:
```typescript
      client: { findUniqueOrThrow: jest.fn(), update: jest.fn(), upsert: jest.fn() },
```

- [ ] **Step 2: Write the failing tests**

Find:

```typescript
    it('rejects when onboarding already started for this client', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(ConflictException);
    });
```

Replace with:

```typescript
    it('returns the existing onboarding when one already exists for this client', async () => {
      const existingOnboarding = { id: 'existing', step: 'IDENTITY_SUBMITTED' };
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.linkIppis('client-1', 'NPF/1');

      expect(result).toBe(existingOnboarding);
      expect(prisma.ippisRecord.findFirst).not.toHaveBeenCalled();
    });
```

Then find (closing of the `linkIppis` describe block, right before `submitIdentity`'s):

```typescript
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });
  });

  describe('submitIdentity', () => {
```

Replace with:

```typescript
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });
  });

  describe('adminStartOnboarding', () => {
    it('rejects when the IPPIS number is not found', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.adminStartOnboarding('NPF/1', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the existing onboarding when this IPPIS record is already linked', async () => {
      const existingOnboarding = { id: 'existing', step: 'DOCUMENTS_SUBMITTED' };
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.adminStartOnboarding('NPF/1', 'admin-1');

      expect(result).toBe(existingOnboarding);
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('rejects with UnprocessableEntityException when the IPPIS record has no phone number on file', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: null });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.adminStartOnboarding('NPF/1', 'admin-1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('resolves the client by the phone on the IPPIS record and creates the onboarding with onboardedById', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '+2348000000000',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.adminStartOnboarding('NPF/1', 'admin-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348000000000' },
        update: {},
        create: { phone: '+2348000000000', createdById: 'admin-1' },
      });
      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          onboardedById: 'admin-1',
        }),
      });
    });
  });

  describe('submitIdentity', () => {
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts -t adminStartOnboarding`
Expected: FAIL with "service.adminStartOnboarding is not a function"

- [ ] **Step 4: Extract `createOnboardingRecord`, make `linkIppis` resumable, add `adminStartOnboarding`**

In `src/client-onboarding/client-onboarding.service.ts`, find the entire `linkIppis` method:

```typescript
  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      throw new ConflictException('Onboarding already started for this client');
    }

    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const alreadyLinked = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (alreadyLinked) {
      throw new ConflictException('This IPPIS record is already linked to another client');
    }

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

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: ClientStatus.PENDING_IPPIS },
    });

    return onboarding;
  }
```

Replace with:

```typescript
  private async createOnboardingRecord(
    clientId: string,
    ippisRecord: {
      id: string;
      employeeName: string;
      agency: string;
      bankName: string | null;
      accountNumber: string | null;
      employeeStatus: string | null;
      legacyId: string | null;
      maritalStatus: string | null;
    },
    onboardedById?: string,
  ) {
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
        onboardedById,
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: ClientStatus.PENDING_IPPIS },
    });

    return onboarding;
  }

  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      return existing;
    }

    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const alreadyLinked = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (alreadyLinked) {
      throw new ConflictException('This IPPIS record is already linked to another client');
    }

    return this.createOnboardingRecord(clientId, ippisRecord);
  }

  async adminStartOnboarding(ippisNumber: string, adminId: string) {
    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const existing = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (existing) {
      return existing;
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

    return this.createOnboardingRecord(client.id, ippisRecord, adminId);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat: make linkIppis resumable, add IPPIS-first adminStartOnboarding"
```

---

### Task 5: `AdminClientOnboardingController`

**Files:**
- Create: `src/client-onboarding/admin-client-onboarding.controller.ts`
- Modify: `src/client-onboarding/client-onboarding.module.ts`

**Interfaces:**
- Consumes: `ClientOnboardingService.adminStartOnboarding`, `.submitIdentityVerified`, `.uploadDocument`, `.submitFaceMatchFromPassportPhoto`, `.getStatus` (all from Tasks 2-4, plus the pre-existing `uploadDocument`/`getStatus`).
- Consumes: `LinkIppisDto`, `SubmitIdentityDto` (pre-existing DTOs, reused as-is).
- Produces: HTTP routes consumed by Task 7's e2e tests and Task 8's Postman collection.

- [ ] **Step 1: Create the controller**

Create `src/client-onboarding/admin-client-onboarding.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { ClientOnboardingService } from './client-onboarding.service';
import { LinkIppisDto } from './dto/link-ippis.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { ClientDocumentType } from '../generated/prisma/client';

@Controller('admin/clients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('onboarding/ippis-lookup')
  @RequirePermissions('clients:onboard')
  startOnboarding(@Body() dto: LinkIppisDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.adminStartOnboarding(dto.ippisNumber, req.user.sub);
  }

  @Post(':clientId/onboarding/identity')
  @RequirePermissions('clients:onboard')
  submitIdentity(@Param('clientId') clientId: string, @Body() dto: SubmitIdentityDto) {
    return this.clientOnboardingService.submitIdentityVerified(clientId, dto.bvn, dto.nin);
  }

  @Post(':clientId/onboarding/documents/:type')
  @RequirePermissions('clients:onboard')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (
        _req: Express.Request,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG, PNG, or PDF files are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadDocument(
    @Param('clientId') clientId: string,
    @Param('type', new ParseEnumPipe(ClientDocumentType)) type: ClientDocumentType,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.clientOnboardingService.uploadDocument(clientId, type, file);
  }

  @Post(':clientId/onboarding/face-match')
  @RequirePermissions('clients:onboard')
  submitFaceMatch(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.submitFaceMatchFromPassportPhoto(clientId);
  }

  @Get(':clientId/onboarding/status')
  @RequirePermissions('clients:onboard')
  getStatus(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.getStatus(clientId);
  }
}
```

- [ ] **Step 2: Register the controller**

In `src/client-onboarding/client-onboarding.module.ts`, find:

```typescript
import { ClientOnboardingController } from './client-onboarding.controller';
import { ClientOnboardingService } from './client-onboarding.service';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FaceVerificationModule } from '../face-verification/face-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
  imports: [IdentityVerificationModule, FaceVerificationModule, FileStorageModule],
  controllers: [ClientOnboardingController],
  providers: [ClientOnboardingService],
  exports: [ClientOnboardingService],
})
export class ClientOnboardingModule {}
```

Replace with:

```typescript
import { ClientOnboardingController } from './client-onboarding.controller';
import { AdminClientOnboardingController } from './admin-client-onboarding.controller';
import { ClientOnboardingService } from './client-onboarding.service';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FaceVerificationModule } from '../face-verification/face-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
  imports: [IdentityVerificationModule, FaceVerificationModule, FileStorageModule],
  controllers: [ClientOnboardingController, AdminClientOnboardingController],
  providers: [ClientOnboardingService],
  exports: [ClientOnboardingService],
})
export class ClientOnboardingModule {}
```

- [ ] **Step 3: Build check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors

- [ ] **Step 4: Commit**

```bash
git add src/client-onboarding/admin-client-onboarding.controller.ts src/client-onboarding/client-onboarding.module.ts
git commit -m "feat: add AdminClientOnboardingController"
```

---

### Task 6: Hydrate `createdByAdmin`/`onboardedByAdmin` into `GET /admin/clients/:id`

**Files:**
- Modify: `src/admin-client-review/admin-client-review.service.ts:56-65`
- Test: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: `Client.createdByAdmin`, `ClientOnboarding.onboardedByAdmin` relations from Task 1.
- Produces: `findById(id)`'s response now includes `createdByAdmin` at the top level and `onboarding.onboardedByAdmin`, consumed by Task 7's e2e assertions (optional) and Task 8's Postman example.

- [ ] **Step 1: Write the failing test**

In `src/admin-client-review/admin-client-review.service.spec.ts`, find:

```typescript
    it('includes a computed lengthOfService from the linked IppisRecord', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', ippisRecord: { hireDate } },
      });

      const result = await service.findById('c1');

      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: {
          onboarding: {
            include: {
              documents: true,
              ippisRecord: true,
              reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            },
          },
        },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
    });

    it('surfaces the reviewedByAdmin relation when the onboarding has been reviewed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
```

Replace with:

```typescript
    it('includes a computed lengthOfService from the linked IppisRecord', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', ippisRecord: { hireDate } },
      });

      const result = await service.findById('c1');

      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: {
          createdByAdmin: { select: { id: true, fullName: true, email: true } },
          onboarding: {
            include: {
              documents: true,
              ippisRecord: true,
              reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
              onboardedByAdmin: { select: { id: true, fullName: true, email: true } },
            },
          },
        },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
    });

    it('surfaces the reviewedByAdmin relation when the onboarding has been reviewed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });

    it('surfaces createdByAdmin and onboardedByAdmin when the client/onboarding were admin-initiated', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        createdByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' },
        onboarding: { id: 'o1', onboardedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.createdByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
      expect(result.onboarding.onboardedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts -t "includes a computed lengthOfService"`
Expected: FAIL — `prisma.client.findUnique` was called without `createdByAdmin`/`onboardedByAdmin` in the `include`

- [ ] **Step 3: Update the `include` clause**

In `src/admin-client-review/admin-client-review.service.ts`, find:

```typescript
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        onboarding: {
          include: {
            documents: true,
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });
```

Replace with:

```typescript
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        createdByAdmin: { select: { id: true, fullName: true, email: true } },
        onboarding: {
          include: {
            documents: true,
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            onboardedByAdmin: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: hydrate createdByAdmin/onboardedByAdmin on GET /admin/clients/:id"
```

---

### Task 7: e2e coverage

**Files:**
- Create: `test/admin-client-onboarding.e2e-spec.ts`

**Interfaces:**
- Consumes: every endpoint from Task 5, `TokenService.signAccessToken({ sub, type })` (existing, used the same way `test/client-onboarding.e2e-spec.ts` does to mint a client token directly instead of going through OTP).

- [ ] **Step 1: Write the e2e test file**

Create `test/admin-client-onboarding.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin-initiated client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let adminAccessToken: string;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const documentTypes = ['NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE'];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);

    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = adminLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.clientDocument.deleteMany({
      where: { clientOnboarding: { clientId: { in: createdClientIds } } },
    });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await app.close();
  });

  it('runs the full admin journey: ippis-lookup creates the client, identity verifies, 4 documents, passport face-match completes', async () => {
    const staffId = `E2E-ADMIN-ONBOARD-${Date.now()}`;
    const phone = `+234803${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Admin Onboarded Client',
        bankName: 'Test Bank',
        accountNumber: '0000000010',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(lookupRes.body.step).toBe('IPPIS_LINKED');
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    const createdClient = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(createdClient.phone).toBe(phone);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IDENTITY_SUBMITTED');
        expect(res.body.identityVerified).toBe(true);
      });

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/admin/clients/${clientId}/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/face-match`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');

    await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.createdByAdmin).not.toBeNull();
        expect(res.body.onboarding.onboardedByAdmin).not.toBeNull();
      });
  }, 20000);

  it('returns 422 when the IPPIS record has no phone number on file', async () => {
    const staffId = `E2E-ADMIN-NOPHONE-${Date.now()}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'No Phone Client',
        bankName: 'Test Bank',
        accountNumber: '0000000011',
      },
    });

    await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(422);
  });

  it('returns 404 for an unknown IPPIS number', async () => {
    await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: 'NOT-A-REAL-STAFF-ID' })
      .expect(404);
  });

  it('resumes an admin-started onboarding when the client later logs in and calls ippis-link themselves', async () => {
    const staffId = `E2E-ADMIN-RESUME-${Date.now()}`;
    const phone = `+234804${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Resume Flow Client',
        bankName: 'Test Bank',
        accountNumber: '0000000012',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201);

    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    const resumeRes = await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(resumeRes.body.step).toBe('IDENTITY_SUBMITTED');
    expect(resumeRes.body.clientId).toBe(clientId);

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/client/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${clientAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  }, 20000);

  it('lets a client submit a real selfie to re-confirm after admin already completed onboarding via passport photo', async () => {
    const staffId = `E2E-ADMIN-RECONFIRM-${Date.now()}`;
    const phone = `+234805${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Reconfirm Flow Client',
        bankName: 'Test Bank',
        accountNumber: '0000000013',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201);

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/admin/clients/${clientId}/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/face-match`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
      });

    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('selfie', Buffer.from('real-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  }, 20000);
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npx jest --config ./test/jest-e2e.json admin-client-onboarding`
Expected: PASS, all 5 tests

- [ ] **Step 3: Run the full suite (end of plan — per this repo's convention, full-suite runs happen here, not per-task)**

Run: `npm test && npm run test:e2e`
Expected: PASS, no regressions in `client-onboarding.service.spec.ts`, `admin-client-review.service.spec.ts`, `client-onboarding.e2e-spec.ts`, or elsewhere

- [ ] **Step 4: Commit**

```bash
git add test/admin-client-onboarding.e2e-spec.ts
git commit -m "test: add e2e coverage for admin-initiated client onboarding"
```

---

### Task 8: Postman collection

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: the exact request/response shapes verified by Task 7's e2e tests.

- [ ] **Step 1: Write and run the insertion script**

Create a one-off script (not committed) at `/tmp/insert-admin-onboarding-postman.py`:

```python
import json

PATH = 'postman/public-sector-backend.postman_collection.json'

with open(PATH, encoding='utf-8') as f:
    data = json.load(f)

admin_folder = next(item for item in data['item'] if item['name'] == 'Admin')
client_review_index = next(
    i for i, item in enumerate(admin_folder['item']) if item['name'] == 'Client Review'
)

def req(name, method, path, body=None, auth=True, file_field=None):
    url = {
        'raw': '{{base_url}}/' + path,
        'host': ['{{base_url}}'],
        'path': path.split('/'),
    }
    request = {'method': method, 'header': [], 'url': url}
    if auth:
        request['header'].append({'key': 'Authorization', 'value': 'Bearer {{admin_access_token}}'})
    if body is not None:
        request['header'].append({'key': 'Content-Type', 'value': 'application/json'})
        request['body'] = {'mode': 'raw', 'raw': json.dumps(body)}
    item = {'name': name, 'request': request}
    return item

def with_test(item, script_lines):
    item['event'] = [{'listen': 'test', 'script': {'exec': script_lines}}]
    return item

def with_response(item, name, status, code, body, content_type='application/json'):
    item.setdefault('response', []).append({
        'name': name,
        'originalRequest': item['request'],
        'status': status,
        'code': code,
        '_postman_previewlanguage': 'json' if content_type == 'application/json' else 'text',
        'header': [{'key': 'Content-Type', 'value': content_type}],
        'cookie': [],
        'body': json.dumps(body, indent=2) if content_type == 'application/json' else body,
    })
    return item

lookup = req(
    "POST /admin/clients/onboarding/ippis-lookup - Success (201)",
    'POST', 'admin/clients/onboarding/ippis-lookup',
    body={'ippisNumber': 'NPF/10234'},
)
lookup = with_test(lookup, [
    "pm.test('status 201', () => pm.response.to.have.status(201));",
    "if (pm.response.code === 201) { pm.collectionVariables.set('onboarding_client_id', pm.response.json().clientId); }",
])
lookup = with_response(lookup, 'Success - new client created (201)', 'Created', 201, {
    'id': 'b7a1c2d3-1111-4a2b-8c3d-4e5f6a7b8c9d',
    'clientId': 'c1a2b3c4-d5e6-4f78-9a0b-1c2d3e4f5a6b',
    'ippisRecordId': 'e3c4d5e6-f7a8-4b9c-0d1e-3f4a5b6c7d8e',
    'employeeName': 'Ibrahim Suleiman',
    'agency': 'Nigeria Police Force',
    'bankName': 'GTBank',
    'accountNumber': '0123456789',
    'employeeStatus': 'ACTIVE',
    'legacyId': 'LEGACY-0099',
    'maritalStatus': None,
    'step': 'IPPIS_LINKED',
    'onboardedById': 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    'createdAt': '2026-10-02T09:00:00.000Z',
    'updatedAt': '2026-10-02T09:00:00.000Z',
})
lookup = with_response(lookup, 'Not found - unknown IPPIS number (404)', 'Not Found', 404, {
    'statusCode': 404, 'message': 'IPPIS number not found', 'error': 'Not Found',
})
lookup = with_response(lookup, 'Unprocessable - no phone number on file for this IPPIS record (422)', 'Unprocessable Entity', 422, {
    'statusCode': 422,
    'message': 'No phone number on file for this IPPIS record — cannot resolve a client',
    'error': 'Unprocessable Entity',
})
lookup = with_response(lookup, 'Forbidden - missing clients:onboard permission (403)', 'Forbidden', 403, {
    'statusCode': 403, 'message': 'Insufficient permissions', 'error': 'Forbidden',
})

identity = req(
    "POST /admin/clients/:clientId/onboarding/identity - Success (201)",
    'POST', 'admin/clients/{{onboarding_client_id}}/onboarding/identity',
    body={'bvn': '12345678901', 'nin': '98765432109'},
)
identity['request']['description'] = 'clientId is populated automatically by the ippis-lookup request above.'
identity = with_response(identity, 'Success - BVN/NIN verified (201)', 'Created', 201, {
    'id': 'b7a1c2d3-1111-4a2b-8c3d-4e5f6a7b8c9d',
    'clientId': 'c1a2b3c4-d5e6-4f78-9a0b-1c2d3e4f5a6b',
    'identityVerified': True,
    'step': 'IDENTITY_SUBMITTED',
    'identityGender': 'Female',
    'stateOfOrigin': 'Lagos',
    'address': '1 Mock Street',
    'city': 'Mocktown',
})
identity = with_response(identity, 'Unprocessable - BVN/NIN did not verify (422)', 'Unprocessable Entity', 422, {
    'statusCode': 422,
    'message': 'BVN/NIN verification failed — identity could not be confirmed',
    'error': 'Unprocessable Entity',
})

doc_upload = req(
    "POST /admin/clients/:clientId/onboarding/documents/:type - Success (201)",
    'POST', 'admin/clients/{{onboarding_client_id}}/onboarding/documents/PASSPORT_PHOTO',
)
doc_upload['request']['body'] = {
    'mode': 'formdata',
    'formdata': [{'key': 'file', 'type': 'file', 'src': []}],
}
doc_upload['request']['description'] = (
    'Repeat for NIN_CARD, WORK_ID, and SIGNATURE as well — all 4 document types must be '
    'uploaded before the face-match request below will succeed.'
)
doc_upload = with_response(doc_upload, 'Success (201)', 'Created', 201, {
    'id': 'd4e5f6a7-2222-4b3c-9d4e-5f6a7b8c9d0e',
    'clientOnboardingId': 'b7a1c2d3-1111-4a2b-8c3d-4e5f6a7b8c9d',
    'documentType': 'PASSPORT_PHOTO',
    'storageKey': 'client-onboarding/c1a2b3c4-d5e6-4f78-9a0b-1c2d3e4f5a6b/documents/passport_photo.jpg',
    'uploadedAt': '2026-10-02T09:05:00.000Z',
})
doc_upload = with_response(doc_upload, 'Validation error - disallowed file type (400)', 'Bad Request', 400, {
    'statusCode': 400, 'message': 'Only JPEG, PNG, or PDF files are allowed', 'error': 'Bad Request',
})

face_match = req(
    "POST /admin/clients/:clientId/onboarding/face-match - Success (201)",
    'POST', 'admin/clients/{{onboarding_client_id}}/onboarding/face-match',
)
face_match['request']['description'] = (
    'No file/body needed — compares the already-uploaded PASSPORT_PHOTO document against the '
    'BVN/NIN lookup photos instead of a live selfie. All 4 documents must be uploaded first.'
)
face_match = with_response(face_match, 'Success - completed and VERIFIED (201)', 'Created', 201, {
    'id': 'b7a1c2d3-1111-4a2b-8c3d-4e5f6a7b8c9d',
    'clientId': 'c1a2b3c4-d5e6-4f78-9a0b-1c2d3e4f5a6b',
    'faceMatchBvnScore': 0.95,
    'faceMatchNinScore': 0.95,
    'faceMatchPassed': True,
    'step': 'COMPLETED',
})
face_match = with_response(face_match, 'Conflict - documents not fully submitted yet (409)', 'Conflict', 409, {
    'statusCode': 409,
    'message': 'Expected step DOCUMENTS_SUBMITTED, but client is at IDENTITY_SUBMITTED',
    'error': 'Conflict',
})
face_match = with_response(face_match, 'Unprocessable - passport photo uploaded as a PDF (422)', 'Unprocessable Entity', 422, {
    'statusCode': 422,
    'message': 'Passport photo was uploaded as a PDF — an image (JPEG/PNG) is required for face comparison',
    'error': 'Unprocessable Entity',
})

status_req = req(
    "GET /admin/clients/:clientId/onboarding/status - Success (200)",
    'GET', 'admin/clients/{{onboarding_client_id}}/onboarding/status',
)
status_req = with_response(status_req, 'Success (200)', 'OK', 200, {
    'step': 'COMPLETED',
    'clientStatus': 'VERIFIED',
    'onboarding': {
        'employeeName': 'Ibrahim Suleiman',
        'agency': 'Nigeria Police Force',
        'step': 'COMPLETED',
    },
    'lengthOfService': {'years': 4, 'months': 2},
})

new_folder = {
    'name': 'Client Onboarding',
    'description': (
        "Admin-initiated onboarding: an admin runs the same IPPIS link -> identity -> documents -> "
        "face-match journey on a client's behalf, substituting the uploaded passport photo for a "
        "live selfie. Requires clients:onboard. See docs/superpowers/specs/"
        "2026-10-02-admin-client-onboarding-design.md."
    ),
    'item': [lookup, identity, doc_upload, face_match, status_req],
}

admin_folder['item'].insert(client_review_index + 1, new_folder)

variables = data.setdefault('variable', [])
if not any(v.get('key') == 'onboarding_client_id' for v in variables):
    variables.append({'key': 'onboarding_client_id', 'value': ''})

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
```

Run: `python3 /tmp/insert-admin-onboarding-postman.py`
Expected: exits with no output/error

- [ ] **Step 2: Patch the existing `GET /admin/clients/:id` example**

In `postman/public-sector-backend.postman_collection.json`, find the saved response example for `GET /admin/clients/:id - Success` (search for `"legacyId": "LEGACY-0099"` to locate it) and add two fields to its JSON body: a top-level `"createdByAdmin": null` and, inside the `onboarding` object, `"onboardedByAdmin": null` — reflecting that this particular saved example is of a self-service client (both null), while the new "Client Onboarding" folder's own examples show the admin-initiated case (non-null). Use Edit with the exact surrounding JSON text as anchor, same way every other field in that example was added historically (see `git log -p` on this file for the pattern from commit `9186e45`, which added `reviewedByAdmin` the same way).

- [ ] **Step 3: Validate the collection is still valid JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo OK`
Expected: `OK`

- [ ] **Step 4: Clean up and commit**

```bash
rm /tmp/insert-admin-onboarding-postman.py
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs: add Postman coverage for admin-initiated client onboarding"
```
