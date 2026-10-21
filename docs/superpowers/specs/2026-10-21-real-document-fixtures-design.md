# Real Document Fixtures & Content-Type Fix — Design

## Overview

Every file-upload endpoint now resolves a real signed URL (commits `0e38217`,
`608cc99`, `6d8e571`), but two things still make those URLs unusable when
actually opened:

1. **The download endpoint never sets a `Content-Type` header.**
   `FileDownloadController.download()` does `res.send(content)` with no MIME
   type at all — Express/the browser has no way to know the bytes are a JPEG
   or a PDF, so it downloads as a generic blob instead of rendering inline.
2. **Test/demo data isn't real file content.** e2e tests attach fake text
   buffers (`Buffer.from('fake cv content')`, `Buffer.from('fake-image-data')`,
   etc.) as the upload body. The resulting stored "document" is never a real,
   openable file — even with the Content-Type fix, a JPEG-labeled file full of
   the literal text "fake-image-data" still won't render as an image.

This spec covers three pieces: the Content-Type fix (code, permanent), e2e
fixtures now containing real file bytes (code, permanent), and a one-off
backfill of already-existing stored files in the live UAT environment (an
operational script, not committed — see "Backfill" below).

Explicitly **out of scope**: `DocumentUploadBatch.storageKey` and
`DataSnapshotExport.{sqlStorageKey,csvStorageKey}` — these already hold
genuinely real content (actual uploaded spreadsheets in e2e tests build real
`ExcelJS` workbooks; snapshot exports are real generated SQL/CSV) and were
never part of the "fake data" problem.

## Part 1 — Content-Type fix

New `src/file-storage/content-type.util.ts`:
```typescript
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

`src/file-storage/file-download.controller.ts`'s `download()` method:
```typescript
  @Get(':key')
  @RequirePermissions('documents:read')
  async download(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const decodedKey = decodeURIComponent(key);
    const content = await this.fileStorageProvider.getObject(decodedKey);
    res.setHeader('Content-Type', inferContentType(decodedKey));
    res.send(content);
  }
```
(Only change: decode the key once into a local, set the header using it, then
reuse the same decoded value for `getObject` instead of decoding twice.)

No existing unit test covers this controller at all — new
`file-download.controller.spec.ts` is added.

## Part 2 — Real file fixtures

New `test/fixtures/sample-files.ts`:
```typescript
// A genuinely valid, tiny (~200 byte) JPEG — a real decodable image, not a
// placeholder. Used anywhere an e2e test previously attached fake text bytes
// under a .jpg/.jpeg/.png filename.
export const SAMPLE_JPEG_BUFFER = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);

// A genuinely valid, minimal (one blank page) PDF — a real document, not a
// placeholder. Used anywhere an e2e test previously attached fake text bytes
// under a .pdf filename (CVs, identity documents).
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
(The xref byte offsets above are computed by hand against this exact string —
the implementing task must verify the file is genuinely recognized as a PDF,
e.g. via `file <path>` reporting "PDF document" after writing it to disk, or
a quick magic-byte check; if the computed offsets are off, most real readers
still recover via a linear scan, but get this right rather than relying on
that fallback.)

### Call sites to update (19 total, across 6 files)

Every one of these keeps its existing field name, filename string, and
declared content-type exactly as-is — only the `Buffer.from('fake ...')`
argument changes, to whichever fixture matches the filename's extension
(`.jpg`/`.jpeg` → `SAMPLE_JPEG_BUFFER`, `.pdf` → `SAMPLE_PDF_BUFFER`):

- `test/admin-agent-recruitment-review.e2e-spec.ts:140-141` — `cv.pdf`, `photo.jpg`
- `test/admin-client-onboarding.e2e-spec.ts:88,185,235` — `doc.jpg` (×3); `:192` — `selfie.jpg`
- `test/admin-profile.e2e-spec.ts:83` — `avatar.jpg`; `:105` — `doc.pdf`
- `test/agent-client-onboarding.e2e-spec.ts:106` — `doc.jpg`
- `test/client-onboarding.e2e-spec.ts:148,211,229` — `doc.jpg` (×3); `:169` — `selfie.jpg`
- `test/agent-recruitment.e2e-spec.ts:107-108,182-183,220-221` — `cv.pdf`/`photo.jpg` (×3 each)

**Not touched** (rejection tests that never reach file parsing/storage):
`test/document-upload.e2e-spec.ts:80` (401, unauthenticated) and `:88` (400,
missing period).

## Part 3 — New e2e coverage for the download endpoint

No e2e test exercises `GET /admin/documents/files/:key` today at all. New
file `test/file-download.e2e-spec.ts` (a dedicated file, since this is
testing a cross-cutting endpoint, not onboarding-specific behavior): upload a
real document via an existing flow (client onboarding's
`POST /client/onboarding/documents/:type`), take the `url` the API returns,
`GET` that URL directly, and assert the response's `Content-Type` header is
`image/jpeg` and the body bytes equal `SAMPLE_JPEG_BUFFER`.

## Part 4 — Backfill (operational script, not committed)

A one-off script, run once against the live UAT DB/storage via `ts-node`
(same pattern as the ad hoc scripts used earlier this session — written to
the repo root temporarily, run, then deleted; never committed). Two modes:

**Scan mode** (default, read-only): for each of `ClientDocument.storageKey`,
`ClientOnboarding.{bvnSelfie,ninSelfie,liveSelfieKey}`,
`Agent.{cvKey,passportPhotoKey,identityDocumentKey,supportingDocumentKeys}`,
`AgentApplication.{cvKey,passportPhotoKey,identityDocumentKey}`,
`AdminUser.profileImageKey` — count non-null keys and print the breakdown per
field, without writing anything.

**Execute mode**: for every non-null key found, call
`fileStorageProvider.putObject(key, sampleBuffer)` where `sampleBuffer` is
chosen by the key's extension (same rule as Part 2) — this overwrites the
file at that existing key with real content. No DB row is touched; only the
underlying stored bytes change. Run scan first, show the user the counts,
and only proceed to execute mode after explicit confirmation (same pattern
as this session's earlier test-data-cleanup script).

## Testing

- `content-type.util.spec.ts` (new): covers every mapped extension, casing
  insensitivity (`.JPG`), and the `application/octet-stream` fallback for an
  unknown extension.
- `file-download.controller.spec.ts` (new): mocks `FileStorageProvider`,
  asserts `getObject` is called with the decoded key, asserts
  `res.setHeader('Content-Type', ...)` is called with the right MIME type
  before `res.send`.
- e2e: the new download-endpoint test from Part 3; existing e2e suites
  (client-onboarding, admin-client-onboarding, agent-client-onboarding,
  admin-profile, agent-recruitment, admin-agent-recruitment-review) continue
  to pass unchanged — none of them assert anything about the *content* of the
  uploaded bytes today, only metadata (`documentType`, `step`, etc.), so
  swapping the buffer content is a safe, non-breaking change there.

## Postman

No API shape changes (no new/changed endpoint, body, or status code — only a
response header addition and test-fixture content), so no Postman sync is
required for this feature.
