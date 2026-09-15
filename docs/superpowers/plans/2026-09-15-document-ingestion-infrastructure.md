# Document Ingestion Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the generic, document-type-agnostic plumbing the ingestion engine needs — file storage, the snapshot/export mechanism, batch lifecycle tracking, and a BullMQ-backed background processing pipeline — with a no-op parser proving the whole shape end-to-end. Later plans (IPPIS Broadsheet, Disbursed Loans, Repayment Schedule, Reconciliation) each replace one entry in the parser registry with real logic; this plan's processor code never changes again.

**Architecture:** Upload endpoint stores the raw file via a swappable `FileStorageProvider` (local-disk mock for now), creates a `DocumentUploadBatch` row, and enqueues a BullMQ job. A `DocumentIngestionProcessor` worker dispatches to a `DOCUMENT_PARSERS` registry keyed by `DocumentType`; every entry points at `NoOpDocumentParser` until a later plan swaps one in. A generic `SnapshotExportService` (SQL + CSV generation, used by real parsers starting in the next plan) is built now and proven with fixture data.

**Tech Stack:** Adds `@nestjs/bullmq`, `bullmq`, `ioredis` (job queue against the Redis instance already in `.env`), `@types/multer` (multipart upload typing via `@nestjs/platform-express`'s existing `FileInterceptor`). Everything else matches the established stack (NestJS 10, Prisma 7, class-validator, Jest + Supertest).

**Spec:** `docs/superpowers/specs/2026-09-15-document-ingestion-design.md`

## Global Constraints

- Follow established patterns exactly: services take `PrismaService` via constructor injection, every admin route uses `JwtAuthGuard` + `PermissionsGuard` + `@RequirePermissions(...)`, external integrations are swappable via a DI token (single-provider for storage, unlike the ordered-array-with-failover pattern used for OTP/email — storage doesn't need failover semantics).
- `FileStorageProvider` has exactly one active implementation (`LocalFileStorageProvider`) for now — a real GCS/S3 vendor is explicitly deferred (per the design doc).
- The processor (`DocumentIngestionProcessor`) is document-type-agnostic and must not be modified by later plans — only the `DOCUMENT_PARSERS` registry's contents change.
- No placeholder logic disguised as "real" — `NoOpDocumentParser` is a genuine, fully-implemented, tested no-op (returns real zero counts), not a stub with a TODO.

---

### Task 1: Schema — DocumentUploadBatch, DataSnapshotExport, new permissions

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: Prisma models `DocumentUploadBatch` (enums `DocumentType`, `DocumentBatchStatus`), `DataSnapshotExport`. `AdminUser` gains `uploadedDocumentBatches DocumentUploadBatch[]`.
- Produces: seeded permissions `loans:upload`, `repayments:upload`, `documents:read` (added to `SUPER_ADMIN`'s permission set alongside the existing nine).

- [ ] **Step 1: Extend the schema**

Add to `prisma/schema.prisma` (after the existing `AuditLog` model):

```prisma
enum DocumentType {
  IPPIS_BROADSHEET
  REPAYMENT_SCHEDULE
  DISBURSED_LOANS
}

enum DocumentBatchStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

model DocumentUploadBatch {
  id               String              @id @default(uuid())
  documentType     DocumentType
  uploadedById     String
  uploadedBy       AdminUser           @relation(fields: [uploadedById], references: [id])
  originalFileName String
  storageKey       String
  period           String?
  status           DocumentBatchStatus @default(PENDING)
  rowsProcessed    Int                 @default(0)
  rowsCreated      Int                 @default(0)
  rowsUpdated      Int                 @default(0)
  rowsSkipped      Int                 @default(0)
  warnings         Json?
  errorMessage     String?
  snapshotExportId String?             @unique
  snapshotExport   DataSnapshotExport? @relation(fields: [snapshotExportId], references: [id])
  startedAt        DateTime?
  completedAt      DateTime?
  createdAt        DateTime            @default(now())
}

model DataSnapshotExport {
  id            String               @id @default(uuid())
  documentType  DocumentType
  recordCount   Int
  sqlStorageKey String
  csvStorageKey String
  sqlUrl        String
  csvUrl        String
  generatedAt   DateTime             @default(now())
  batch         DocumentUploadBatch?
}
```

Modify the existing `AdminUser` model to add a back-relation field (alongside `roles`/`sentInvites`):

```prisma
  uploadedDocumentBatches DocumentUploadBatch[]
```

- [ ] **Step 2: Migrate**

Run: `npx prisma migrate dev --name document_ingestion_infrastructure`
Expected: migration applies cleanly, Prisma Client regenerated.

- [ ] **Step 3: Add the new permissions to the seed script**

In `prisma/seed.ts`, extend `BOOTSTRAP_PERMISSIONS` (append after the existing entries):

```typescript
  { key: 'loans:upload', description: 'Upload disbursed loans reports' },
  { key: 'repayments:upload', description: 'Upload IPPIS repayment schedule reports' },
  { key: 'documents:read', description: 'View document upload batches and snapshot exports' },
```

- [ ] **Step 4: Re-seed and verify**

Run: `npx prisma db seed`
Expected: completes with no errors (idempotent upserts).

- [ ] **Step 5: Commit**

```bash
git add prisma
git commit -m "feat: add DocumentUploadBatch/DataSnapshotExport schema and new permissions"
```

---

### Task 2: File storage provider (local-disk mock)

**Files:**
- Create: `src/file-storage/file-storage-provider.interface.ts`
- Create: `src/file-storage/local-file-storage.provider.ts`
- Create: `src/file-storage/file-download.controller.ts`
- Create: `src/file-storage/file-storage.module.ts`
- Test: `src/file-storage/local-file-storage.provider.spec.ts`

**Interfaces:**
- Produces: `FileStorageProvider { putObject(key, content): Promise<void>; getObject(key): Promise<Buffer>; getSignedDownloadUrl(key): Promise<string>; deleteObject(key): Promise<void>; }`, `FILE_STORAGE_PROVIDER` DI token — Task 3 (`SnapshotExportService`) and Task 7 (upload controller) both consume this.
- Produces: `GET /admin/documents/files/:key` for downloading a stored file, gated by `documents:read`.

- [ ] **Step 1: Write the failing test**

`src/file-storage/local-file-storage.provider.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalFileStorageProvider } from './local-file-storage.provider';

describe('LocalFileStorageProvider', () => {
  let provider: LocalFileStorageProvider;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `file-storage-test-${Date.now()}`);
    const configService = {
      get: jest.fn().mockReturnValue(testDir),
    } as unknown as ConfigService;
    provider = new LocalFileStorageProvider(configService);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('writes and reads back a file, creating parent directories as needed', async () => {
    await provider.putObject('snapshots/ippis/2026-09-15.csv', Buffer.from('a,b,c'));
    const content = await provider.getObject('snapshots/ippis/2026-09-15.csv');
    expect(content.toString('utf-8')).toBe('a,b,c');
  });

  it('throws NotFoundException for a key that was never written', async () => {
    await expect(provider.getObject('does/not/exist.csv')).rejects.toThrow(NotFoundException);
  });

  it('returns an app-relative download URL', async () => {
    const url = await provider.getSignedDownloadUrl('snapshots/ippis/2026-09-15.csv');
    expect(url).toBe('/admin/documents/files/snapshots%2Fippis%2F2026-09-15.csv');
  });

  it('deleteObject removes the file so a later getObject throws', async () => {
    await provider.putObject('to-delete.csv', Buffer.from('x'));
    await provider.deleteObject('to-delete.csv');
    await expect(provider.getObject('to-delete.csv')).rejects.toThrow(NotFoundException);
  });

  it('deleteObject on a nonexistent key does not throw', async () => {
    await expect(provider.deleteObject('never-existed.csv')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/file-storage/local-file-storage.provider.spec.ts`
Expected: FAIL — `Cannot find module './local-file-storage.provider'`

- [ ] **Step 3: Implement the interface and provider**

`src/file-storage/file-storage-provider.interface.ts`:

```typescript
export const FILE_STORAGE_PROVIDER = Symbol('FILE_STORAGE_PROVIDER');

export interface FileStorageProvider {
  putObject(key: string, content: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  getSignedDownloadUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
```

`src/file-storage/local-file-storage.provider.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileStorageProvider } from './file-storage-provider.interface';

@Injectable()
export class LocalFileStorageProvider implements FileStorageProvider {
  constructor(private readonly configService: ConfigService) {}

  private baseDir(): string {
    return this.configService.get<string>('LOCAL_STORAGE_DIR', './storage');
  }

  private resolvePath(key: string): string {
    return path.join(this.baseDir(), key);
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolvePath(key));
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    return `/admin/documents/files/${encodeURIComponent(key)}`;
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.resolvePath(key), { force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/file-storage/local-file-storage.provider.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the download controller and module**

`src/file-storage/file-download.controller.ts`:

```typescript
import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from './file-storage-provider.interface';

@Controller('admin/documents/files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FileDownloadController {
  constructor(
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  @Get(':key')
  @RequirePermissions('documents:read')
  async download(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const content = await this.fileStorageProvider.getObject(decodeURIComponent(key));
    res.send(content);
  }
}
```

`src/file-storage/file-storage.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LocalFileStorageProvider } from './local-file-storage.provider';
import { FILE_STORAGE_PROVIDER } from './file-storage-provider.interface';
import { FileDownloadController } from './file-download.controller';

@Module({
  controllers: [FileDownloadController],
  providers: [{ provide: FILE_STORAGE_PROVIDER, useClass: LocalFileStorageProvider }],
  exports: [FILE_STORAGE_PROVIDER],
})
export class FileStorageModule {}
```

- [ ] **Step 6: Add the storage directory setting**

Add to `.env.example` and `.env`:

```
LOCAL_STORAGE_DIR=./storage
```

Add to `.gitignore`:

```
/storage
```

- [ ] **Step 7: Commit**

```bash
git add src/file-storage .env.example .gitignore
git commit -m "feat: add FileStorageProvider with a local-disk mock implementation"
```

---

### Task 3: Snapshot export service (SQL + CSV generation)

**Files:**
- Create: `src/document-ingestion/snapshot-export.service.ts`
- Test: `src/document-ingestion/snapshot-export.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `FILE_STORAGE_PROVIDER` (Task 2).
- Produces: `SnapshotExportService.exportSnapshot(input: SnapshotExportInput): Promise<DataSnapshotExport>` where `SnapshotExportInput = { documentType: DocumentType; tableName: string; columns: string[]; rows: Record<string, unknown>[] }` — later plans' real parsers call this with the target table's full current row set before upserting new data.

- [ ] **Step 1: Write the failing test**

`src/document-ingestion/snapshot-export.service.spec.ts`:

```typescript
import { SnapshotExportService } from './snapshot-export.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentType } from '../generated/prisma/client';

describe('SnapshotExportService', () => {
  let service: SnapshotExportService;
  let prisma: { dataSnapshotExport: { create: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  beforeEach(() => {
    prisma = { dataSnapshotExport: { create: jest.fn() } };
    fileStorageProvider = {
      putObject: jest.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('/admin/documents/files/x'),
    };
    service = new SnapshotExportService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  it('generates SQL INSERT statements for each row, escaping quotes', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
      columns: ['staffId', 'employeeName'],
      rows: [{ staffId: 'PF001', employeeName: "O'Brien" }],
    });

    const [, sqlBuffer] = fileStorageProvider.putObject.mock.calls[0];
    expect(sqlBuffer.toString('utf-8')).toContain(
      `INSERT INTO "IppisRecord" ("staffId", "employeeName") VALUES ('PF001', 'O''Brien');`,
    );
  });

  it('writes "no records" SQL when the row set is empty', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.LOAN as unknown as DocumentType,
      tableName: 'Loan',
      columns: ['customerId'],
      rows: [],
    });

    const [, sqlBuffer] = fileStorageProvider.putObject.mock.calls[0];
    expect(sqlBuffer.toString('utf-8')).toContain('No records in Loan');
  });

  it('generates a CSV with a header row and quotes fields containing commas', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.DISBURSED_LOANS,
      tableName: 'Loan',
      columns: ['customerName', 'address'],
      rows: [{ customerName: 'Doe, Jane', address: '1 Main St' }],
    });

    const csvCall = fileStorageProvider.putObject.mock.calls[1];
    const csvContent = csvCall[1].toString('utf-8');
    expect(csvContent).toContain('customerName,address');
    expect(csvContent).toContain('"Doe, Jane",1 Main St');
  });

  it('creates a DataSnapshotExport row with the record count and both URLs', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    const result = await service.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
      columns: ['staffId'],
      rows: [{ staffId: 'PF001' }, { staffId: 'PF002' }],
    });

    expect(prisma.dataSnapshotExport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentType: DocumentType.IPPIS_BROADSHEET,
        recordCount: 2,
        sqlUrl: '/admin/documents/files/x',
        csvUrl: '/admin/documents/files/x',
      }),
    });
    expect(result).toEqual({ id: 'snap-1' });
  });
});
```

Note: the second test deliberately references a `DocumentType.LOAN` value that does not exist on the real enum, cast through `as unknown as DocumentType` purely so the test can exercise the empty-rows branch without depending on which real enum member is used — the service only uses `documentType` to build a storage key path, so any string works for this branch. Feel free to swap it for `DocumentType.DISBURSED_LOANS` if the cast reads oddly; the behavior under test doesn't depend on which real value is passed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/document-ingestion/snapshot-export.service.spec.ts`
Expected: FAIL — `Cannot find module './snapshot-export.service'`

- [ ] **Step 3: Implement `SnapshotExportService`**

`src/document-ingestion/snapshot-export.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DataSnapshotExport, DocumentType } from '../generated/prisma/client';

export interface SnapshotExportInput {
  documentType: DocumentType;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

@Injectable()
export class SnapshotExportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async exportSnapshot(input: SnapshotExportInput): Promise<DataSnapshotExport> {
    const sqlContent = this.buildSql(input);
    const csvContent = this.buildCsv(input);

    const timestamp = Date.now();
    const sqlKey = `snapshots/${input.documentType.toLowerCase()}/${timestamp}.sql`;
    const csvKey = `snapshots/${input.documentType.toLowerCase()}/${timestamp}.csv`;

    await this.fileStorageProvider.putObject(sqlKey, Buffer.from(sqlContent, 'utf-8'));
    await this.fileStorageProvider.putObject(csvKey, Buffer.from(csvContent, 'utf-8'));

    const sqlUrl = await this.fileStorageProvider.getSignedDownloadUrl(sqlKey);
    const csvUrl = await this.fileStorageProvider.getSignedDownloadUrl(csvKey);

    return this.prisma.dataSnapshotExport.create({
      data: {
        documentType: input.documentType,
        recordCount: input.rows.length,
        sqlStorageKey: sqlKey,
        csvStorageKey: csvKey,
        sqlUrl,
        csvUrl,
      },
    });
  }

  private buildSql(input: SnapshotExportInput): string {
    if (input.rows.length === 0) {
      return `-- No records in ${input.tableName} at export time\n`;
    }

    const columnList = input.columns.map((column) => `"${column}"`).join(', ');
    const statements = input.rows.map((row) => {
      const values = input.columns.map((column) => this.sqlValue(row[column])).join(', ');
      return `INSERT INTO "${input.tableName}" (${columnList}) VALUES (${values});`;
    });

    return statements.join('\n') + '\n';
  }

  private sqlValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private buildCsv(input: SnapshotExportInput): string {
    const header = input.columns.join(',');
    const lines = input.rows.map((row) =>
      input.columns.map((column) => this.csvValue(row[column])).join(','),
    );
    return [header, ...lines].join('\n') + '\n';
  }

  private csvValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    const stringValue = value instanceof Date ? value.toISOString() : String(value);
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/document-ingestion/snapshot-export.service.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/snapshot-export.service.ts src/document-ingestion/snapshot-export.service.spec.ts
git commit -m "feat: add SnapshotExportService for pre-merge SQL/CSV table exports"
```

---

### Task 4: Document batch lifecycle service

**Files:**
- Create: `src/document-ingestion/document-batch.service.ts`
- Test: `src/document-ingestion/document-batch.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `DocumentBatchService.createBatch(params): Promise<DocumentUploadBatch>`, `.markProcessing(batchId): Promise<void>`, `.markCompleted(batchId, result: BatchResult): Promise<void>`, `.markFailed(batchId, errorMessage): Promise<void>`, `.findById(batchId): Promise<DocumentUploadBatch | null>`, `.list(filters): Promise<DocumentUploadBatch[]>` — Task 6 (`DocumentIngestionProcessor`) and Task 7 (upload/batch endpoints) consume these. `BatchResult` (`{ rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId? }`) is the one canonical declaration; Task 6's `ParseResult` is a type alias of it, not a second interface.

- [ ] **Step 1: Write the failing test**

`src/document-ingestion/document-batch.service.spec.ts`:

```typescript
import { DocumentBatchService } from './document-batch.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

describe('DocumentBatchService', () => {
  let service: DocumentBatchService;
  let prisma: {
    documentUploadBatch: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      documentUploadBatch: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new DocumentBatchService(prisma as unknown as PrismaService);
  });

  it('createBatch stores the given fields with defaults applying via the schema', async () => {
    prisma.documentUploadBatch.create.mockResolvedValue({ id: 'batch-1' });

    await service.createBatch({
      documentType: DocumentType.IPPIS_BROADSHEET,
      uploadedById: 'admin-1',
      originalFileName: 'broadsheet.xlsx',
      storageKey: 'uploads/ippis_broadsheet/1.xlsx',
    });

    expect(prisma.documentUploadBatch.create).toHaveBeenCalledWith({
      data: {
        documentType: DocumentType.IPPIS_BROADSHEET,
        uploadedById: 'admin-1',
        originalFileName: 'broadsheet.xlsx',
        storageKey: 'uploads/ippis_broadsheet/1.xlsx',
        period: undefined,
      },
    });
  });

  it('markProcessing sets status PROCESSING and startedAt', async () => {
    await service.markProcessing('batch-1');
    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: DocumentBatchStatus.PROCESSING, startedAt: expect.any(Date) },
    });
  });

  it('markCompleted sets status COMPLETED with the result counts', async () => {
    await service.markCompleted('batch-1', {
      rowsProcessed: 5,
      rowsCreated: 3,
      rowsUpdated: 2,
      rowsSkipped: 0,
      warnings: ['sheet X skipped'],
    });

    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: {
        status: DocumentBatchStatus.COMPLETED,
        rowsProcessed: 5,
        rowsCreated: 3,
        rowsUpdated: 2,
        rowsSkipped: 0,
        warnings: ['sheet X skipped'],
        snapshotExportId: undefined,
        completedAt: expect.any(Date),
      },
    });
  });

  it('markFailed sets status FAILED with the error message', async () => {
    await service.markFailed('batch-1', 'parse error');
    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: DocumentBatchStatus.FAILED, errorMessage: 'parse error', completedAt: expect.any(Date) },
    });
  });

  it('findById includes the snapshot export', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ id: 'batch-1' });
    await service.findById('batch-1');
    expect(prisma.documentUploadBatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      include: { snapshotExport: true },
    });
  });

  it('list filters by documentType and status, ordered newest first', async () => {
    prisma.documentUploadBatch.findMany.mockResolvedValue([]);
    await service.list({ documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED });
    expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
      where: { documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts`
Expected: FAIL — `Cannot find module './document-batch.service'`

- [ ] **Step 3: Implement `DocumentBatchService`**

`src/document-ingestion/document-batch.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

export interface CreateBatchParams {
  documentType: DocumentType;
  uploadedById: string;
  originalFileName: string;
  storageKey: string;
  period?: string;
}

export interface BatchResult {
  rowsProcessed: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  warnings: string[];
  snapshotExportId?: string;
}

export interface ListBatchesFilters {
  documentType?: DocumentType;
  status?: DocumentBatchStatus;
}

@Injectable()
export class DocumentBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async createBatch(params: CreateBatchParams) {
    return this.prisma.documentUploadBatch.create({
      data: {
        documentType: params.documentType,
        uploadedById: params.uploadedById,
        originalFileName: params.originalFileName,
        storageKey: params.storageKey,
        period: params.period,
      },
    });
  }

  async markProcessing(batchId: string): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: { status: DocumentBatchStatus.PROCESSING, startedAt: new Date() },
    });
  }

  async markCompleted(batchId: string, result: BatchResult): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: {
        status: DocumentBatchStatus.COMPLETED,
        rowsProcessed: result.rowsProcessed,
        rowsCreated: result.rowsCreated,
        rowsUpdated: result.rowsUpdated,
        rowsSkipped: result.rowsSkipped,
        warnings: result.warnings,
        snapshotExportId: result.snapshotExportId,
        completedAt: new Date(),
      },
    });
  }

  async markFailed(batchId: string, errorMessage: string): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: { status: DocumentBatchStatus.FAILED, errorMessage, completedAt: new Date() },
    });
  }

  async findById(batchId: string) {
    return this.prisma.documentUploadBatch.findUnique({
      where: { id: batchId },
      include: { snapshotExport: true },
    });
  }

  async list(filters: ListBatchesFilters) {
    return this.prisma.documentUploadBatch.findMany({
      where: { documentType: filters.documentType, status: filters.status },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/document-batch.service.ts src/document-ingestion/document-batch.service.spec.ts
git commit -m "feat: add DocumentBatchService for upload batch lifecycle tracking"
```

---

### Task 5: BullMQ root wiring

**Files:**
- Modify: `package.json` (via `npm install`)
- Modify: `src/app.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: a root-level BullMQ connection to Redis, available for `BullModule.registerQueue(...)` calls in any feature module (Task 6 uses this).

- [ ] **Step 1: Install dependencies**

```bash
npm install @nestjs/bullmq bullmq ioredis
```

- [ ] **Step 2: Add environment documentation**

Add to `.env.example` (these already exist in the real `.env` from prior environment setup — this documents them for anyone else setting up the project):

```
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=bull
```

- [ ] **Step 3: Wire `BullModule.forRootAsync` into `AppModule`**

Modify `src/app.module.ts`: add the imports and the root BullMQ configuration.

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AdminInviteModule } from './admin-invite/admin-invite.module';
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
import { AdminSessionModule } from './admin-session/admin-session.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        connection: new Redis(configService.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
        }),
        prefix: configService.get<string>('REDIS_KEY_PREFIX', 'bull'),
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminInviteModule,
    AdminAuditLogModule,
    AdminSessionModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
