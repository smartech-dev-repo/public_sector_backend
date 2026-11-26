# Client Onboarding Document Collection Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required, gating document-upload step (NIN Card, Work ID, Passport Photo, Signature) to the client onboarding pipeline, with admin-viewable signed URLs for each.

**Architecture:** A new generic-by-type `ClientDocument` table and a new `OnboardingStep.DOCUMENTS_SUBMITTED` value slotted between `IDENTITY_SUBMITTED` and `FACE_MATCH_PENDING`. `ClientOnboardingService` gains `uploadDocument()` and a shared `determineStepAfterIdentity()` helper, the latter also consumed by `AdminClientReviewService.retry()` (a new cross-module dependency) so a retry never forces a redundant document re-upload. `AdminClientReviewService.findById()` resolves each document's storage key to a signed URL via the already-existing `FileStorageProvider.getSignedDownloadUrl`.

**Tech Stack:** NestJS 10, Prisma 7, Jest, Multer, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-22-client-onboarding-documents-design.md`

## Global Constraints

- `ClientDocument` is a new, generic-by-type table (`clientOnboardingId`+`documentType` unique) — not four fixed columns (spec §2).
- `OnboardingStep` gains `DOCUMENTS_SUBMITTED` between `IDENTITY_SUBMITTED` and `FACE_MATCH_PENDING` (spec §2).
- The upload endpoint is allowed from `IDENTITY_SUBMITTED` **or** `DOCUMENTS_SUBMITTED` (re-upload of one document doesn't require all 4 still outstanding); re-uploading a type replaces its row, not a duplicate (spec §3).
- New file validation on this new endpoint only: JPEG/PNG/PDF, capped at 5MB (spec §3) — this codebase has no such limits configured anywhere else today, and this plan doesn't retrofit any existing endpoint.
- `determineStepAfterIdentity(onboardingId)` — a single shared helper consumed by both `ClientOnboardingService.submitIdentity` and `AdminClientReviewService.retry`'s face-match-only branch, so a retry never forces a redundant document re-upload when all 4 are already present (spec §4).
- `AdminClientReviewService.findById` resolves each `ClientDocument.storageKey` to a signed URL via the existing `FileStorageProvider.getSignedDownloadUrl` — reusing existing infrastructure, not building new (spec §5).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task. This spec is a standalone, single-plan initiative — its own final task runs the one genuine full-suite check, the same way a phase's last plan would.

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `ClientDocumentType` enum (`NIN_CARD`/`WORK_ID`/`PASSPORT_PHOTO`/`SIGNATURE`), `ClientDocument` model, `OnboardingStep.DOCUMENTS_SUBMITTED` — every later task depends on these exact names.

- [ ] **Step 1: Add the enum and model**

In `prisma/schema.prisma`, add (near `ClientOnboarding`):

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

Add the inverse relation to `ClientOnboarding`:

```prisma
  documents ClientDocument[]
```

- [ ] **Step 2: Add the new `OnboardingStep` value**

Find the existing `enum OnboardingStep { PHONE_VERIFIED IPPIS_LINKED IDENTITY_SUBMITTED FACE_MATCH_PENDING COMPLETED }` and insert `DOCUMENTS_SUBMITTED` between `IDENTITY_SUBMITTED` and `FACE_MATCH_PENDING`:

```prisma
enum OnboardingStep {
  PHONE_VERIFIED
  IPPIS_LINKED
  IDENTITY_SUBMITTED
  DOCUMENTS_SUBMITTED
  FACE_MATCH_PENDING
  COMPLETED
}
```

- [ ] **Step 3: Generate and run the migration**

Run: `npx prisma migrate dev --name add_client_document_collection`
Expected: creates and applies `prisma/migrations/<timestamp>_add_client_document_collection/migration.sql`.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ClientDocument schema and DOCUMENTS_SUBMITTED onboarding step"
```

---

### Task 2: `ClientOnboardingService.uploadDocument` and the upload endpoint

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`
- Modify: `src/client-onboarding/client-onboarding.controller.ts`

**Interfaces:**
- Produces: `ClientOnboardingService.determineStepAfterIdentity(onboardingId: string): Promise<OnboardingStep>`, `.uploadDocument(clientId: string, documentType: ClientDocumentType, file: Express.Multer.File): Promise<ClientDocument>` — Task 3's `AdminClientReviewService.retry` consumes `determineStepAfterIdentity`.

- [ ] **Step 1: Widen the `prisma` mock and write the failing tests**

Read `src/client-onboarding/client-onboarding.service.spec.ts`'s current full state first (shown in this plan's own research above). Widen the `prisma` mock's type declaration and `beforeEach` to add a `clientDocument` entry:

```typescript
    clientDocument: { count: jest.Mock; upsert: jest.Mock };
