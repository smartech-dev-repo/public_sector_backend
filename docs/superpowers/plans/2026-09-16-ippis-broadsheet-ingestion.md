# IPPIS Broadsheet Ingestion Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `NoOpDocumentParser` behind `POST /admin/documents/ippis-broadsheet/upload` with a real parser that turns an uploaded IPPIS Broadsheet workbook into `IppisRecord` rows.

**Architecture:** A new `IppisRecord` Prisma model (doesn't exist yet). A pure, dependency-free row-mapping function (`mapIppisRow`) that turns one already-flattened `{header: value}` row into either a validated record or a rejection reason — fully unit-testable without touching Prisma or exceljs. An orchestration class (`IppisBroadsheetParser implements DocumentParser`) that reads the workbook with `exceljs`, iterates sheets, matches sheet names to known agencies, delegates row-by-row mapping to `mapIppisRow`, upserts by `(agency, staffId)`, and calls the existing `SnapshotExportService` before merging. Wired into the existing `DOCUMENT_PARSERS` registry in place of the no-op parser — no changes to `DocumentIngestionProcessor`, the controller, or the HTTP contract.

**Tech Stack:** NestJS 10, Prisma 7, `exceljs@^4.4.0` (already installed — see spec §6 for why not `xlsx`/SheetJS), Jest.

**Spec:** `docs/superpowers/specs/2026-09-16-ippis-broadsheet-ingestion-design.md`

## Global Constraints

- Every route already exists and is unchanged by this plan — no new endpoints, DTOs, or permissions.
- `IppisRecord` upsert key: `(agency, staffId)`, full overwrite on conflict (spec §4).
- Missing/blank Staff ID or Employee Name → row skipped (`rowsSkipped`), warning recorded, sheet continues.
- BVN present but not exactly 11 digits after stringification → row skipped, warning recorded (stricter than the general "warn but ingest" pattern — spec §8).
- Unrecognized sheet name → warning recorded, sheet skipped, other sheets still processed.
- `Email Address`, `Assignment Status` (every sheet) and NPF's `Grade Category` go into `IppisRecord.rawFields`, not first-class columns (spec §3).
- Never read from or reference `docs/added/` in committed code or test fixtures — it's gitignored real PII and must stay that way (this repo's `CLAUDE.md`).
- Per this repo's `CLAUDE.md`: the Postman collection's `POST /admin/documents/ippis-broadsheet/upload - Success` request description currently says "real parsing isn't built yet" — that becomes false the moment this ships, so Task 4 updates it in the same change.

---

### Task 1: Add the `IppisRecord` Prisma model

**Files:**
- Modify: `prisma/schema.prisma` (append after the `DataSnapshotExport` model, currently the last model at end of file, line 228)

**Interfaces:**
- Produces: the `IppisRecord` Prisma model and generated TypeScript type (`import { IppisRecord } from '../generated/prisma/client'`), with fields exactly as listed below — Task 2 and Task 3 both depend on these exact field names.

- [ ] **Step 1: Append the model**

Add to the end of `prisma/schema.prisma`:

```prisma
model IppisRecord {
  id              String    @id @default(uuid())
  agency          String
  staffId         String
  employeeName    String
  employeeStatus  String?
  hireDate        DateTime?
  dateOfBirth     DateTime?
  maritalStatus   String?
  gender          String?
  jobTitle        String?
  department      String?
  subOrganization String?
  grade           String?
  step            String?
  salary          Decimal?
  phone           String?
  bankName        String?
  accountNumber   String?
  pfaName         String?
  pinNumber       String?
  dateTerminated  DateTime?
  bvn             String?
  legacyId        String?
  rawFields       Json?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([agency, staffId])
}
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_ippis_record`
Expected: creates `prisma/migrations/<timestamp>_add_ippis_record/migration.sql`, applies it to the real database, and regenerates the Prisma client at `src/generated/prisma`. Confirm no errors.