```

(`FileStorageModule` and `DocumentIngestionModule` are added to this same `imports` array in Task 7, once they exist.)

- [ ] **Step 4: Verify the app still boots and the existing suite passes**

Run: `npm run test:e2e`
Expected: PASS on all suites — this is the checkpoint that Redis is actually reachable and `BullModule.forRootAsync` resolves correctly (a bad `REDIS_URL` or unreachable Redis would surface here as a connection error during app bootstrap).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example src/app.module.ts
git commit -m "feat: wire BullMQ root connection against the project's Redis instance"
```

---

### Task 6: Document parser registry, no-op parser, and the ingestion processor

**Files:**
- Create: `src/document-ingestion/document-parser.interface.ts`
- Create: `src/document-ingestion/no-op-document.parser.ts`
- Create: `src/document-ingestion/document-ingestion-queue.constants.ts`
- Create: `src/document-ingestion/document-ingestion.processor.ts`
- Create: `src/document-ingestion/document-ingestion.module.ts`
- Test: `src/document-ingestion/no-op-document.parser.spec.ts`
- Test: `src/document-ingestion/document-ingestion.processor.spec.ts`

**Interfaces:**
- Consumes: `DocumentBatchService` (Task 4), `FILE_STORAGE_PROVIDER` (Task 2).
- Produces: `DocumentParser { parse(batch, fileBuffer): Promise<ParseResult> }`, `DOCUMENT_PARSERS` DI token resolving to `Record<DocumentType, DocumentParser>`, `DOCUMENT_INGESTION_QUEUE` constant, `DocumentIngestionJobData { batchId: string }` — Task 7 (upload controller, enqueues jobs) consumes the queue constant and job data shape. Every future document-type plan replaces one entry in the `DOCUMENT_PARSERS` factory; this processor's code does not change again.

