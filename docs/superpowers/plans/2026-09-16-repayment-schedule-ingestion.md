# Repayment Schedule Ingestion Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `NoOpDocumentParser` behind `POST /admin/documents/repayment-schedule/upload` with a real parser that turns an uploaded Repayment Schedule workbook into `LoanRepaymentRecord` rows.

**Architecture:** A new `LoanRepaymentRecord` Prisma model. Six small pure per-agency row-mapping functions (`mapNpfRow`, `mapNscdcRow`, `mapImmigrationRow`, `mapCorrectionalRow`, `mapCustomRow`, `mapLasgRow`) in one module, each hardcoded to its own sheet's real column names (these 6 sheets share almost no headers, unlike the IPPIS Broadsheet's 3-near-identical-sheets case), dispatched via an `AGENCY_ROW_MAPPERS` table keyed by sheet name. An orchestration class (`RepaymentScheduleParser implements DocumentParser`) that locates LASG's header row (row 3, not row 1), applies the period-fallback/mismatch logic from the parent design, and — closing a gap present in the two earlier parsers — wraps each row's processing in its own try/catch so one malformed row can never take down the rest of its sheet. Wired into the existing `DOCUMENT_PARSERS` registry — no changes to `DocumentIngestionProcessor`, the controller, or the HTTP contract.

**Tech Stack:** NestJS 10, Prisma 7, `exceljs@^4.4.0` (already a dependency), Jest.

**Spec:** `docs/superpowers/specs/2026-09-16-repayment-schedule-ingestion-design.md`

## Global Constraints

- Every route already exists and is unchanged by this plan — no new endpoints, DTOs, or permissions. The upload endpoint already requires `period` in `YYYY-MM` format (`src/document-ingestion/dto/upload-repayment-schedule.dto.ts`).
- `LoanRepaymentRecord` upsert key: `(agency, staffId, period, elementName)`, full overwrite on conflict (spec §3).
- IMMIGRATION and CORRECTIONAL sheets have both "IPPIS NUMBER" and "StaffID" columns — "IPPIS NUMBER" is authoritative (spec §2).
- Only NPF has a real per-row `Element` value; the other 5 sheets get the fixed sentinel `elementName = "LOAN_REPAYMENT"`. CUSTOM's "Loan Type" column populates a separate `elementDetail` field, not `elementName` (spec §4).
- NPF and CUSTOM have their own per-row period column (needs normalizing from `"SEPTEMBER 2024"`/`"202512"`-style values to `YYYY-MM`); the other 4 sheets have no period column and fall back to the upload's own `period` field. A mismatch between a row's own period and the upload's period is a warning, not a rejection — the row is ingested under its own period (spec §4, parent design §5).
- LASG's real header row is row 3, not row 1 — rows 1–2 are a title block (spec §2).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as any behavior change visible through an existing request.
- Never read real data rows from `docs/added/` — headers/structure only (this session's standing instruction).

---

### Task 1: Add the `LoanRepaymentRecord` Prisma model

**Files:**
- Modify: `prisma/schema.prisma` (append after the `Loan` model, currently the last model)

**Interfaces:**
- Produces: the `LoanRepaymentRecord` Prisma model and generated TypeScript type — Task 2 and Task 3 depend on these exact field names.

- [ ] **Step 1: Append the model**

Add to the end of `prisma/schema.prisma`:

```prisma
model LoanRepaymentRecord {
  id            String    @id @default(uuid())
  agency        String
  staffId       String
  period        String?
  elementName   String
  elementDetail String?
  amount        Decimal
  rawFields     Json?
  createdAt     DateTime  @default(now())

  @@unique([agency, staffId, period, elementName])
}
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_loan_repayment_record`
Expected: creates `prisma/migrations/<timestamp>_add_loan_repayment_record/migration.sql`, applies it to the real database.

- [ ] **Step 3: Explicitly regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the client regenerated correctly**

Run: `grep -n "LoanModel\|LoanRepaymentRecordModel" src/generated/prisma/client.ts`
Expected: both `export type Loan = Prisma.LoanModel` and `export type LoanRepaymentRecord = Prisma.LoanRepaymentRecordModel` lines appear.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add LoanRepaymentRecord model for repayment schedule ingestion"
```

---

### Task 2: Six per-agency row-mapping functions

**Files:**
- Create: `src/document-ingestion/parsers/repayment-row-mapper.ts`
- Test: `src/document-ingestion/parsers/repayment-row-mapper.spec.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no DI, no I/O).
- Produces:
  ```typescript
  export type AgencyKey = 'NPF' | 'NSCDC' | 'IMMIGRATION' | 'CORRECTIONAL' | 'CUSTOM' | 'LASG';

  export interface MappedRepaymentFields {
    staffId: string;
    elementName: string;
    elementDetail: string | null;
    amount: number;
    period: string | null; // this row's own period (normalized to YYYY-MM), or null to fall back to the upload's period
    rawFields: Record<string, unknown>;
  }
  export interface RepaymentRowMappingSuccess {
    ok: true;
    record: MappedRepaymentFields;
    warnings: string[];
  }
  export interface RepaymentRowMappingFailure {
    ok: false;
    reason: string;
  }
  export type RepaymentRowMappingResult = RepaymentRowMappingSuccess | RepaymentRowMappingFailure;

  export function isRepaymentRowMappingFailure(result: RepaymentRowMappingResult): result is RepaymentRowMappingFailure;
  export function normalizePeriod(value: unknown): string | null;
  export const AGENCY_ROW_MAPPERS: Record<AgencyKey, (rowByHeader: Record<string, unknown>) => RepaymentRowMappingResult>;
  ```
  `rowByHeader` keys are lowercase, trimmed header names exactly as they appear in the real file per sheet (e.g. `'staff id'`, `'ippis no'`, `'cit microfinance'`, `'employee_number'`) — Task 3's `buildRowByHeader` (already extracted in the Disbursed Loans plan, at `src/document-ingestion/parsers/build-row-by-header.ts`) produces this shape.