- [ ] **Step 3: Verify the client regenerated correctly**

Run: `npx tsc --noEmit`
Expected: no type errors. This confirms `src/generated/prisma/client.ts` now exports an `IppisRecord` type and `prisma.ippisRecord` is a valid property.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add IppisRecord model for broadsheet ingestion"
```

---

### Task 2: `mapIppisRow` — pure row-mapping function

**Files:**
- Create: `src/document-ingestion/parsers/ippis-row-mapper.ts`
- Test: `src/document-ingestion/parsers/ippis-row-mapper.spec.ts`

**Interfaces:**
- Consumes: nothing (pure function, no DI, no I/O).
- Produces: `mapIppisRow(rowByHeader: Record<string, unknown>): RowMappingResult`, where:
  ```typescript
  export interface MappedIppisFields {
    staffId: string;
    employeeName: string;
    employeeStatus: string | null;
    hireDate: Date | null;
    dateOfBirth: Date | null;
    maritalStatus: string | null;
    gender: string | null;
    jobTitle: string | null;
    department: string | null;
    subOrganization: string | null;
    grade: string | null;
    step: string | null;
    salary: number | null;
    phone: string | null;
    bankName: string | null;
    accountNumber: string | null;
    pfaName: string | null;
    pinNumber: string | null;
    dateTerminated: Date | null;
    bvn: string | null;
    legacyId: string | null;
    rawFields: Record<string, unknown>;
  }
  export interface RowMappingSuccess {
    ok: true;
    record: MappedIppisFields;
    warnings: string[];
  }
  export interface RowMappingFailure {
    ok: false;
    reason: string;
  }
  export type RowMappingResult = RowMappingSuccess | RowMappingFailure;
  ```
  `rowByHeader` keys are lowercase, trimmed header names (e.g. `'staff id'`, `'employee name'`, `'bvn'`) — Task 3's `buildRowByHeader` produces this shape and is the only other place that needs to know the header-to-key convention.

- [ ] **Step 1: Write the failing tests**

`src/document-ingestion/parsers/ippis-row-mapper.spec.ts`:

```typescript
import { mapIppisRow } from './ippis-row-mapper';

