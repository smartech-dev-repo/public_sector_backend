# Real Document Fixtures & Content-Type Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every file-storage URL this app produces resolves to something
genuinely openable — a real JPEG or PDF with the correct `Content-Type` —
instead of fake placeholder bytes with no MIME type at all.

**Architecture:** A shared pair of real, byte-verified fixture buffers
(JPEG + PDF) replaces fake text in every e2e test that uploads a file; a
small extension-to-MIME lookup makes the existing file-download endpoint set
`Content-Type` before streaming bytes back; a one-off, never-committed script
backfills the same real content into every already-existing stored key in
the live UAT environment.

**Tech Stack:** NestJS, Jest + Supertest, Prisma (PostgreSQL).

**Spec:** `docs/superpowers/specs/2026-10-21-real-document-fixtures-design.md`

## Global Constraints

- No Postman sync needed — no API shape change (header addition + test
  fixture content only).
- The backfill script (Task 6) must never be committed — write it, run it,
  delete it, exactly like this session's earlier test-data-cleanup script.
- Never add a `Co-Authored-By: Claude` trailer to any commit in this repo.

---

### Task 1: Shared real-file fixtures

**Files:**
- Create: `test/fixtures/sample-files.ts`

**Interfaces:**
- Produces: `SAMPLE_JPEG_BUFFER: Buffer`, `SAMPLE_PDF_BUFFER: Buffer` — both
  already byte-verified (see Step 1) as genuinely valid files, consumed by
  Tasks 3, 4, 5, and 6.

- [ ] **Step 1: Create the fixtures file with pre-verified content**

```typescript
// test/fixtures/sample-files.ts

// A genuinely valid, tiny (~287 byte) JPEG — verified via `file` to report
// "JPEG image data, JFIF standard 1.01" — not a placeholder. Used anywhere
// an e2e test previously attached fake text bytes under a .jpg/.jpeg/.png
// filename.
export const SAMPLE_JPEG_BUFFER = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);

// A genuinely valid, minimal (one blank 200x200pt page) PDF — verified via
// `pdfinfo` to report "PDF version: 1.4, Pages: 1" with correct xref byte
// offsets (not relying on reader leniency). Used anywhere an e2e test
// previously attached fake text bytes under a .pdf filename (CVs, identity
// documents).
export const SAMPLE_PDF_BUFFER = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n203\n%%EOF',
  'utf-8',
);
```

- [ ] **Step 2: Re-verify both buffers are genuinely valid files**

Create a throwaway script `_verify_fixtures_local.ts` in the repo root:
```typescript
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './test/fixtures/sample-files';
import * as fs from 'fs';

fs.writeFileSync('/tmp/verify-sample.jpg', SAMPLE_JPEG_BUFFER);
fs.writeFileSync('/tmp/verify-sample.pdf', SAMPLE_PDF_BUFFER);
console.log('JPEG bytes:', SAMPLE_JPEG_BUFFER.length, 'PDF bytes:', SAMPLE_PDF_BUFFER.length);
```

Run:
```bash
npx ts-node -T --compiler-options '{"module":"commonjs","moduleResolution":"node"}' ./_verify_fixtures_local.ts
file /tmp/verify-sample.jpg /tmp/verify-sample.pdf
rm ./_verify_fixtures_local.ts
```

Expected output: `file` reports `/tmp/verify-sample.jpg: JPEG image data,
JFIF standard 1.01, ...` and `/tmp/verify-sample.pdf: PDF document, version
1.4, 1 pages`. These exact byte sequences were already verified this way
during planning (287 and 345 bytes respectively) — this step exists to
catch any transcription error when the file was created, not to re-derive
the bytes. If either check fails, the content was copied incorrectly from
this plan — fix the transcription, don't recompute the bytes.

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add test/fixtures/sample-files.ts
git commit -m "test(fixtures): add real, byte-verified JPEG and PDF sample files"
```

---

### Task 2: Content-Type inference + FileDownloadController fix

**Files:**
- Create: `src/file-storage/content-type.util.ts`
- Create: `src/file-storage/content-type.util.spec.ts`
- Modify: `src/file-storage/file-download.controller.ts` (full file, 21 lines)
- Create: `src/file-storage/file-download.controller.spec.ts`

**Interfaces:**
- Produces: `inferContentType(key: string): string`, consumed by
  `FileDownloadController.download`.

- [ ] **Step 1: Write the failing test for `inferContentType`**

```typescript
// src/file-storage/content-type.util.spec.ts
import { inferContentType } from './content-type.util';