- [ ] **Step 1: Write the failing tests**

`src/document-ingestion/parsers/repayment-row-mapper.spec.ts`:

```typescript
import {
  AGENCY_ROW_MAPPERS,
  isRepaymentRowMappingFailure,
  normalizePeriod,
  RepaymentRowMappingFailure,
  RepaymentRowMappingResult,
  RepaymentRowMappingSuccess,
} from './repayment-row-mapper';

function assertSuccess(result: RepaymentRowMappingResult): asserts result is RepaymentRowMappingSuccess {
  if (!result.ok) throw new Error(`expected success but got failure: ${(result as RepaymentRowMappingFailure).reason}`);
}

function assertFailure(result: RepaymentRowMappingResult): asserts result is RepaymentRowMappingFailure {
  if (result.ok) throw new Error('expected failure but got success');
}

describe('normalizePeriod', () => {
  it('normalizes "MONTH YYYY" style values', () => {
    expect(normalizePeriod('SEPTEMBER 2024')).toBe('2024-09');
    expect(normalizePeriod('january 2025')).toBe('2025-01');
  });

  it('normalizes "YYYYMM" style values', () => {
    expect(normalizePeriod('202512')).toBe('2025-12');
  });

  it('passes through already-normalized "YYYY-MM" values', () => {
    expect(normalizePeriod('2024-11')).toBe('2024-11');
  });

  it('returns null for missing or unparseable values', () => {
    expect(normalizePeriod('')).toBeNull();
    expect(normalizePeriod(undefined)).toBeNull();
    expect(normalizePeriod('not a period')).toBeNull();
  });
});

describe('mapNpfRow', () => {
  const baseRow = {
    'staff id': 'NPF/1',
    check: 'OK',
    'legacy id': 'L1',
    'full name': 'TEST STAFF',
    element: 'PERSONAL LOAN',
    amount: 5000,
    period: 'SEPTEMBER 2024',
    command: 'Zone 2',
    'reason/comments': '',
  };

  it('maps a full row', () => {
    const result = AGENCY_ROW_MAPPERS.NPF(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('NPF/1');
    expect(result.record.elementName).toBe('PERSONAL LOAN');
    expect(result.record.amount).toBe(5000);
    expect(result.record.period).toBe('2024-09');
    expect(result.record.elementDetail).toBeNull();
    expect(result.record.rawFields).toEqual({ check: 'OK', 'legacy id': 'L1', 'full name': 'TEST STAFF', command: 'Zone 2' });
  });

  it('rejects a row missing Staff ID', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, 'staff id': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, amount: 'not-a-number' }));
  });

  it('rejects a row missing Element (the natural-key discriminator for NPF)', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, element: '' }));
  });
});

describe('mapNscdcRow', () => {
  const baseRow = { 'employee name': 'TEST STAFF', 'ippis no': 'CD1', amount: 3000 };

  it('maps a full row with the fixed elementName sentinel', () => {
    const result = AGENCY_ROW_MAPPERS.NSCDC(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('CD1');
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.amount).toBe(3000);
    expect(result.record.period).toBeNull();
    expect(result.record.rawFields).toEqual({ 'employee name': 'TEST STAFF' });
  });

  it('rejects a row missing IPPIS NO', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NSCDC({ ...baseRow, 'ippis no': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NSCDC({ ...baseRow, amount: 'bad' }));
  });
});

describe('mapImmigrationRow', () => {
  const baseRow = {
    surname: 'TEST',
    'other names': 'STAFF',
    'ippis number': 'NI1',
    staffid: 'INTERNAL-1',
    'cit microfinance': 2000,
  };

  it('maps a full row, preferring IPPIS NUMBER over StaffID', () => {
    const result = AGENCY_ROW_MAPPERS.IMMIGRATION(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('NI1');
    expect(result.record.amount).toBe(2000);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.rawFields).toEqual({ surname: 'TEST', 'other names': 'STAFF', staffid: 'INTERNAL-1' });
  });

  it('rejects a row missing IPPIS NUMBER', () => {
    assertFailure(AGENCY_ROW_MAPPERS.IMMIGRATION({ ...baseRow, 'ippis number': '' }));
  });

  it('rejects a row missing or unparseable CIT MICROFINANCE amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.IMMIGRATION({ ...baseRow, 'cit microfinance': 'bad' }));
  });
});

describe('mapCorrectionalRow', () => {
  const baseRow = {
    'surname other names': 'TEST STAFF',
    'ippis number': 'PR1',
    staffid: 'INTERNAL-2',
    amount: 4000,
    'account number': 'ACC-1',
    bank: 'TEST BANK',
    'element name': 'PERSONAL LOAN',
    'deduction beneficiary': 'MONEYFIELD',
  };

  it('maps a full row, preferring IPPIS NUMBER over StaffID', () => {
    const result = AGENCY_ROW_MAPPERS.CORRECTIONAL(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('PR1');
    expect(result.record.amount).toBe(4000);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.rawFields).toEqual({
      'surname other names': 'TEST STAFF',
      staffid: 'INTERNAL-2',
      'account number': 'ACC-1',
      bank: 'TEST BANK',
      'element name': 'PERSONAL LOAN',
      'deduction beneficiary': 'MONEYFIELD',
    });
  });

  it('rejects a row missing IPPIS NUMBER', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CORRECTIONAL({ ...baseRow, 'ippis number': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CORRECTIONAL({ ...baseRow, amount: 'bad' }));
  });
});

describe('mapCustomRow', () => {
  const baseRow = {
    's/n': 1,
    period: '202412',
    'staff number': 'CUST-1',
    'staff name': 'TEST STAFF',
    'loan type': 'SALARY ADVANCE',
    deduction: 1500,
  };

  it('maps a full row, putting Loan Type into elementDetail', () => {
    const result = AGENCY_ROW_MAPPERS.CUSTOM(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('CUST-1');
    expect(result.record.amount).toBe(1500);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.elementDetail).toBe('SALARY ADVANCE');
    expect(result.record.period).toBe('2024-12');
    expect(result.record.rawFields).toEqual({ 's/n': 1, 'staff name': 'TEST STAFF' });
  });

  it('rejects a row missing Staff Number', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CUSTOM({ ...baseRow, 'staff number': '' }));
  });

  it('rejects a row missing or unparseable Deduction', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CUSTOM({ ...baseRow, deduction: 'bad' }));
  });
});

describe('mapLasgRow', () => {
  const baseRow = {
    employee_number: 'LASG-1',
    employee_name: 'TEST STAFF',
    ministry_name: 'MINISTRY OF TEST',
    grade_level: '08',
    step: '3',
    'result_value sum': 2500,
    element_name: 'LOAN',
  };

  it('maps a full row with the fixed elementName sentinel', () => {
    const result = AGENCY_ROW_MAPPERS.LASG(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('LASG-1');
    expect(result.record.amount).toBe(2500);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.period).toBeNull();
    expect(result.record.rawFields).toEqual({
      employee_name: 'TEST STAFF',
      ministry_name: 'MINISTRY OF TEST',
      grade_level: '08',
      step: '3',
      element_name: 'LOAN',
    });
  });

  it('rejects a row missing Employee_Number', () => {
    assertFailure(AGENCY_ROW_MAPPERS.LASG({ ...baseRow, employee_number: '' }));
  });

  it('rejects a row missing or unparseable Result_Value SUM', () => {
    assertFailure(AGENCY_ROW_MAPPERS.LASG({ ...baseRow, 'result_value sum': 'bad' }));
  });
});

describe('isRepaymentRowMappingFailure', () => {
  it('narrows correctly', () => {
    expect(isRepaymentRowMappingFailure(AGENCY_ROW_MAPPERS.NSCDC({}))).toBe(true);
    expect(isRepaymentRowMappingFailure(AGENCY_ROW_MAPPERS.NSCDC({ 'ippis no': 'X', amount: 1 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/repayment-row-mapper.spec.ts`