describe('mapIppisRow', () => {
  const baseRow = {
    'staff id': 'NPF/1234',
    'employee name': 'Jane Doe',
    'employee status': 'Active',
    'hire date': new Date('2020-01-15'),
    'date of birth': new Date('1990-05-20'),
    'marital status': 'Single',
    gender: 'Female',
    'job title': 'Sergeant',
    'sub organization': 'Zone 2',
    grade: '08',
    step: '3',
    'telephone number': 8031234567,
    'bank name': 'GTBank',
    'account number': '0123456789',
    bvn: 22345678901,
  };

  it('maps a full row into MappedIppisFields', () => {
    const result = mapIppisRow(baseRow);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.record.staffId).toBe('NPF/1234');
    expect(result.record.employeeName).toBe('Jane Doe');
    expect(result.record.hireDate).toEqual(new Date('2020-01-15'));
    expect(result.record.bvn).toBe('22345678901');
    expect(result.record.phone).toBe('8031234567');
    expect(result.record.department).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('captures unknown headers into rawFields', () => {
    const result = mapIppisRow({
      ...baseRow,
      'email address': 'jane@example.com',
      'assignment status': 'Confirmed',
      'grade category': 'Uniform',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.record.rawFields).toEqual({
      'email address': 'jane@example.com',
      'assignment status': 'Confirmed',
      'grade category': 'Uniform',
    });
  });

  it('rejects a row missing Staff ID', () => {
    const result = mapIppisRow({ ...baseRow, 'staff id': '' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/Staff ID/);
  });

  it('rejects a row missing Employee Name', () => {
    const result = mapIppisRow({ ...baseRow, 'employee name': undefined });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/Employee Name/);
  });

  it('rejects a row with a BVN that is not 11 digits', () => {
    const result = mapIppisRow({ ...baseRow, bvn: 123 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/BVN/);
  });

  it('allows a missing BVN (not every record is guaranteed to have one)', () => {
    const { bvn: _omit, ...rowWithoutBvn } = baseRow;
    const result = mapIppisRow(rowWithoutBvn);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.record.bvn).toBeNull();
  });

  it('records a warning and nulls the field for an unparseable date, without rejecting the row', () => {
    const result = mapIppisRow({ ...baseRow, 'hire date': 'not-a-date' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.record.hireDate).toBeNull();
    expect(result.warnings[0]).toMatch(/hire date/);
  });

  it('parses a numeric salary and leaves it null when absent', () => {
    const withSalary = mapIppisRow({ ...baseRow, salary: 250000 });
    if (!withSalary.ok) throw new Error('expected success');
    expect(withSalary.record.salary).toBe(250000);

    const withoutSalary = mapIppisRow(baseRow);
    if (!withoutSalary.ok) throw new Error('expected success');
    expect(withoutSalary.record.salary).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/ippis-row-mapper.spec.ts`
Expected: FAIL — `Cannot find module './ippis-row-mapper'`

- [ ] **Step 3: Implement `mapIppisRow`**

`src/document-ingestion/parsers/ippis-row-mapper.ts`:

```typescript
const IPPIS_KNOWN_HEADERS: Record<string, keyof Omit<MappedIppisFields, 'rawFields'>> = {
  'staff id': 'staffId',
  'employee name': 'employeeName',
  'employee status': 'employeeStatus',
  'hire date': 'hireDate',
  'date of birth': 'dateOfBirth',
  'marital status': 'maritalStatus',
  gender: 'gender',
  'job title': 'jobTitle',
  department: 'department',
  'sub organization': 'subOrganization',
  grade: 'grade',
  step: 'step',
  salary: 'salary',
  'telephone number': 'phone',
  'bank name': 'bankName',
  'account number': 'accountNumber',
  'pfa name': 'pfaName',
  'pin number': 'pinNumber',
  'date terminated': 'dateTerminated',
  bvn: 'bvn',
  'legacy id': 'legacyId',
};

export interface MappedIppisFields {
  staffId: string;
  employeeName: string;
  employeeStatus: string | null;
  hireDate: Date | null;
  dateOfBirth: Date | null;
  maritalStatus: string | null;
  gender: string | null;
  jobTitle: string | null;
  department: string | null;
  subOrganization: string | null;
  grade: string | null;
  step: string | null;
  salary: number | null;
  phone: string | null;
  bankName: string | null;
  accountNumber: string | null;
  pfaName: string | null;
  pinNumber: string | null;
  dateTerminated: Date | null;
  bvn: string | null;
  legacyId: string | null;
  rawFields: Record<string, unknown>;
}

export interface RowMappingSuccess {
  ok: true;
  record: MappedIppisFields;
  warnings: string[];
}

export interface RowMappingFailure {
  ok: false;
  reason: string;
}

export type RowMappingResult = RowMappingSuccess | RowMappingFailure;

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function stringifyIdLikeValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(Math.trunc(value));
  return String(value).trim() || null;
}

function parseSalaryCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseDateCell(value: unknown): { date: Date | null; warning?: string } {
  if (value === null || value === undefined || value === '') return { date: null };
  if (value instanceof Date) return { date: value };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return { date: null, warning: `unparseable date value "${value}"` };
  }
  return { date: parsed };
}

export function mapIppisRow(rowByHeader: Record<string, unknown>): RowMappingResult {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (IPPIS_KNOWN_HEADERS[header]) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }

  const staffId = stringifyIdLikeValue(rowByHeader['staff id']);
  if (!staffId) {
    return { ok: false, reason: 'missing Staff ID' };
  }

  const employeeName = stringOrNull(rowByHeader['employee name']);
  if (!employeeName) {
    return { ok: false, reason: 'missing Employee Name' };
  }

  const bvn = stringifyIdLikeValue(rowByHeader['bvn']);
  if (bvn !== null && bvn.length !== 11) {
    return { ok: false, reason: `BVN "${bvn}" is not 11 digits` };
  }

  const warnings: string[] = [];
  const hireDate = parseDateCell(rowByHeader['hire date']);
  if (hireDate.warning) warnings.push(`hire date: ${hireDate.warning}`);
  const dateOfBirth = parseDateCell(rowByHeader['date of birth']);
  if (dateOfBirth.warning) warnings.push(`date of birth: ${dateOfBirth.warning}`);
  const dateTerminated = parseDateCell(rowByHeader['date terminated']);
  if (dateTerminated.warning) warnings.push(`date terminated: ${dateTerminated.warning}`);

  return {
    ok: true,
    warnings,
    record: {
      staffId,
      employeeName,
      employeeStatus: stringOrNull(rowByHeader['employee status']),
      hireDate: hireDate.date,
      dateOfBirth: dateOfBirth.date,
      maritalStatus: stringOrNull(rowByHeader['marital status']),
      gender: stringOrNull(rowByHeader['gender']),
      jobTitle: stringOrNull(rowByHeader['job title']),
      department: stringOrNull(rowByHeader['department']),
      subOrganization: stringOrNull(rowByHeader['sub organization']),
      grade: stringOrNull(rowByHeader['grade']),
      step: stringOrNull(rowByHeader['step']),
      salary: parseSalaryCell(rowByHeader['salary']),
      phone: stringifyIdLikeValue(rowByHeader['telephone number']),
      bankName: stringOrNull(rowByHeader['bank name']),
      accountNumber: stringOrNull(rowByHeader['account number']),
      pfaName: stringOrNull(rowByHeader['pfa name']),
      pinNumber: stringifyIdLikeValue(rowByHeader['pin number']),
      dateTerminated: dateTerminated.date,
      bvn,
      legacyId: stringOrNull(rowByHeader['legacy id']),
      rawFields,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/ippis-row-mapper.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/parsers/ippis-row-mapper.ts src/document-ingestion/parsers/ippis-row-mapper.spec.ts
git commit -m "feat: add pure IPPIS broadsheet row-mapping function"
```

---

### Task 3: `IppisBroadsheetParser` orchestration

**Files:**
- Create: `src/document-ingestion/parsers/ippis-broadsheet.parser.ts`
- Test: `src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts`

**Interfaces:**
- Consumes: `mapIppisRow` (Task 2), `PrismaService` (`this.prisma.ippisRecord.findMany`/`.upsert`), `SnapshotExportService.exportSnapshot(input): Promise<DataSnapshotExport>` (existing, returns an object with an `id` field), the `DocumentParser` interface (existing, `src/document-ingestion/document-parser.interface.ts`).
- Produces: `IppisBroadsheetParser implements DocumentParser` — `parse(batch, fileBuffer): Promise<ParseResult>` where `ParseResult = { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings: string[], snapshotExportId?: string }` (already defined, unchanged) — Task 4 registers this class in `DOCUMENT_PARSERS`.

- [ ] **Step 1: Write the failing tests**

`src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts`:

```typescript
import * as ExcelJS from 'exceljs';
import { IppisBroadsheetParser } from './ippis-broadsheet.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

async function buildWorkbook(sheets: Record<string, { headers: string[]; rows: unknown[][] }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [sheetName, { headers, rows }] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
  }
  return workbook.xlsx.writeBuffer() as Promise<Buffer>;
}

describe('IppisBroadsheetParser', () => {
  let parser: IppisBroadsheetParser;
  let prisma: { ippisRecord: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = {
      ippisRecord: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new IppisBroadsheetParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  const NPF_HEADERS = ['Staff ID', 'Employee Name', 'Employee Status', 'Bvn'];

  it('parses rows from a recognized agency sheet and upserts each as a new record', async () => {
    const buffer = await buildWorkbook({
      NPF: { headers: NPF_HEADERS, rows: [['NPF/1', 'Jane Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.rowsUpdated).toBe(0);
    expect(result.rowsSkipped).toBe(0);
    expect(result.snapshotExportId).toBe('snap-1');
    expect(prisma.ippisRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agency_staffId: { agency: 'NPF', staffId: 'NPF/1' } },
        create: expect.objectContaining({ agency: 'NPF', staffId: 'NPF/1', employeeName: 'Jane Doe' }),
      }),
    );
  });

  it('counts an existing (agency, staffId) as an update, not a create', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([{ agency: 'NPF', staffId: 'NPF/1' }]);
    const buffer = await buildWorkbook({
      NPF: { headers: NPF_HEADERS, rows: [['NPF/1', 'Jane Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('skips an unrecognized sheet with a warning and does not fail the batch', async () => {
    const buffer = await buildWorkbook({
      SomeOtherAgency: { headers: NPF_HEADERS, rows: [['X/1', 'John Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(0);
    expect(prisma.ippisRecord.upsert).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.includes('SomeOtherAgency'))).toBe(true);
  });

  it('skips an invalid row (bad BVN) but still processes the rest of the sheet', async () => {
    const buffer = await buildWorkbook({
      NPF: {
        headers: NPF_HEADERS,
        rows: [
          ['NPF/1', 'Jane Doe', 'Active', 123],
          ['NPF/2', 'John Smith', 'Active', 22345678902],
        ],
      },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('BVN'))).toBe(true);
  });

  it('calls exportSnapshot with the current IppisRecord table before upserting', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([
      { id: 'r1', agency: 'NPF', staffId: 'NPF/9', rawFields: { 'email address': 'x@example.com' } },
    ]);
    const buffer = await buildWorkbook({ NPF: { headers: NPF_HEADERS, rows: [] } });

    await parser.parse({} as DocumentUploadBatch, buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'IPPIS_BROADSHEET',
        tableName: 'IppisRecord',
        rows: [expect.objectContaining({ id: 'r1', rawFields: JSON.stringify({ 'email address': 'x@example.com' }) })],
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts`
Expected: FAIL — `Cannot find module './ippis-broadsheet.parser'`

- [ ] **Step 3: Implement `IppisBroadsheetParser`**

`src/document-ingestion/parsers/ippis-broadsheet.parser.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType } from '../../generated/prisma/client';
import { mapIppisRow } from './ippis-row-mapper';

const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL'];

const SNAPSHOT_COLUMNS = [
  'id', 'agency', 'staffId', 'employeeName', 'employeeStatus', 'hireDate', 'dateOfBirth',
  'maritalStatus', 'gender', 'jobTitle', 'department', 'subOrganization', 'grade', 'step',
  'salary', 'phone', 'bankName', 'accountNumber', 'pfaName', 'pinNumber', 'dateTerminated',
  'bvn', 'legacyId', 'rawFields', 'createdAt', 'updatedAt',
];

function buildRowByHeader(headerValues: unknown[], rowValues: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  headerValues.forEach((header, index) => {
    if (typeof header !== 'string' || !header.trim()) return;
    result[header.trim().toLowerCase()] = rowValues[index];
  });
  return result;
}

@Injectable()
export class IppisBroadsheetParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(_batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);

    const currentRecords = await this.prisma.ippisRecord.findMany();
    const existingKeys = new Set(currentRecords.map((r) => `${r.agency}::${r.staffId}`));

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
      columns: SNAPSHOT_COLUMNS,
      rows: currentRecords.map((r) => ({
        ...r,
        rawFields: r.rawFields ? JSON.stringify(r.rawFields) : null,
      })),
    });

    let rowsProcessed = 0;
    let rowsCreated = 0;
    let rowsUpdated = 0;
    let rowsSkipped = 0;
    const warnings: string[] = [];

    for (const worksheet of workbook.worksheets) {
      const agency = KNOWN_AGENCIES.find((a) => a.toLowerCase() === worksheet.name.trim().toLowerCase());
      if (!agency) {
        warnings.push(`Unrecognized sheet "${worksheet.name}" skipped`);
        continue;
      }

      const headerValues = worksheet.getRow(1).values as unknown[];

      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        rowsProcessed++;

        const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
        const mapped = mapIppisRow(rowByHeader);

        if (!mapped.ok) {
          rowsSkipped++;
          warnings.push(`Sheet "${agency}" row ${rowNumber}: ${mapped.reason}`);
          continue;
        }
        warnings.push(...mapped.warnings.map((w) => `Sheet "${agency}" row ${rowNumber}: ${w}`));

        const key = `${agency}::${mapped.record.staffId}`;
        const isUpdate = existingKeys.has(key);

        await this.prisma.ippisRecord.upsert({
          where: { agency_staffId: { agency, staffId: mapped.record.staffId } },
          create: { agency, ...mapped.record },
          update: { ...mapped.record },
        });

        if (isUpdate) {
          rowsUpdated++;
        } else {
          rowsCreated++;
        }
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/parsers/ippis-broadsheet.parser.ts src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts
git commit -m "feat: add IppisBroadsheetParser orchestration"
```

---

### Task 4: Wire into the registry, e2e test, README, and Postman

**Files:**
- Modify: `src/document-ingestion/document-ingestion.module.ts`
- Test: `test/ippis-broadsheet-ingestion.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `IppisBroadsheetParser` (Task 3), existing `DOCUMENT_PARSERS` token and `DocumentIngestionModule` (unchanged shape).
- Produces: nothing new for later tasks — this is the final task in this plan.

- [ ] **Step 1: Register the real parser**

Modify `src/document-ingestion/document-ingestion.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { SnapshotExportService } from './snapshot-export.service';
import { DocumentIngestionProcessor } from './document-ingestion.processor';
import { NoOpDocumentParser } from './no-op-document.parser';
import { IppisBroadsheetParser } from './parsers/ippis-broadsheet.parser';
import { DOCUMENT_PARSERS } from './document-parser.interface';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentType } from '../generated/prisma/client';
import { AdminDocumentsController } from './admin-documents.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: DOCUMENT_INGESTION_QUEUE }),
    FileStorageModule,
    AuditModule,
  ],
  controllers: [AdminDocumentsController],
  providers: [
    DocumentBatchService,
    SnapshotExportService,
    DocumentIngestionProcessor,
    NoOpDocumentParser,
    IppisBroadsheetParser,
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (noOpParser: NoOpDocumentParser, ippisParser: IppisBroadsheetParser) => ({
        [DocumentType.IPPIS_BROADSHEET]: ippisParser,
        [DocumentType.REPAYMENT_SCHEDULE]: noOpParser,
        [DocumentType.DISBURSED_LOANS]: noOpParser,
      }),
      inject: [NoOpDocumentParser, IppisBroadsheetParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
```

- [ ] **Step 2: Write the e2e test**

`test/ippis-broadsheet-ingestion.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function buildBroadsheetBuffer(staffId: string, bvn: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('NPF');
  sheet.addRow(['Staff ID', 'Employee Name', 'Employee Status', 'Bvn']);
  sheet.addRow([staffId, 'E2E Test Employee', 'Active', bvn]);
  return workbook.xlsx.writeBuffer() as Promise<Buffer>;
}

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

describe('IPPIS broadsheet ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const staffId = `E2E-STAFF-${Date.now()}`;
  const bvn = 20000000000 + Math.floor(Math.random() * 999999999);

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
    if (prisma) {
      await prisma.ippisRecord.deleteMany({ where: { staffId } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded broadsheet into an IppisRecord and creates a snapshot export', async () => {
    const buffer = await buildBroadsheetBuffer(staffId, bvn);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/ippis-broadsheet/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', buffer, 'broadsheet.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(1);
    expect(batch!.rowsCreated).toBe(1);
    expect(batch!.snapshotExportId).not.toBeNull();

    const record = await prisma.ippisRecord.findUnique({ where: { agency_staffId: { agency: 'NPF', staffId } } });
    expect(record).not.toBeNull();
    expect(record!.employeeName).toBe('E2E Test Employee');
    expect(record!.bvn).toBe(String(bvn));
  });
});
```

- [ ] **Step 3: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/ippis-broadsheet-ingestion.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 4: Update the README**

In `README.md`'s existing "Document ingestion" section, replace the sentence "Upload endpoints for the three source documents exist and are fully wired (auth, permissions, audit logging, background processing via BullMQ), but **no real parsing exists yet** — every document type is processed by a no-op parser that records zero rows." with:

```markdown
Upload endpoints for the three source documents exist and are fully wired
(auth, permissions, audit logging, background processing via BullMQ).
**IPPIS Broadsheet uploads are fully parsed** into `IppisRecord` rows
(upserted by `agency` + `staffId`) — see
`src/document-ingestion/parsers/ippis-broadsheet.parser.ts`. Disbursed
Loans and Repayment Schedule uploads are still processed by a no-op parser
that records zero rows; later work replaces their entries in
`DOCUMENT_PARSERS` (`src/document-ingestion/document-ingestion.module.ts`).
```

- [ ] **Step 5: Update the stale Postman description**

In `postman/public-sector-backend.postman_collection.json`, find the request named `"POST /admin/documents/ippis-broadsheet/upload - Success"` under **IPPIS > Documents**. Its `request.description` currently reads:

```
Attach any .xlsx file (real parsing isn't built yet — a NoOpDocumentParser always reports 0 rows regardless of content). Do NOT attach the real sample files under docs/added/ to a shared workspace — those contain real BVNs/bank data and are gitignored for that reason.
```

Replace it with:

```
Attach an .xlsx file with one sheet per agency (NPF/NSCDC/IMMIGRATION/CORRECTIONAL), each with a header row containing at least "Staff ID" and "Employee Name" — rows are upserted into IppisRecord by (agency, staffId). Do NOT attach the real sample files under docs/added/ to a shared workspace — those contain real BVNs/bank data and are gitignored for that reason.
```

- [ ] **Step 6: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`
Expected: `VALID`

- [ ] **Step 7: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the 3 new ones from this plan.

- [ ] **Step 8: Commit**

```bash
git add src/document-ingestion/document-ingestion.module.ts test/ippis-broadsheet-ingestion.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: wire IppisBroadsheetParser into the document-ingestion pipeline"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] Uploading a real-shaped IPPIS Broadsheet workbook produces `IppisRecord` rows and a `DataSnapshotExport`, proven by `test/ippis-broadsheet-ingestion.e2e-spec.ts`.
- [ ] A row with a missing Staff ID/Employee Name or a malformed BVN is skipped (not ingested, not fatal to the batch) — proven by `ippis-broadsheet.parser.spec.ts`.
- [ ] An unrecognized sheet name produces a warning and does not fail the batch — proven by `ippis-broadsheet.parser.spec.ts`.
- [ ] Re-uploading the same `(agency, staffId)` updates rather than duplicates — proven by `ippis-broadsheet.parser.spec.ts`.
- [ ] `Email Address`/`Assignment Status`/NPF's `Grade Category` land in `rawFields`, not dropped — proven by `ippis-row-mapper.spec.ts`.
- [ ] Postman's `POST /admin/documents/ippis-broadsheet/upload - Success` request no longer claims parsing isn't built.