- [ ] **Step 1: Write the failing test for `NoOpDocumentParser`**

`src/document-ingestion/no-op-document.parser.spec.ts`:

```typescript
import { NoOpDocumentParser } from './no-op-document.parser';
import { DocumentUploadBatch } from '../generated/prisma/client';

describe('NoOpDocumentParser', () => {
  it('returns an all-zero result with no warnings', async () => {
    const parser = new NoOpDocumentParser();
    const result = await parser.parse({} as DocumentUploadBatch, Buffer.from(''));
    expect(result).toEqual({
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/document-ingestion/no-op-document.parser.spec.ts`
Expected: FAIL — `Cannot find module './no-op-document.parser'`

- [ ] **Step 3: Implement the interface and no-op parser**

`src/document-ingestion/document-parser.interface.ts`:

```typescript
import { DocumentUploadBatch } from '../generated/prisma/client';
import { BatchResult } from './document-batch.service';

export const DOCUMENT_PARSERS = Symbol('DOCUMENT_PARSERS');

// Same shape DocumentBatchService.markCompleted() consumes (Task 4) — aliased
// here under the name that reads naturally at a parser's call site. Kept as
// one canonical declaration (BatchResult) rather than two structurally-equal
// interfaces that only happened to line up.
export type ParseResult = BatchResult;

export interface DocumentParser {
  parse(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult>;
}
```