Expected: FAIL — `Cannot find module './repayment-row-mapper'`

- [ ] **Step 3: Implement the mappers**

`src/document-ingestion/parsers/repayment-row-mapper.ts`:

```typescript
export type AgencyKey = 'NPF' | 'NSCDC' | 'IMMIGRATION' | 'CORRECTIONAL' | 'CUSTOM' | 'LASG';

export interface MappedRepaymentFields {
  staffId: string;
  elementName: string;
  elementDetail: string | null;
  amount: number;
  period: string | null;
  rawFields: Record<string, unknown>;
}

export interface RepaymentRowMappingSuccess {
  ok: true;
  record: MappedRepaymentFields;
  warnings: string[];
}

export interface RepaymentRowMappingFailure {
  ok: false;
  reason: string;
}

export type RepaymentRowMappingResult = RepaymentRowMappingSuccess | RepaymentRowMappingFailure;

export function isRepaymentRowMappingFailure(result: RepaymentRowMappingResult): result is RepaymentRowMappingFailure {
  return result.ok === false;
}

const MONTH_NAME_TO_NUMBER: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function normalizePeriod(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();

  const monthNameMatch = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthNameMatch) {
    const monthNum = MONTH_NAME_TO_NUMBER[monthNameMatch[1].toLowerCase()];
    if (monthNum) return `${monthNameMatch[2]}-${monthNum}`;
  }

  const compactMatch = str.match(/^(\d{4})(\d{2})$/);
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}`;

  if (/^\d{4}-\d{2}$/.test(str)) return str;

  return null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function stringifyIdLikeValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(Math.trunc(value));
  return String(value).trim() || null;
}

function parseAmountCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function collectRawFields(rowByHeader: Record<string, unknown>, knownHeaders: Set<string>): Record<string, unknown> {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (knownHeaders.has(header)) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }
  return rawFields;
}

const NPF_KNOWN_HEADERS = new Set(['staff id', 'amount', 'element', 'period']);

function mapNpfRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['staff id']);
  if (!staffId) return { ok: false, reason: 'missing Staff ID' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  const elementName = stringOrNull(rowByHeader['element']);
  if (!elementName) return { ok: false, reason: 'missing Element' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName,
      elementDetail: null,
      amount,
      period: normalizePeriod(rowByHeader['period']),
      rawFields: collectRawFields(rowByHeader, NPF_KNOWN_HEADERS),
    },
  };
}

const NSCDC_KNOWN_HEADERS = new Set(['ippis no', 'amount']);

function mapNscdcRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis no']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NO' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, NSCDC_KNOWN_HEADERS),
    },
  };
}

const IMMIGRATION_KNOWN_HEADERS = new Set(['ippis number', 'cit microfinance']);

function mapImmigrationRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis number']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NUMBER' };

  const amount = parseAmountCell(rowByHeader['cit microfinance']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable CIT MICROFINANCE amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, IMMIGRATION_KNOWN_HEADERS),
    },
  };
}

const CORRECTIONAL_KNOWN_HEADERS = new Set(['ippis number', 'amount']);

function mapCorrectionalRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis number']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NUMBER' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, CORRECTIONAL_KNOWN_HEADERS),
    },
  };
}

const CUSTOM_KNOWN_HEADERS = new Set(['period', 'staff number', 'loan type', 'deduction']);

function mapCustomRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['staff number']);
  if (!staffId) return { ok: false, reason: 'missing Staff Number' };

  const amount = parseAmountCell(rowByHeader['deduction']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Deduction' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: stringOrNull(rowByHeader['loan type']),
      amount,
      period: normalizePeriod(rowByHeader['period']),
      rawFields: collectRawFields(rowByHeader, CUSTOM_KNOWN_HEADERS),
    },
  };
}

const LASG_KNOWN_HEADERS = new Set(['employee_number', 'result_value sum']);

function mapLasgRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['employee_number']);
  if (!staffId) return { ok: false, reason: 'missing Employee_Number' };

  const amount = parseAmountCell(rowByHeader['result_value sum']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Result_Value SUM' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, LASG_KNOWN_HEADERS),
    },
  };
}