```

```typescript
      clientDocument: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn() },
```

Update the existing `submitIdentity` describe block's third test (`'looks up BVN and NIN, stores both photos, and marks identityVerified'`) — its mocked onboarding object currently lacks an `id`, which the new `determineStepAfterIdentity` call needs:

```typescript
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
```

(The default `clientDocument.count` mock of `0` from `beforeEach` means `determineStepAfterIdentity` still resolves to `IDENTITY_SUBMITTED`, so the rest of that test's existing assertions are unaffected.)

Now append these new describe blocks, after `submitIdentity`'s:

```typescript
  describe('determineStepAfterIdentity', () => {
    it('returns IDENTITY_SUBMITTED when fewer than 4 documents exist', async () => {
      prisma.clientDocument.count.mockResolvedValue(3);
      const result = await service.determineStepAfterIdentity('onboarding-1');
      expect(result).toBe('IDENTITY_SUBMITTED');
    });

    it('returns DOCUMENTS_SUBMITTED when all 4 documents exist', async () => {
      prisma.clientDocument.count.mockResolvedValue(4);
      const result = await service.determineStepAfterIdentity('onboarding-1');
      expect(result).toBe('DOCUMENTS_SUBMITTED');
    });
  });

  describe('uploadDocument', () => {
    const file = { originalname: 'nin.jpg', buffer: Buffer.from('fake') } as Express.Multer.File;

    it('rejects when the client has no onboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.uploadDocument('client-1', 'NIN_CARD' as never, file)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects when the client is not at IDENTITY_SUBMITTED or DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      await expect(service.uploadDocument('client-1', 'NIN_CARD' as never, file)).rejects.toThrow(
        ConflictException,
      );
    });

    it('uploads a document and does not advance the step when fewer than 4 documents exist', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-1' });
      prisma.clientDocument.count.mockResolvedValue(1);

      await service.uploadDocument('client-1', 'NIN_CARD' as never, file);

      expect(fileStorageProvider.putObject).toHaveBeenCalledWith(
        'client-onboarding/client-1/documents/nin_card.jpg',
        file.buffer,
      );
      expect(prisma.clientDocument.upsert).toHaveBeenCalledWith({
        where: { clientOnboardingId_documentType: { clientOnboardingId: 'onboarding-1', documentType: 'NIN_CARD' } },
        create: {
          clientOnboardingId: 'onboarding-1',
          documentType: 'NIN_CARD',
          storageKey: 'client-onboarding/client-1/documents/nin_card.jpg',
        },
        update: {
          storageKey: 'client-onboarding/client-1/documents/nin_card.jpg',
          uploadedAt: expect.any(Date),
        },
      });
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });

    it('advances the step to DOCUMENTS_SUBMITTED once the 4th document is uploaded', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-4' });
      prisma.clientDocument.count.mockResolvedValue(4);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });

      await service.uploadDocument('client-1', 'SIGNATURE' as never, file);

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: { step: 'DOCUMENTS_SUBMITTED' },
      });
    });

    it('does not re-trigger the step update when already at DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-1' });
      prisma.clientDocument.count.mockResolvedValue(4);

      await service.uploadDocument('client-1', 'NIN_CARD' as never, file);

      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: FAIL — `service.determineStepAfterIdentity is not a function` / `service.uploadDocument is not a function`.

- [ ] **Step 3: Implement the service changes**

In `src/client-onboarding/client-onboarding.service.ts`, add this import (merge `ClientDocumentType` into the existing `'../generated/prisma/client'` import line) and add `import { extname } from 'path';`.

Add these two methods to the class, after `submitIdentity`:

```typescript
  async determineStepAfterIdentity(onboardingId: string): Promise<OnboardingStep> {
    const documentCount = await this.prisma.clientDocument.count({
      where: { clientOnboardingId: onboardingId },
    });
    return documentCount >= Object.values(ClientDocumentType).length
      ? OnboardingStep.DOCUMENTS_SUBMITTED
      : OnboardingStep.IDENTITY_SUBMITTED;
  }

  async uploadDocument(clientId: string, documentType: ClientDocumentType, file: Express.Multer.File) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED && onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      throw new ConflictException(
        `Expected step IDENTITY_SUBMITTED or DOCUMENTS_SUBMITTED, but client is at ${onboarding.step}`,
      );
    }

    const storageKey = `client-onboarding/${clientId}/documents/${documentType.toLowerCase()}${extname(file.originalname)}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);

    const document = await this.prisma.clientDocument.upsert({
      where: { clientOnboardingId_documentType: { clientOnboardingId: onboarding.id, documentType } },
      create: { clientOnboardingId: onboarding.id, documentType, storageKey },
      update: { storageKey, uploadedAt: new Date() },
    });

    const nextStep = await this.determineStepAfterIdentity(onboarding.id);
    if (nextStep === OnboardingStep.DOCUMENTS_SUBMITTED && onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      await this.prisma.clientOnboarding.update({ where: { clientId }, data: { step: nextStep } });
    }

    return document;
  }
```

Replace `submitIdentity`'s final `return` statement (the `this.prisma.clientOnboarding.update({...})` call) to compute `step` via the new helper instead of hardcoding it:

```typescript
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
      },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step (this task added 2 `determineStepAfterIdentity` tests + 5 `uploadDocument` tests = 7 new tests on top of the file's pre-existing count) rather than trusting a specific stated number.

- [ ] **Step 5: Add the controller endpoint**

In `src/client-onboarding/client-onboarding.controller.ts`, add these imports:

```typescript
import { BadRequestException, Param, ParseEnumPipe } from '@nestjs/common';
import { ClientDocumentType } from '../generated/prisma/client';
```

(Merge `BadRequestException`/`Param`/`ParseEnumPipe` into the existing `@nestjs/common` import line.)

Add this method after `submitFaceMatch`:

```typescript
  @Post('documents/:type')
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
    @Param('type', new ParseEnumPipe(ClientDocumentType)) type: ClientDocumentType,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.clientOnboardingService.uploadDocument(req.user.sub, type, file);
  }
```

- [ ] **Step 6: Type-check and run the client-onboarding unit suite**

Run: `npx tsc --noEmit && npx jest src/client-onboarding`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts src/client-onboarding/client-onboarding.controller.ts
git commit -m "feat: add document upload endpoint to client onboarding"
```

---

### Task 3: Wire `determineStepAfterIdentity` into admin `retry`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.module.ts`
- Modify: `src/admin-client-review/admin-client-review.module.ts`
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: `ClientOnboardingService.determineStepAfterIdentity` (Task 2).
- Produces: `AdminClientReviewService`'s constructor gains a required `clientOnboardingService: ClientOnboardingService` parameter.

- [ ] **Step 1: Export `ClientOnboardingService`**

In `src/client-onboarding/client-onboarding.module.ts`, add `exports: [ClientOnboardingService]` to the `@Module` decorator (it currently has no `exports` array).

- [ ] **Step 2: Write the failing tests**

Read `src/admin-client-review/admin-client-review.service.spec.ts`'s current full state first (shown in this plan's own research above). Add `import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';` to the top imports, add a `clientOnboardingService: { determineStepAfterIdentity: jest.Mock }` variable, initialize it in `beforeEach` (`clientOnboardingService = { determineStepAfterIdentity: jest.fn() };`), and update the `service = new AdminClientReviewService(...)` call to pass it as a 2nd argument:

```typescript
    service = new AdminClientReviewService(
      prisma as unknown as PrismaService,
      clientOnboardingService as unknown as ClientOnboardingService,
    );
```

Update the existing `'resets to IDENTITY_SUBMITTED and only clears face-match fields when only the face match failed'` test: add `clientOnboardingService.determineStepAfterIdentity.mockResolvedValue('IDENTITY_SUBMITTED');` before calling `service.retry(...)` (this preserves its existing assertion of `step: 'IDENTITY_SUBMITTED'` — simulating the "documents not yet complete" case).

Add a new test to the same `describe('retry', ...)` block, after it:

```typescript
    it('skips straight to DOCUMENTS_SUBMITTED when the client already has all 4 documents, on a face-match-only retry', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: true, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });
      clientOnboardingService.determineStepAfterIdentity.mockResolvedValue('DOCUMENTS_SUBMITTED');

      await service.retry('c1', 'admin-1', 'blurry selfie, please retake');

      expect(clientOnboardingService.determineStepAfterIdentity).toHaveBeenCalledWith('o1');
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({ step: 'DOCUMENTS_SUBMITTED' }),
      });
    });
```

- [ ] **Step 3: Run tests to verify the updated/new ones fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — `Expected 1 arguments, but got 2` (constructor mismatch) and/or the face-match-only test asserting a hardcoded step that the not-yet-updated service still hardcodes correctly by coincidence but without calling the mock (verify the mock method was actually invoked once the assertion for `toHaveBeenCalledWith` is added — if this specific failure mode doesn't clearly manifest before Step 4's implementation, that's fine, the constructor-arity failure alone confirms the fail-first step).

- [ ] **Step 4: Implement the service change**

In `src/admin-client-review/admin-client-review.service.ts`, add `import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';` and change the constructor:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientOnboardingService: ClientOnboardingService,
  ) {}
```

Change the `retry` method's `resetData` assignment — replace the hardcoded `step: OnboardingStep.IDENTITY_SUBMITTED` in the face-match-only branch:

```typescript
    const resetData = identityFailed
      ? {
          step: OnboardingStep.IPPIS_LINKED,
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        }
      : {
          step: await this.clientOnboardingService.determineStepAfterIdentity(client.onboarding.id),
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks (this task added 1 new test on top of the file's pre-existing count).

- [ ] **Step 6: Wire the module dependency**

In `src/admin-client-review/admin-client-review.module.ts`, add `import { ClientOnboardingModule } from '../client-onboarding/client-onboarding.module';` and add `ClientOnboardingModule` to the `imports` array (alongside the existing `AuditModule`).

- [ ] **Step 7: Type-check and run the admin-client-review unit suite**

Run: `npx tsc --noEmit && npx jest src/admin-client-review`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/client-onboarding/client-onboarding.module.ts src/admin-client-review/admin-client-review.module.ts src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: skip a redundant document re-upload on a documents-complete retry"
```

---

### Task 4: Admin document visibility

**Files:**
- Modify: `src/admin-client-review/admin-client-review.module.ts`
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: `FileStorageProvider.getSignedDownloadUrl` (existing, unchanged).
- Produces: `AdminClientReviewService.findById`'s response gains `onboarding.documents: Array<{ documentType: ClientDocumentType; url: string; uploadedAt: Date }>` when an onboarding record exists.

- [ ] **Step 1: Write the failing tests**

Read `src/admin-client-review/admin-client-review.service.spec.ts`'s current state first (as modified by Task 3). Add `import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';` to the top imports, add a `fileStorageProvider: { getSignedDownloadUrl: jest.Mock }` variable, initialize it in `beforeEach`, and update the construction call to pass it as a 3rd argument:

```typescript
    service = new AdminClientReviewService(
      prisma as unknown as PrismaService,
      clientOnboardingService as unknown as ClientOnboardingService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
```

Append these tests to the existing `describe('findById', ...)` block:

```typescript
    it('resolves each document storageKey to a signed URL', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: {
          id: 'o1',
          documents: [
            { documentType: 'NIN_CARD', storageKey: 'client-onboarding/c1/documents/nin_card.jpg', uploadedAt: new Date('2026-01-01') },
          ],
        },
      });
      fileStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://signed-url.example/nin_card.jpg');

      const result = await service.findById('c1');

      expect(fileStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'client-onboarding/c1/documents/nin_card.jpg',
      );
      expect(result.onboarding.documents).toEqual([
        { documentType: 'NIN_CARD', url: 'https://signed-url.example/nin_card.jpg', uploadedAt: new Date('2026-01-01') },
      ]);
    });

    it('does not fail when the client has no onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'PHONE_VERIFIED', onboarding: null });
      const result = await service.findById('c1');
      expect(result.onboarding).toBeNull();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — `Expected 2 arguments, but got 3` (constructor mismatch), and/or `result.onboarding.documents` being `undefined` rather than the resolved array.

- [ ] **Step 3: Implement the service change**

In `src/admin-client-review/admin-client-review.service.ts`, add `import { Inject } from '@nestjs/common';` (merge into the existing `@nestjs/common` import if present) and `import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';`. Update the constructor:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientOnboardingService: ClientOnboardingService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}
```

Replace `findById`:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true } } },
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
      return { ...client, onboarding: { ...client.onboarding, documents } };
    }

    return client;
  }
```

(The `?? []` guards every other existing caller/test of `findById` — e.g. `approve`/`retry`'s own tests, whose mocked `onboarding` objects don't include a `documents` field at all — so none of them need to be touched by this task.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks (this task added 2 new tests on top of Task 3's count). The pre-existing `approve`/`retry` tests must still pass unchanged, thanks to the `?? []` guard.

- [ ] **Step 5: Wire the module dependency**

In `src/admin-client-review/admin-client-review.module.ts`, add `import { FileStorageModule } from '../file-storage/file-storage.module';` and add `FileStorageModule` to `imports`.

- [ ] **Step 6: Type-check and run the admin-client-review unit suite**

Run: `npx tsc --noEmit && npx jest src/admin-client-review`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/admin-client-review/admin-client-review.module.ts src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: resolve client document keys to signed URLs for admin"
```

---

### Task 5: e2e tests, README, Postman, and the full suite run

**Files:**
- Modify: `test/client-onboarding.e2e-spec.ts` (or create if no such file exists — check first)
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

This is the last task of this plan's own single-spec initiative — per this plan's Global Constraints, Step 7 below is a genuine full-suite run.

- [ ] **Step 1: Find and read the existing client-onboarding e2e test**

Run: `find test -iname "*onboarding*"` to find the existing e2e spec covering the onboarding pipeline (likely `client-onboarding.e2e-spec.ts` or similar — read it in full first). Extend its existing full-pipeline test (link IPPIS → submit identity → face-match → completed) to insert the new document-upload step in the correct place: after submitting identity, before face-match, upload all 4 documents via `POST /client/onboarding/documents/:type` (one request per type, e.g. `NIN_CARD`, `WORK_ID`, `PASSPORT_PHOTO`, `SIGNATURE`, each with `.attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })` via supertest), asserting `GET /client/onboarding/status` shows `step: 'DOCUMENTS_SUBMITTED'` after all 4 are uploaded but before the 4th shows an earlier step. Also add:
- a test asserting `POST /client/onboarding/documents/NIN_CARD` before identity is submitted returns `409`;
- a test asserting re-uploading the same type at `DOCUMENTS_SUBMITTED` succeeds and replaces the row (verify only one `ClientDocument` row exists for that type afterward via `prisma.clientDocument.count`);
- a test asserting `GET /admin/clients/:id` (admin JWT) returns a `documents` array with resolvable `url` fields for a client who has completed document upload.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json <the e2e spec file found in Step 1> --runInBand`
Expected: PASS.

- [ ] **Step 3: Update the README**

Find the existing client-onboarding documentation section in `README.md` and add a note about the new `DOCUMENTS_SUBMITTED` step and the `POST /client/onboarding/documents/:type` endpoint (4 required document types, JPEG/PNG/PDF only, 5MB cap), and that `GET /admin/clients/:id` now returns a `documents` array with signed, viewable URLs.

- [ ] **Step 4: Add Postman coverage**

Add `POST /client/onboarding/documents/:type` requests under Client (one representative success example, plus a wrong-step `409` and a bad-file-type `400`), and update the existing `GET /admin/clients/:id` saved response example to include the new `documents` array. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Commit**

```bash
git add test/*onboarding*.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add client onboarding document collection e2e coverage and docs"
```

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness (confirmed benign multiple times in this codebase already) rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] Step 7's full unit + e2e suite run passes clean.
- [ ] A client can upload all 4 documents after submitting identity, advancing to `DOCUMENTS_SUBMITTED`, and re-upload any one of them afterward without duplicating rows.
- [ ] Uploading before identity is submitted is rejected `409`; a disallowed file type is rejected `400`.
- [ ] A face-match-only retry skips straight to `DOCUMENTS_SUBMITTED` if all 4 documents already exist, instead of forcing a redundant re-upload.
- [ ] `GET /admin/clients/:id` returns each document with a real, resolvable URL, not just a raw storage key.
- [ ] Postman has coverage for the new endpoint and the updated admin response shape.