`src/document-ingestion/no-op-document.parser.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { DocumentParser, ParseResult } from './document-parser.interface';
import { DocumentUploadBatch } from '../generated/prisma/client';

@Injectable()
export class NoOpDocumentParser implements DocumentParser {
  async parse(_batch: DocumentUploadBatch, _fileBuffer: Buffer): Promise<ParseResult> {
    return { rowsProcessed: 0, rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, warnings: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/document-ingestion/no-op-document.parser.spec.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Write the failing test for `DocumentIngestionProcessor`**

`src/document-ingestion/document-ingestion.processor.spec.ts`:

```typescript
import { Job } from 'bullmq';
import { DocumentIngestionProcessor, DocumentIngestionJobData } from './document-ingestion.processor';
import { DocumentBatchService } from './document-batch.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentParser } from './document-parser.interface';
import { DocumentType } from '../generated/prisma/client';

describe('DocumentIngestionProcessor', () => {
  let processor: DocumentIngestionProcessor;
  let documentBatchService: {
    findById: jest.Mock;
    markProcessing: jest.Mock;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
  };
  let fileStorageProvider: { getObject: jest.Mock };
  let parsers: Record<string, { parse: jest.Mock }>;

  beforeEach(() => {
    documentBatchService = {
      findById: jest.fn(),
      markProcessing: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    fileStorageProvider = { getObject: jest.fn() };
    parsers = { [DocumentType.IPPIS_BROADSHEET]: { parse: jest.fn() } };
    processor = new DocumentIngestionProcessor(
      documentBatchService as unknown as DocumentBatchService,
      fileStorageProvider as unknown as FileStorageProvider,
      parsers as unknown as Record<DocumentType, DocumentParser>,
    );
  });

  it('logs and returns early when the batch is not found', async () => {
    documentBatchService.findById.mockResolvedValue(null);
    await processor.process({ data: { batchId: 'missing' } } as Job<DocumentIngestionJobData>);
    expect(documentBatchService.markProcessing).not.toHaveBeenCalled();
  });

  it('marks processing, dispatches to the matching parser, and marks completed on success', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockResolvedValue({
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markProcessing).toHaveBeenCalledWith('batch-1');
    expect(parsers[DocumentType.IPPIS_BROADSHEET].parse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'batch-1' }),
      Buffer.from('fake-file'),
    );
    expect(documentBatchService.markCompleted).toHaveBeenCalledWith('batch-1', {
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });

  it('marks failed with the error message when the parser throws', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockRejectedValue(new Error('bad file'));

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markFailed).toHaveBeenCalledWith('batch-1', 'bad file');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/document-ingestion/document-ingestion.processor.spec.ts`
Expected: FAIL — `Cannot find module './document-ingestion.processor'`

- [ ] **Step 7: Implement the queue constant and processor**

`src/document-ingestion/document-ingestion-queue.constants.ts`:

```typescript
export const DOCUMENT_INGESTION_QUEUE = 'document-ingestion';
```

`src/document-ingestion/document-ingestion.processor.ts`:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { DOCUMENT_PARSERS, DocumentParser } from './document-parser.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentType } from '../generated/prisma/client';

export interface DocumentIngestionJobData {
  batchId: string;
}

@Processor(DOCUMENT_INGESTION_QUEUE)
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: Record<DocumentType, DocumentParser>,
  ) {
    super();
  }

  async process(job: Job<DocumentIngestionJobData>): Promise<void> {
    const { batchId } = job.data;
    const batch = await this.documentBatchService.findById(batchId);

    if (!batch) {
      this.logger.error(`Batch ${batchId} not found`);
      return;
    }

    await this.documentBatchService.markProcessing(batchId);

    try {
      const fileBuffer = await this.fileStorageProvider.getObject(batch.storageKey);
      const parser = this.parsers[batch.documentType];
      const result = await parser.parse(batch, fileBuffer);

      await this.documentBatchService.markCompleted(batchId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch ${batchId} failed: ${message}`);
      await this.documentBatchService.markFailed(batchId, message);
    }
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/document-ingestion/document-ingestion.processor.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 9: Wire the module**

`src/document-ingestion/document-ingestion.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { SnapshotExportService } from './snapshot-export.service';
import { DocumentIngestionProcessor } from './document-ingestion.processor';
import { NoOpDocumentParser } from './no-op-document.parser';
import { DOCUMENT_PARSERS } from './document-parser.interface';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { DocumentType } from '../generated/prisma/client';

@Module({
  imports: [BullModule.registerQueue({ name: DOCUMENT_INGESTION_QUEUE }), FileStorageModule],
  providers: [
    DocumentBatchService,
    SnapshotExportService,
    DocumentIngestionProcessor,
    NoOpDocumentParser,
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (noOpParser: NoOpDocumentParser) => ({
        [DocumentType.IPPIS_BROADSHEET]: noOpParser,
        [DocumentType.REPAYMENT_SCHEDULE]: noOpParser,
        [DocumentType.DISBURSED_LOANS]: noOpParser,
      }),
      inject: [NoOpDocumentParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
```

(`BullModule` is re-exported so Task 7's controller, which lives in this same module, can `@InjectQueue(DOCUMENT_INGESTION_QUEUE)` — re-exporting a dynamic module that was imported is the standard NestJS pattern for sharing a registered queue with the module's own controllers/providers.)

- [ ] **Step 10: Commit**

```bash
git add src/document-ingestion
git commit -m "feat: add document parser registry, no-op parser, and BullMQ processor"
```

---

### Task 7: Upload and batch endpoints

**Files:**
- Create: `src/document-ingestion/dto/upload-repayment-schedule.dto.ts`
- Create: `src/document-ingestion/admin-documents.controller.ts`
- Modify: `src/document-ingestion/document-ingestion.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/document-upload.e2e-spec.ts`

**Interfaces:**
- Consumes: `DocumentBatchService`, `FILE_STORAGE_PROVIDER`, `DOCUMENT_INGESTION_QUEUE` (all prior tasks).
- Produces: `POST /admin/documents/ippis-broadsheet/upload`, `POST /admin/documents/disbursed-loans/upload`, `POST /admin/documents/repayment-schedule/upload`, `GET /admin/documents/batches`, `GET /admin/documents/batches/:id`.

- [ ] **Step 1: Add the repayment-schedule upload DTO**

`src/document-ingestion/dto/upload-repayment-schedule.dto.ts`:

```typescript
import { IsString, Matches } from 'class-validator';

export class UploadRepaymentScheduleDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be in YYYY-MM format' })
  period: string;
}
```

- [ ] **Step 2: Install multipart file typing**

```bash
npm install --save-dev @types/multer
```

- [ ] **Step 3: Implement the controller**

`src/document-ingestion/admin-documents.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DocumentBatchService } from './document-batch.service';
import { UploadRepaymentScheduleDto } from './dto/upload-repayment-schedule.dto';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentIngestionJobData } from './document-ingestion.processor';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

@Controller('admin/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminDocumentsController {
  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @InjectQueue(DOCUMENT_INGESTION_QUEUE) private readonly queue: Queue<DocumentIngestionJobData>,
  ) {}

  private async createAndEnqueue(
    documentType: DocumentType,
    file: Express.Multer.File,
    uploaderId: string,
    period?: string,
  ) {
    const storageKey = `uploads/${documentType.toLowerCase()}/${Date.now()}-${file.originalname}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);

    const batch = await this.documentBatchService.createBatch({
      documentType,
      uploadedById: uploaderId,
      originalFileName: file.originalname,
      storageKey,
      period,
    });

    await this.queue.add('process-batch', { batchId: batch.id });

    return { id: batch.id, status: batch.status, documentType: batch.documentType };
  }

  @Post('ippis-broadsheet/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('ippis:upload')
  uploadIppisBroadsheet(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.IPPIS_BROADSHEET, file, req.user.sub);
  }

  @Post('disbursed-loans/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('loans:upload')
  uploadDisbursedLoans(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.DISBURSED_LOANS, file, req.user.sub);
  }

  @Post('repayment-schedule/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('repayments:upload')
  uploadRepaymentSchedule(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadRepaymentScheduleDto,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.REPAYMENT_SCHEDULE, file, req.user.sub, dto.period);
  }

  @Get('batches')
  @RequirePermissions('documents:read')
  listBatches(
    @Query('documentType') documentType?: DocumentType,
    @Query('status') status?: DocumentBatchStatus,
  ) {
    return this.documentBatchService.list({ documentType, status });
  }

  @Get('batches/:id')
  @RequirePermissions('documents:read')
  getBatch(@Param('id') id: string) {
    return this.documentBatchService.findById(id);
  }
}
```

- [ ] **Step 4: Register the controller**

Modify `src/document-ingestion/document-ingestion.module.ts`: add the import and register the controller.

```typescript
import { AdminDocumentsController } from './admin-documents.controller';
```

Add `controllers: [AdminDocumentsController],` to the `@Module({...})` decorator (alongside the existing `imports`/`providers`/`exports`).

- [ ] **Step 5: Wire `FileStorageModule` and `DocumentIngestionModule` into `AppModule`**

Modify `src/app.module.ts`: add the imports and register both modules.

```typescript
import { FileStorageModule } from './file-storage/file-storage.module';
import { DocumentIngestionModule } from './document-ingestion/document-ingestion.module';
```

Add `FileStorageModule` and `DocumentIngestionModule` to the `imports` array.

- [ ] **Step 6: Write the e2e test**

`test/document-upload.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function waitForBatchCompletion(prisma: PrismaService, batchId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const batch = await prisma.documentUploadBatch.findUnique({ where: { id: batchId } });
    if (batch && (batch.status === 'COMPLETED' || batch.status === 'FAILED')) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

describe('Document uploads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const createdBatchIds: string[] = [];

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
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.documentUploadBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    await app.close();
  });

  it('uploads an IPPIS broadsheet file, processes it via the no-op parser, and completes', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/documents/ippis-broadsheet/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('fake-xlsx-content'), 'broadsheet.xlsx')
      .expect(201);

    expect(res.body.documentType).toBe('IPPIS_BROADSHEET');
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(0);
  });

  it('rejects an unauthenticated upload', () => {
    return request(app.getHttpServer())
      .post('/admin/documents/disbursed-loans/upload')
      .attach('file', Buffer.from('fake'), 'loans.xlsx')
      .expect(401);
  });

  it('rejects a repayment-schedule upload with no period', () => {
    return request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('fake'), 'repayments.xlsx')
      .expect(400);
  });

  it('accepts a repayment-schedule upload with a valid period and records it on the batch', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-12')
      .attach('file', Buffer.from('fake'), 'repayments.xlsx')
      .expect(201);
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.period).toBe('2024-12');
  });

  it('lists batches and fetches one by id', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/admin/documents/batches')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThan(0);

    const batchId = listRes.body[0].id;
    const detailRes = await request(app.getHttpServer())
      .get(`/admin/documents/batches/${batchId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detailRes.body.id).toBe(batchId);
  });
});
```

- [ ] **Step 7: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites, including this new one. This is the real end-to-end proof that Redis + BullMQ actually work in this environment — the upload endpoint enqueues a genuine job and the in-process worker (registered via `@Processor`) picks it up against the real Redis instance.

- [ ] **Step 8: Commit**

```bash
git add src/document-ingestion src/app.module.ts test/document-upload.e2e-spec.ts package.json package-lock.json
git commit -m "feat: add document upload and batch listing endpoints"
```

---

### Task 8: README and final regression pass

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: documentation of the new upload/batch endpoints and the "mock storage, no-op parsers for now" state of this plan.

- [ ] **Step 1: Update the README**

Add to `README.md`, after the existing "Audit log" section:

```markdown
## Document ingestion

Upload endpoints for the three source documents exist and are fully wired
(auth, permissions, audit logging, background processing via BullMQ), but
**no real parsing exists yet** — every document type is processed by a
no-op parser that records zero rows. Later work replaces one entry in
`DOCUMENT_PARSERS` (`src/document-ingestion/document-ingestion.module.ts`)
per document type; this plan only proves the pipeline shape end-to-end.

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /admin/documents/ippis-broadsheet/upload` | `ippis:upload` | Multipart, field `file` |
| `POST /admin/documents/disbursed-loans/upload` | `loans:upload` | Multipart, field `file` |
| `POST /admin/documents/repayment-schedule/upload` | `repayments:upload` | Multipart, field `file` + required `period` (`YYYY-MM`) |
| `GET /admin/documents/batches` | `documents:read` | List upload history, filterable by `documentType`/`status` |
| `GET /admin/documents/batches/:id` | `documents:read` | Batch detail incl. snapshot export links |
| `GET /admin/documents/files/:key` | `documents:read` | Download a stored file (raw upload or snapshot export) |

File storage is a local-disk mock (`LOCAL_STORAGE_DIR`, default `./storage`,
gitignored) — a real GCS/S3 vendor is a later, separate change behind the
same `FileStorageProvider` interface. Background processing uses BullMQ
against the `REDIS_URL`/`REDIS_KEY_PREFIX` already configured in your
environment.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite from Phase 1, the governance bundle, and this plan green together.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the ingestion infrastructure endpoints and current no-op state"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] All three upload endpoints accept a file, create a `DocumentUploadBatch`, and enqueue a real BullMQ job against the project's actual Redis instance.
- [ ] The in-process worker picks up the job, dispatches to the correct entry in `DOCUMENT_PARSERS`, and the batch reaches `COMPLETED` with zero counts (proving the no-op parser ran, not that nothing happened).
- [ ] `SnapshotExportService` produces syntactically valid-looking SQL `INSERT` statements and a correctly-quoted CSV from fixture data, verified by unit tests, independent of any real Prisma model existing yet.
- [ ] Repayment-schedule uploads reject a missing `period` before a job is ever enqueued.
- [ ] `PermissionsGuard` governs every new admin route with an explicit `@RequirePermissions(...)` — spot-check `AdminDocumentsController` and `FileDownloadController`.

**Next:** per the design's sequencing note, IPPIS Broadsheet ingestion is the next plan — it replaces the `IPPIS_BROADSHEET` entry in `DOCUMENT_PARSERS` with a real per-agency parser and is the first real consumer of `SnapshotExportService`.