export const AGENCY_ROW_MAPPERS: Record<AgencyKey, (rowByHeader: Record<string, unknown>) => RepaymentRowMappingResult> = {
  NPF: mapNpfRow,
  NSCDC: mapNscdcRow,
  IMMIGRATION: mapImmigrationRow,
  CORRECTIONAL: mapCorrectionalRow,
  CUSTOM: mapCustomRow,
  LASG: mapLasgRow,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/repayment-row-mapper.spec.ts`
Expected: PASS — 24 tests (4 `normalizePeriod` + 4 NPF + 3 NSCDC + 3 IMMIGRATION + 3 CORRECTIONAL + 3 CUSTOM + 3 LASG + 1 `isRepaymentRowMappingFailure`).

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/parsers/repayment-row-mapper.ts src/document-ingestion/parsers/repayment-row-mapper.spec.ts
git commit -m "feat: add per-agency repayment-schedule row-mapping functions"
```

---

### Task 3: `RepaymentScheduleParser` orchestration

**Files:**
- Create: `src/document-ingestion/parsers/repayment-schedule.parser.ts`
- Test: `src/document-ingestion/parsers/repayment-schedule.parser.spec.ts`

**Interfaces:**
- Consumes: `AGENCY_ROW_MAPPERS`/`isRepaymentRowMappingFailure` (Task 2), `buildRowByHeader` (`src/document-ingestion/parsers/build-row-by-header.ts`, already extracted), `PrismaService` (`this.prisma.loanRepaymentRecord.findMany`/`.upsert`), `SnapshotExportService.exportSnapshot`, the `DocumentParser` interface.
- Produces: `RepaymentScheduleParser implements DocumentParser` — Task 4 registers this class in `DOCUMENT_PARSERS`.

- [ ] **Step 1: Write the failing tests**

`src/document-ingestion/parsers/repayment-schedule.parser.spec.ts`:

```typescript
import * as ExcelJS from 'exceljs';
import { RepaymentScheduleParser } from './repayment-schedule.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

async function buildWorkbook(builder: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  builder(workbook);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

function batchWithPeriod(period: string | null): DocumentUploadBatch {
  return { period } as DocumentUploadBatch;
}

describe('RepaymentScheduleParser', () => {
  let parser: RepaymentScheduleParser;
  let prisma: { loanRepaymentRecord: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = {
      loanRepaymentRecord: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new RepaymentScheduleParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  it('parses an NPF row using its own period, ignoring the upload period when they match', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NPF');
      sheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
      sheet.addRow(['NPF/1', 5000, 'PERSONAL LOAN', 'SEPTEMBER 2024']);
    });

    const result = await parser.parse(batchWithPeriod('2024-09'), buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agency_staffId_period_elementName: { agency: 'NPF', staffId: 'NPF/1', period: '2024-09', elementName: 'PERSONAL LOAN' } },
      }),
    );
  });

  it('warns but still ingests under the row\'s own period when it does not match the upload period', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NPF');
      sheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
      sheet.addRow(['NPF/1', 5000, 'PERSONAL LOAN', 'SEPTEMBER 2024']);
    });

    const result = await parser.parse(batchWithPeriod('2024-10'), buffer);

    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('does not match'))).toBe(true);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agency_staffId_period_elementName: expect.objectContaining({ period: '2024-09' }) }),
      }),
    );
  });

  it('falls back to the upload period for a sheet with no period column', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['TEST STAFF', 'CD1', 3000]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsCreated).toBe(1);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agency_staffId_period_elementName: expect.objectContaining({ period: '2024-11' }) }),
      }),
    );
  });

  it('locates the LASG header row at row 3 (after a 2-row title block)', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('LASG');
      sheet.addRow(['SOME TITLE TEXT']);
      sheet.addRow([]);
      sheet.addRow(['Employee_Number', 'Employee_Name', 'Result_Value SUM']);
      sheet.addRow(['LASG-1', 'TEST STAFF', 2500]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('skips an unrecognized sheet with a warning and does not fail the batch', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('SomeOtherAgency');
      sheet.addRow(['Staff ID', 'Amount']);
      sheet.addRow(['X/1', 100]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(0);
    expect(result.warnings.some((w) => w.includes('SomeOtherAgency'))).toBe(true);
  });

  it('skips an invalid row but still processes the rest of the sheet', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['BAD ROW', '', 100]);
      sheet.addRow(['GOOD ROW', 'CD2', 200]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('counts an existing natural key as an update, not a create', async () => {
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NSCDC', staffId: 'CD1', period: '2024-11', elementName: 'LOAN_REPAYMENT' },
    ]);
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['TEST STAFF', 'CD1', 3000]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('recovers from a per-row exception without failing the rest of the sheet', async () => {
    prisma.loanRepaymentRecord.upsert
      .mockRejectedValueOnce(new Error('simulated DB error'))
      .mockResolvedValue({});
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['FIRST', 'CD1', 100]);
      sheet.addRow(['SECOND', 'CD2', 200]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('simulated DB error'))).toBe(true);
  });

  it('calls exportSnapshot with the current LoanRepaymentRecord table before upserting', async () => {
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { id: 'r1', agency: 'NPF', staffId: 'NPF/1', rawFields: { check: 'OK' } },
    ]);
    const buffer = await buildWorkbook((wb) => {
      wb.addWorksheet('NPF');
    });

    await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'REPAYMENT_SCHEDULE',
        tableName: 'LoanRepaymentRecord',
        rows: [expect.objectContaining({ id: 'r1', rawFields: JSON.stringify({ check: 'OK' }) })],
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/repayment-schedule.parser.spec.ts`
Expected: FAIL — `Cannot find module './repayment-schedule.parser'`

- [ ] **Step 3: Implement `RepaymentScheduleParser`**

`src/document-ingestion/parsers/repayment-schedule.parser.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { AGENCY_ROW_MAPPERS, AgencyKey, isRepaymentRowMappingFailure } from './repayment-row-mapper';
import { buildRowByHeader } from './build-row-by-header';

const KNOWN_AGENCIES: AgencyKey[] = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'];
const LASG_HEADER_SCAN_LIMIT = 5;

const SNAPSHOT_COLUMNS = [
  'id', 'agency', 'staffId', 'period', 'elementName', 'elementDetail', 'amount', 'rawFields', 'createdAt',
];

function findAgencyHeaderRowNumber(worksheet: ExcelJS.Worksheet, agency: AgencyKey): number | null {
  if (agency !== 'LASG') {
    return 1;
  }
  const maxScan = Math.min(worksheet.rowCount, LASG_HEADER_SCAN_LIMIT);
  for (let rowNumber = 1; rowNumber <= maxScan; rowNumber++) {
    const values = (worksheet.getRow(rowNumber).values as unknown[]) ?? [];
    const normalized = values.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : null));
    if (normalized.includes('employee_number') && normalized.includes('employee_name')) {
      return rowNumber;
    }
  }
  return null;
}

@Injectable()
export class RepaymentScheduleParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled typings expect an older, non-generic Node `Buffer`
    // shape than this project's @types/node ships, hence `any` here.
    await workbook.xlsx.load(fileBuffer as any);

    const currentRecords = await this.prisma.loanRepaymentRecord.findMany();
    const existingKeys = new Set(
      currentRecords.map((r) => `${r.agency}::${r.staffId}::${r.period}::${r.elementName}`),
    );

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.REPAYMENT_SCHEDULE,
      tableName: 'LoanRepaymentRecord',
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

      const headerRowNumber = findAgencyHeaderRowNumber(worksheet, agency);
      if (headerRowNumber === null) {
        warnings.push(`Could not locate a header row for sheet "${worksheet.name}"`);
        continue;
      }

      const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];
      const mapper = AGENCY_ROW_MAPPERS[agency];

      for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        rowsProcessed++;

        try {
          const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
          const mapped = mapper(rowByHeader);

          if (isRepaymentRowMappingFailure(mapped)) {
            rowsSkipped++;
            warnings.push(`Sheet "${agency}" row ${rowNumber}: ${mapped.reason}`);
            continue;
          }

          let period = mapped.record.period;
          if (period === null) {
            period = batch.period;
          } else if (batch.period && period !== batch.period) {
            warnings.push(
              `Sheet "${agency}" row ${rowNumber}: row period "${period}" does not match upload period "${batch.period}"`,
            );
          }

          const key = `${agency}::${mapped.record.staffId}::${period}::${mapped.record.elementName}`;
          const isUpdate = existingKeys.has(key);

          await this.prisma.loanRepaymentRecord.upsert({
            where: {
              agency_staffId_period_elementName: {
                agency,
                staffId: mapped.record.staffId,
                period,
                elementName: mapped.record.elementName,
              },
            },
            create: {
              agency,
              staffId: mapped.record.staffId,
              period,
              elementName: mapped.record.elementName,
              elementDetail: mapped.record.elementDetail,
              amount: mapped.record.amount,
              rawFields: mapped.record.rawFields as Prisma.InputJsonValue,
            },
            update: {
              elementDetail: mapped.record.elementDetail,
              amount: mapped.record.amount,
              rawFields: mapped.record.rawFields as Prisma.InputJsonValue,
            },
          });

          if (isUpdate) {
            rowsUpdated++;
          } else {
            rowsCreated++;
          }
        } catch (error) {
          rowsSkipped++;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Sheet "${agency}" row ${rowNumber}: unexpected error - ${message}`);
        }
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/repayment-schedule.parser.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/document-ingestion/parsers/repayment-schedule.parser.ts src/document-ingestion/parsers/repayment-schedule.parser.spec.ts
git commit -m "feat: add RepaymentScheduleParser orchestration"
```

---

### Task 4: Wire into the registry, fix the now-doubly-stale generic upload test, e2e test, README, and Postman

**Files:**
- Modify: `src/document-ingestion/document-ingestion.module.ts`
- Modify: `test/document-upload.e2e-spec.ts`
- Test: `test/repayment-schedule-ingestion.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `RepaymentScheduleParser` (Task 3), existing `DOCUMENT_PARSERS` token and `DocumentIngestionModule` (unchanged shape).
- Produces: nothing new for later tasks — this is the final task in this plan, and the final task in the three-parser document-ingestion sequence (only Reconciliation remains, in a separate future plan).

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
import { DisbursedLoansParser } from './parsers/disbursed-loans.parser';
import { RepaymentScheduleParser } from './parsers/repayment-schedule.parser';
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
    DisbursedLoansParser,
    RepaymentScheduleParser,
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (
        noOpParser: NoOpDocumentParser,
        ippisParser: IppisBroadsheetParser,
        loansParser: DisbursedLoansParser,
        repaymentParser: RepaymentScheduleParser,
      ) => ({
        [DocumentType.IPPIS_BROADSHEET]: ippisParser,
        [DocumentType.REPAYMENT_SCHEDULE]: repaymentParser,
        [DocumentType.DISBURSED_LOANS]: loansParser,
      }),
      inject: [NoOpDocumentParser, IppisBroadsheetParser, DisbursedLoansParser, RepaymentScheduleParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
```

`NoOpDocumentParser` is no longer referenced by any entry in the map, but stays registered and imported — it's still constructed for `inject` (harmless), and removing it now would be pure churn for a class that may be useful again if a 4th document type is ever added. (If this bothers a future reviewer, deleting `NoOpDocumentParser`/`no-op-document.parser.spec.ts` entirely is a reasonable follow-up, but is out of scope here.)

- [ ] **Step 2: Fix `document-upload.e2e-spec.ts`'s now-doubly-stale test**

With `REPAYMENT_SCHEDULE` no longer backed by the no-op parser, the test added in the Disbursed Loans plan (`'uploads a repayment-schedule file, processes it via the no-op parser, and completes'`, which uploads `Buffer.from('fake-xlsx-content')`) will now fail — real parsing of garbage bytes correctly fails, just like it did for the previous two document types. This time there is no remaining no-op-backed document type to redirect to, since all three are now real parsers. Fix it by uploading a **real, valid, but content-free** workbook instead of garbage bytes — one with a single unrecognized-agency sheet, which every parser (including this one) handles by skipping with a warning rather than throwing, giving a genuinely `COMPLETED` batch with `rowsProcessed: 0`.

Replace that test in `test/document-upload.e2e-spec.ts`:

```typescript
  it('uploads a repayment-schedule file with no recognizable sheets, and still completes with zero rows processed', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('NotARealAgency');
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    const res = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-11')
      .attach('file', buffer, 'repayments.xlsx')
      .expect(201);

    expect(res.body.documentType).toBe('REPAYMENT_SCHEDULE');
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(0);
  });