describe('inferContentType', () => {
  it('maps known extensions to their MIME type', () => {
    expect(inferContentType('a/b/c.jpg')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.jpeg')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.png')).toBe('image/png');
    expect(inferContentType('a/b/c.pdf')).toBe('application/pdf');
    expect(inferContentType('a/b/c.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(inferContentType('a/b/c.csv')).toBe('text/csv');
    expect(inferContentType('a/b/c.sql')).toBe('application/sql');
  });

  it('is case-insensitive on the extension', () => {
    expect(inferContentType('a/b/c.JPG')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.PDF')).toBe('application/pdf');
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(inferContentType('a/b/c.unknown')).toBe('application/octet-stream');
    expect(inferContentType('a/b/c')).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/file-storage/content-type.util.spec.ts`
Expected: FAIL with "Cannot find module './content-type.util'".

- [ ] **Step 3: Implement `content-type.util.ts`**

```typescript
// src/file-storage/content-type.util.ts
import { extname } from 'path';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.sql': 'application/sql',
};

export function inferContentType(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/file-storage/content-type.util.spec.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Write the failing test for `FileDownloadController`**

```typescript
// src/file-storage/file-download.controller.spec.ts
import { FileDownloadController } from './file-download.controller';
import { FileStorageProvider } from './file-storage-provider.interface';

describe('FileDownloadController', () => {
  let controller: FileDownloadController;
  let fileStorageProvider: { getObject: jest.Mock };
  let res: { setHeader: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    fileStorageProvider = { getObject: jest.fn() };
    res = { setHeader: jest.fn(), send: jest.fn() };
    controller = new FileDownloadController(fileStorageProvider as unknown as FileStorageProvider);
  });

  it('decodes the key, fetches the object, sets Content-Type by extension, then sends the bytes', async () => {
    const content = Buffer.from('fake bytes for this test only');
    fileStorageProvider.getObject.mockResolvedValue(content);

    await controller.download('agents%2Fa1%2Fcv.pdf', res as never);

    expect(fileStorageProvider.getObject).toHaveBeenCalledWith('agents/a1/cv.pdf');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.send).toHaveBeenCalledWith(content);
  });

  it('sets image/jpeg for a .jpg key', async () => {
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('x'));

    await controller.download('selfies%2Fa1%2Flive.jpg', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
  });

  it('sets application/octet-stream for an unrecognized extension', async () => {
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('x'));

    await controller.download('misc%2Fa1%2Fthing.bin', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest src/file-storage/file-download.controller.spec.ts`
Expected: FAIL — `res.setHeader` is never called (current controller only
calls `getObject`/`send`).

- [ ] **Step 7: Rewrite `file-download.controller.ts` in full**

```typescript
import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from './file-storage-provider.interface';
import { inferContentType } from './content-type.util';

@Controller('admin/documents/files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FileDownloadController {
  constructor(
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  @Get(':key')
  @RequirePermissions('documents:read')
  async download(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const decodedKey = decodeURIComponent(key);
    const content = await this.fileStorageProvider.getObject(decodedKey);
    res.setHeader('Content-Type', inferContentType(decodedKey));
    res.send(content);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest src/file-storage/file-download.controller.spec.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/file-storage/content-type.util.ts src/file-storage/content-type.util.spec.ts src/file-storage/file-download.controller.ts src/file-storage/file-download.controller.spec.ts
git commit -m "fix(file-storage): set Content-Type on file downloads instead of serving bytes untyped"
```

---

### Task 3: Real fixtures in recruitment/CV upload e2e tests

**Files:**
- Modify: `test/admin-agent-recruitment-review.e2e-spec.ts:140-141`
- Modify: `test/agent-recruitment.e2e-spec.ts:107-108,182-183,220-221`
- Modify: `test/admin-profile.e2e-spec.ts:83,105`

**Interfaces:**
- Consumes: `SAMPLE_JPEG_BUFFER`, `SAMPLE_PDF_BUFFER` from
  `../test/fixtures/sample-files` (Task 1).

- [ ] **Step 1: Update `test/admin-agent-recruitment-review.e2e-spec.ts`**

Add to the top import block (after the existing `EMAIL_PROVIDERS` import):
```typescript
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './fixtures/sample-files';
```

Replace:
```typescript
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
```
with:
```typescript
        .attach('cv', SAMPLE_PDF_BUFFER, 'cv.pdf')
        .attach('passportPhoto', SAMPLE_JPEG_BUFFER, 'photo.jpg')
```

- [ ] **Step 2: Update `test/agent-recruitment.e2e-spec.ts`**

Add the same import (after the existing `EMAIL_PROVIDERS` import):
```typescript
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './fixtures/sample-files';
```

Replace all three occurrences of:
```typescript
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
```
with:
```typescript
        .attach('cv', SAMPLE_PDF_BUFFER, 'cv.pdf')
        .attach('passportPhoto', SAMPLE_JPEG_BUFFER, 'photo.jpg')
```
(lines 107-108, 182-183, 220-221 — identical text each time, replace all
three occurrences identically).

- [ ] **Step 3: Update `test/admin-profile.e2e-spec.ts`**

Add to the top import block (after the existing `PrismaService` import):
```typescript
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './fixtures/sample-files';
```

Replace:
```typescript
      .attach('file', Buffer.from('fake-image-data'), { filename: 'avatar.jpg', contentType: 'image/jpeg' })
```
with:
```typescript
      .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'avatar.jpg', contentType: 'image/jpeg' })
```

Replace:
```typescript
      .attach('file', Buffer.from('fake-pdf-data'), { filename: 'doc.pdf', contentType: 'application/pdf' })
```
with:
```typescript
      .attach('file', SAMPLE_PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' })
```
(this second one is the test asserting `.expect(400)` — a PDF is rejected
as a profile image by content-type validation before storage either way;
swapping the buffer content doesn't change that, it's just for consistency
since the spec's call-site list includes it).

- [ ] **Step 4: Run all three e2e files to verify they still pass**

Run: `npx jest --config ./test/jest-e2e.json test/admin-agent-recruitment-review.e2e-spec.ts test/agent-recruitment.e2e-spec.ts test/admin-profile.e2e-spec.ts`
Expected: PASS, every test in all three files green (none of them assert
anything about the byte content of the uploaded file today — only
`documentType`, `status`, `profileImageUrl` being a string, etc. — so this
is a content-only swap). If a test fails, re-run that single file in
isolation before treating it as a real regression (this repo's shared UAT
DB can produce incidental cross-test contention).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add test/admin-agent-recruitment-review.e2e-spec.ts test/agent-recruitment.e2e-spec.ts test/admin-profile.e2e-spec.ts
git commit -m "test(e2e): use real JPEG/PDF fixtures instead of fake bytes in recruitment and profile uploads"
```

---

### Task 4: Real fixtures in client-onboarding document/selfie e2e tests

**Files:**
- Modify: `test/admin-client-onboarding.e2e-spec.ts:88,185,192,235`
- Modify: `test/agent-client-onboarding.e2e-spec.ts:106`
- Modify: `test/client-onboarding.e2e-spec.ts:148,169,211,229`

**Interfaces:**
- Consumes: `SAMPLE_JPEG_BUFFER` from `./fixtures/sample-files` (Task 1).
  (None of these three files touch the `.pdf` fixture — every upload here is
  a `.jpg` document or selfie.)

- [ ] **Step 1: Update `test/admin-client-onboarding.e2e-spec.ts`**

Add to the top import block (after the existing `TokenService` import):
```typescript
import { SAMPLE_JPEG_BUFFER } from './fixtures/sample-files';
```

Replace all three occurrences of:
```typescript
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
```
(lines 88, 185, 235 — identical text each time) with:
```typescript
        .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'doc.jpg', contentType: 'image/jpeg' })
```

Replace the one occurrence (line 192, inside the embedded client-side
face-match step this admin test also exercises) of:
```typescript
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
```
(note: 6-space indent, not 8-space — this line sits at a shallower nesting
level than the other three `.attach('file', ...)` calls in this same file,
and it's a selfie upload, not a document upload) with:
```typescript
      .attach('selfie', SAMPLE_JPEG_BUFFER, 'selfie.jpg')
```

- [ ] **Step 2: Update `test/agent-client-onboarding.e2e-spec.ts`**

Add to the top import block (after the existing `hashPassword` import):
```typescript
import { SAMPLE_JPEG_BUFFER } from './fixtures/sample-files';
```

Replace:
```typescript
          .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
```
with:
```typescript
          .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'doc.jpg', contentType: 'image/jpeg' })
```

- [ ] **Step 3: Update `test/client-onboarding.e2e-spec.ts`**

Add to the top import block (after the existing `TokenService` import):
```typescript
import { SAMPLE_JPEG_BUFFER } from './fixtures/sample-files';
```

Replace all three occurrences (lines 148, 211, 229 — identical text each
time, 8-space indent) of:
```typescript
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
```
with:
```typescript
        .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'doc.jpg', contentType: 'image/jpeg' })
```

Replace (line 169, 6-space indent):
```typescript
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
```
with:
```typescript
      .attach('selfie', SAMPLE_JPEG_BUFFER, 'selfie.jpg')
```

- [ ] **Step 4: Run all three e2e files to verify they still pass**

Run: `npx jest --config ./test/jest-e2e.json test/admin-client-onboarding.e2e-spec.ts test/agent-client-onboarding.e2e-spec.ts test/client-onboarding.e2e-spec.ts`
Expected: PASS, every test green (none assert byte content — only
`documentType`, `step`, `faceMatchPassed`, the `bvnSelfieUrl`/etc. string
checks already covered elsewhere). If a test fails, re-run that single file
in isolation first (this repo's shared UAT DB can produce incidental
cross-test contention when several onboarding e2e files run back to back).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add test/admin-client-onboarding.e2e-spec.ts test/agent-client-onboarding.e2e-spec.ts test/client-onboarding.e2e-spec.ts
git commit -m "test(e2e): use a real JPEG fixture instead of fake bytes in client-onboarding document/selfie uploads"
```

---

### Task 5: New e2e coverage for the download endpoint

**Files:**
- Create: `test/file-download.e2e-spec.ts`

**Interfaces:**
- Consumes: `SAMPLE_JPEG_BUFFER` from `./fixtures/sample-files` (Task 1);
  the `inferContentType`/`Content-Type` behavior from Task 2;
  `ClientOnboardingService.uploadDocument`'s `{ documentType, uploadedAt, url }`
  response shape (already shipped, unchanged by this plan) via
  `POST /client/onboarding/documents/:type`.

- [ ] **Step 1: Write the new e2e test**

```typescript
// test/file-download.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { SAMPLE_JPEG_BUFFER } from './fixtures/sample-files';

describe('File download endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let adminAccessToken: string;
  const phone = `+234806${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-FILEDL-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'E2E File Download Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E File Download Test',
        agency: 'NPF',
        step: 'IDENTITY_SUBMITTED',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientDocument.deleteMany({ where: { clientOnboarding: { clientId } } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('serves an uploaded document with the correct Content-Type and the exact original bytes', async () => {
    const tokenService = app.get(TokenService);
    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    const uploadRes = await request(app.getHttpServer())
      .post('/client/onboarding/documents/NIN_CARD')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'doc.jpg', contentType: 'image/jpeg' })
      .expect(201);

    expect(uploadRes.body).toEqual({
      documentType: 'NIN_CARD',
      uploadedAt: expect.any(String),
      url: expect.any(String),
    });

    // FileDownloadController requires an admin JWT carrying a `permissions`
    // array (RequirePermissions('documents:read') via PermissionsGuard) —
    // client/agent tokens never carry a permissions array at all (that's an
    // admin-RBAC-only concept in this codebase), so this must use the admin
    // token, not the client token that performed the upload.
    const downloadRes = await request(app.getHttpServer())
      .get(uploadRes.body.url)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(downloadRes.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(Buffer.compare(downloadRes.body, SAMPLE_JPEG_BUFFER)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx jest --config ./test/jest-e2e.json test/file-download.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 3: Confirm cleanup leaves no rows behind**

After the run, independently verify via a throwaway Prisma script (same
pattern used elsewhere in this repo this session) that no `Client`,
`ClientOnboarding`, `IppisRecord`, or `ClientDocument` row matching this
test's `staffId`/`phone` prefix remains. Delete the script afterward.

- [ ] **Step 4: Commit**

```bash
git add test/file-download.e2e-spec.ts
git commit -m "test(e2e): cover the file-download endpoint's Content-Type and byte-exact round-trip"
```

---

### Task 6: Backfill existing stored files in the live environment (NOT committed)

**Files:**
- Create (temporarily, in the repo root, same pattern as this session's
  earlier ad hoc scripts): `_backfill_real_files_local.ts`
- Delete the same file once the task is done — this is an operational
  script, never part of the committed codebase.

**Interfaces:**
- Consumes: `SAMPLE_JPEG_BUFFER`, `SAMPLE_PDF_BUFFER` from
  `./test/fixtures/sample-files` (Task 1) — import by relative path from
  the repo root, e.g. `import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './test/fixtures/sample-files';`.

- [ ] **Step 1: Write the script in scan mode first**

```typescript
// _backfill_real_files_local.ts — SCAN MODE (read-only, no writes)
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from './src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

  const clientDocuments = await prisma.clientDocument.count();
  const onboardings = await prisma.clientOnboarding.findMany({
    where: { OR: [{ bvnSelfie: { not: null } }, { ninSelfie: { not: null } }, { liveSelfieKey: { not: null } }] },
    select: { bvnSelfie: true, ninSelfie: true, liveSelfieKey: true },
  });
  const agents = await prisma.agent.findMany({
    where: {
      OR: [
        { cvKey: { not: null } },
        { passportPhotoKey: { not: null } },
        { identityDocumentKey: { not: null } },
      ],
    },
    select: { cvKey: true, passportPhotoKey: true, identityDocumentKey: true, supportingDocumentKeys: true },
  });
  const agentApplications = await prisma.agentApplication.findMany({
    where: {
      OR: [
        { cvKey: { not: null } },
        { passportPhotoKey: { not: null } },
        { identityDocumentKey: { not: null } },
      ],
    },
    select: { cvKey: true, passportPhotoKey: true, identityDocumentKey: true },
  });
  const adminUsers = await prisma.adminUser.count({ where: { profileImageKey: { not: null } } });

  const onboardingSelfieCount = onboardings.reduce(
    (sum, o) => sum + [o.bvnSelfie, o.ninSelfie, o.liveSelfieKey].filter(Boolean).length,
    0,
  );
  const agentKeyCount = agents.reduce(
    (sum, a) =>
      sum +
      [a.cvKey, a.passportPhotoKey, a.identityDocumentKey].filter(Boolean).length +
      a.supportingDocumentKeys.length,
    0,
  );
  const agentApplicationKeyCount = agentApplications.reduce(
    (sum, a) => sum + [a.cvKey, a.passportPhotoKey, a.identityDocumentKey].filter(Boolean).length,
    0,
  );

  console.log('ClientDocument rows (all have a storageKey):', clientDocuments);
  console.log('ClientOnboarding selfie keys found:', onboardingSelfieCount, '(across', onboardings.length, 'rows)');
  console.log('Agent document keys found:', agentKeyCount, '(across', agents.length, 'rows)');
  console.log('AgentApplication document keys found:', agentApplicationKeyCount, '(across', agentApplications.length, 'rows)');
  console.log('AdminUser profileImageKey set:', adminUsers);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the scan and report counts to the user**

Run: `npx ts-node -T --compiler-options '{"module":"commonjs","moduleResolution":"node"}' ./_backfill_real_files_local.ts`

Show the printed counts to the user and get their explicit confirmation
before proceeding to Step 3 — do not execute writes without it, matching
this session's established pattern for scripts that mutate the shared live
UAT environment.

- [ ] **Step 3: Extend the script with an execute mode, gated behind an explicit flag**

Add this to the same file, replacing the plain `console.log` summary block
with a conditional: if `process.argv[2] !== '--execute'`, stop after
printing the scan summary (Step 1's behavior, unchanged); if
`process.argv[2] === '--execute'`, additionally overwrite each found key's
stored bytes:

This script runs outside Nest's DI container, so instantiate the storage
provider directly rather than injecting it — for `STORAGE_PROVIDER=local`
(this repo's dev/test default), construct `LocalFileStorageProvider`
directly. Add these imports to the top of the file, alongside the existing
`dotenv`/`PrismaClient`/`PrismaPg` ones:
```typescript
import { LocalFileStorageProvider } from './src/file-storage/local-file-storage.provider';
import { ConfigService } from '@nestjs/config';
import { SAMPLE_JPEG_BUFFER, SAMPLE_PDF_BUFFER } from './test/fixtures/sample-files';
import { extname } from 'path';
```

Then add this block after computing the counts above, before
`prisma.$disconnect()`:
```typescript
if (process.argv[2] === '--execute') {
  const configService = new ConfigService();
  const storageProvider = new LocalFileStorageProvider(configService);

  const bufferFor = (key: string) => (extname(key).toLowerCase() === '.pdf' ? SAMPLE_PDF_BUFFER : SAMPLE_JPEG_BUFFER);

  const allKeys: string[] = [
    ...onboardings.flatMap((o) => [o.bvnSelfie, o.ninSelfie, o.liveSelfieKey].filter((k): k is string => !!k)),
    ...agents.flatMap((a) =>
      [a.cvKey, a.passportPhotoKey, a.identityDocumentKey].filter((k): k is string => !!k).concat(a.supportingDocumentKeys),
    ),
    ...agentApplications.flatMap((a) => [a.cvKey, a.passportPhotoKey, a.identityDocumentKey].filter((k): k is string => !!k)),
  ];
  const clientDocumentKeys = (await prisma.clientDocument.findMany({ select: { storageKey: true } })).map((d) => d.storageKey);
  const adminUserKeys = (
    await prisma.adminUser.findMany({ where: { profileImageKey: { not: null } }, select: { profileImageKey: true } })
  ).map((a) => a.profileImageKey!);

  const everyKey = [...allKeys, ...clientDocumentKeys, ...adminUserKeys];
  console.log(`Overwriting ${everyKey.length} stored files with real content...`);
  for (const key of everyKey) {
    await storageProvider.putObject(key, bufferFor(key));
  }
  console.log('Done.');
}
```
(If this repo's live environment actually runs `STORAGE_PROVIDER=s3` or
`gcs` rather than `local`, swap `LocalFileStorageProvider` for the matching
provider class and its constructor args — check `.env`'s `STORAGE_PROVIDER`
value first; don't assume.)

- [ ] **Step 4: Check which storage provider the live environment actually uses**

Run: `grep STORAGE_PROVIDER .env` — confirm it's `local` before trusting
Step 3's code as-is; adjust per the note above if not.

- [ ] **Step 5: Get explicit user confirmation, then run in execute mode**

Run: `npx ts-node -T --compiler-options '{"module":"commonjs","moduleResolution":"node"}' ./_backfill_real_files_local.ts --execute`

Only after the user has seen Step 2's scan counts and explicitly said to
proceed.

- [ ] **Step 6: Delete the script — never commit it**

```bash
rm ./_backfill_real_files_local.ts
```

Run `git status --short` afterward and confirm the file does not appear
(it was never staged, so this just confirms the working tree is clean of
it).

---

### Task 7: Final verification (done directly, not dispatched to a subagent)

- [ ] Run the full unit suite: `npx jest`. Expected: all suites pass.
- [ ] Run the full e2e suite: `npx jest --config ./test/jest-e2e.json`.
  Re-run any failing file in isolation before treating it as a real
  regression (established pattern this session — this repo's shared UAT DB
  produces incidental cross-test flakiness under concurrent load).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: no errors.
- [ ] Lint: `npx eslint "{src,apps,libs,test}/**/*.ts" --rule '{"prettier/prettier":"off"}'`.
  Expected: matches this repo's established baseline error count (23 as of
  the last check this session) — confirm no *new* errors in files this
  plan touched.
- [ ] Live sanity check: boot the app (`npx nest start`), upload a real
  document through any onboarding endpoint, fetch the returned `url`
  directly in a browser or via `curl -I`, and confirm the response headers
  show the correct `Content-Type` and the body is a genuinely openable
  file. Clean up any rows created during this manual check.
- [ ] Confirm `git status --short` is clean (no leftover backfill script,
  no other stray files), then ask the user whether to push.