```

Add `import * as ExcelJS from 'exceljs';` to the top of `test/document-upload.e2e-spec.ts` alongside its existing imports.

The `'accepts a repayment-schedule upload with a valid period and records it on the batch'` test further down in this same file has the identical problem — it also attaches `Buffer.from('fake', ...)` to the repayment-schedule endpoint and expects `COMPLETED`. Apply the same fix: replace its `.attach('file', Buffer.from('fake'), 'repayments.xlsx')` call with the same unrecognized-sheet-workbook approach:

```typescript
  it('accepts a repayment-schedule upload with a valid period and records it on the batch', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('NotARealAgency');
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    const res = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-12')
      .attach('file', buffer, 'repayments.xlsx')
      .expect(201);
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.period).toBe('2024-12');
  });
```

- [ ] **Step 3: Run `document-upload.e2e-spec.ts` to verify both fixed tests pass**

Run: `npx jest --config ./test/jest-e2e.json test/document-upload.e2e-spec.ts --runInBand`
Expected: PASS — all 5 tests.

- [ ] **Step 4: Write the e2e test**

`test/repayment-schedule-ingestion.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function buildRepaymentScheduleBuffer(staffId: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const npfSheet = workbook.addWorksheet('NPF');
  npfSheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
  npfSheet.addRow([staffId, 5000, 'PERSONAL LOAN', 'NOVEMBER 2024']);

  const nscdcSheet = workbook.addWorksheet('NSCDC');
  nscdcSheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
  nscdcSheet.addRow(['E2E NSCDC Staff', `${staffId}-NSCDC`, 3000]);

  return workbook.xlsx.writeBuffer() as unknown as Buffer;
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

describe('Repayment schedule ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const staffId = `E2E-STAFF-${Date.now()}`;

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
      await prisma.loanRepaymentRecord.deleteMany({ where: { staffId: { in: [staffId, `${staffId}-NSCDC`] } } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded repayment schedule into LoanRepaymentRecord rows across two agency sheets', async () => {
    const buffer = await buildRepaymentScheduleBuffer(staffId);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-11')
      .attach('file', buffer, 'repayments.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(2);
    expect(batch!.rowsCreated).toBe(2);
    expect(batch!.snapshotExportId).not.toBeNull();

    const npfRecord = await prisma.loanRepaymentRecord.findUnique({
      where: {
        agency_staffId_period_elementName: {
          agency: 'NPF',
          staffId,
          period: '2024-11',
          elementName: 'PERSONAL LOAN',
        },
      },
    });
    expect(npfRecord).not.toBeNull();
    expect(Number(npfRecord!.amount)).toBe(5000);

    const nscdcRecord = await prisma.loanRepaymentRecord.findUnique({
      where: {
        agency_staffId_period_elementName: {
          agency: 'NSCDC',
          staffId: `${staffId}-NSCDC`,
          period: '2024-11',
          elementName: 'LOAN_REPAYMENT',
        },
      },
    });
    expect(nscdcRecord).not.toBeNull();
    expect(Number(nscdcRecord!.amount)).toBe(3000);
  });
});
```

- [ ] **Step 5: Run the new e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/repayment-schedule-ingestion.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 6: Update the README**

In `README.md`'s "Document ingestion" section, replace the sentence about which document types are parsed with:

```markdown
**All three document types are now fully parsed**: IPPIS Broadsheet into
`IppisRecord` (by `agency`+`staffId`), Disbursed Loans into `Loan` (by
`customerId`), and Repayment Schedule into `LoanRepaymentRecord` (by
`agency`+`staffId`+`period`+`elementName`, one small hardcoded mapper per
agency sheet since those six sheets share almost no column names) — see
`src/document-ingestion/parsers/`. Reconciliation (comparing expected vs.
actual repayments) is not built yet.
```

- [ ] **Step 7: Update the stale Postman description**

In `postman/public-sector-backend.postman_collection.json`, find the request named `"POST /admin/documents/repayment-schedule/upload - Success"` under **IPPIS > Documents**. Set (or add) its `request.description` to:

```
Attach an .xlsx file with one sheet per agency (NPF/NSCDC/IMMIGRATION/CORRECTIONAL/CUSTOM/LASG) — column layouts differ per agency; see src/document-ingestion/parsers/repayment-row-mapper.ts for each sheet's expected headers. Rows are upserted into LoanRepaymentRecord by (agency, staffId, period, elementName). Do NOT attach the real sample files under docs/added/ to a shared workspace — those contain real BVNs/bank data and are gitignored for that reason.
```

- [ ] **Step 8: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`
Expected: `VALID`

- [ ] **Step 9: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the new/modified ones from this plan.

- [ ] **Step 10: Commit**

```bash
git add src/document-ingestion/document-ingestion.module.ts test/document-upload.e2e-spec.ts test/repayment-schedule-ingestion.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: wire RepaymentScheduleParser into the document-ingestion pipeline"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] Uploading a real-shaped Repayment Schedule workbook covering at least NPF (own period) and NSCDC (no period) produces the expected `LoanRepaymentRecord` rows and a `DataSnapshotExport` — proven by `test/repayment-schedule-ingestion.e2e-spec.ts`.
- [ ] Each of the 6 agency mappers correctly extracts its staff identifier and amount from its own real column names, including IMMIGRATION/CORRECTIONAL preferring "IPPIS NUMBER" over "StaffID" — proven by `repayment-row-mapper.spec.ts`.
- [ ] `normalizePeriod` correctly converts both `"SEPTEMBER 2024"` and `"202512"` style values to `YYYY-MM` — proven by `repayment-row-mapper.spec.ts`.
- [ ] A row's own period that disagrees with the upload's stated period produces a warning but is still ingested under its own period — proven by `repayment-schedule.parser.spec.ts`.
- [ ] LASG's header row is correctly located at row 3, not row 1 — proven by `repayment-schedule.parser.spec.ts`.
- [ ] A single row-level exception (e.g. a DB error mid-upsert) doesn't take down the rest of that sheet — proven by `repayment-schedule.parser.spec.ts`.
- [ ] All three document types now have real parsers; `document-upload.e2e-spec.ts`'s generic plumbing tests no longer depend on any no-op-parser behavior.
