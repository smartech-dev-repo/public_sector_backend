# Disbursed Loans Ingestion Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `NoOpDocumentParser` behind `POST /admin/documents/disbursed-loans/upload` with a real parser that turns an uploaded Disbursed Loans Report workbook into `Loan` rows.

**Architecture:** A new `Loan` Prisma model (doesn't exist yet). A pure row-mapping function (`mapLoanRow`), directly mirroring `mapIppisRow`'s shape and conventions from the IPPIS Broadsheet parser. An orchestration class (`DisbursedLoansParser implements DocumentParser`) that, unlike the IPPIS parser, first has to **locate** the real header row within a report-header block that precedes it, then derives `agency` per-row from the `IPPIS` column's prefix (rather than from a sheet name, since this report is single-sheet). The `buildRowByHeader` helper duplicated between what would otherwise be two near-identical parsers is extracted to a shared module as part of this work. Wired into the existing `DOCUMENT_PARSERS` registry in place of the no-op parser — no changes to `DocumentIngestionProcessor`, the controller, or the HTTP contract.

**Tech Stack:** NestJS 10, Prisma 7, `exceljs@^4.4.0` (already a dependency), Jest.

**Spec:** `docs/superpowers/specs/2026-09-16-disbursed-loans-ingestion-design.md`

## Global Constraints

- Every route already exists and is unchanged by this plan — no new endpoints, DTOs, or permissions.
- `Loan` upsert key: `customerId`, full overwrite on conflict (spec §4).
- Header row location: scan the first 20 rows for the one containing both "Customer ID" and "IPPIS" (case-insensitive); no match → the whole batch fails immediately, not a per-row skip (spec §4, §7).
- Required fields (missing/unparseable → row skipped, warning recorded, batch continues): `customerId`, `customerName`, `accountNumber`, `product`, `ippisNumber`, `loanAmount`, `principalBalance`, `interestRatePercent`, `disbursementDate`, `maturationDate` (spec §4).
- Dates in this file are strings in `DD-Mon-YYYY` format (e.g. `01-Aug-2024`) — unlike the IPPIS Broadsheet's native Excel dates (spec §2).
- `agency` is derived from the `IPPIS` column's prefix (`PF`→NPF, `CD`→NSCDC, `NI`→IMMIGRATION, `PR`→CORRECTIONAL, `NCS`→CUSTOM); unrecognized prefix → `agency: null` + warning, row still ingested (spec §4).
- `Group Name`, `Ministries, Departments and Agencies`, restructured dates, `Prin./Int. Repay.`, `Linked Account Name`, `Guarantor 1`/`Guarantor 2`, `Security Deposit` go into `Loan.rawFields`, not first-class columns (spec §2–3).
- Never read from or reference `docs/added/` in committed code or test fixtures — it's gitignored real PII (this repo's `CLAUDE.md`), and per this session's standing instruction, never read real data rows from it at all — structure/headers only, and only when already established as needed.
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as any behavior change visible through an existing request — Task 4 updates the stale `POST /admin/documents/disbursed-loans/upload - Success` description.

---

### Task 1: Add the `Loan` Prisma model

**Files:**
- Modify: `prisma/schema.prisma` (append after the `IppisRecord` model, currently the last model)

**Interfaces:**
- Produces: the `Loan` Prisma model and generated TypeScript type (`import { Loan } from '../generated/prisma/client'`), with fields exactly as listed below — Task 2 and Task 3 both depend on these exact field names.

- [ ] **Step 1: Append the model**

Add to the end of `prisma/schema.prisma`:

```prisma
model Loan {
  id                     String    @id @default(uuid())
  customerId             String    @unique
  customerName           String
  accountNumber          String
  address                String?
  branch                 String?
  gender                 String?
  phone                  String?
  ippisNumber            String
  agency                 String?
  loanAmount             Decimal
  principalBalance       Decimal
  disbursementDate       DateTime
  maturationDate         DateTime
  effectiveDate          DateTime?
  moratoriumDays         Int?
  product                String
  linkedAccountNumber    String?
  bvn                    String?
  interestRatePercent    Decimal
  accountOfficer         String?
  hasPreviouslyTakenLoan Boolean   @default(false)
  rawFields              Json?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  @@index([ippisNumber])
}
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_loan`
Expected: creates `prisma/migrations/<timestamp>_add_loan/migration.sql`, applies it to the real database.

- [ ] **Step 3: Explicitly regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`. (`migrate dev` regenerates the client too, but confirming with a standalone `generate` catches the case where that step silently didn't happen — this exact gap bit the IPPIS Broadsheet plan's Task 1.)

- [ ] **Step 4: Verify the client regenerated correctly**

Run: `grep -n "IppisRecordModel\|LoanModel" src/generated/prisma/client.ts`
Expected: both `export type IppisRecord = Prisma.IppisRecordModel` and `export type Loan = Prisma.LoanModel` lines appear. If `Loan` is missing, `npx prisma generate` did not run successfully — re-run Step 3 before continuing.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Loan model for disbursed loans ingestion"
```

---

### Task 2: `mapLoanRow` — pure row-mapping function

**Files:**
- Create: `src/document-ingestion/parsers/loan-row-mapper.ts`
- Test: `src/document-ingestion/parsers/loan-row-mapper.spec.ts`

**Interfaces:**
- Consumes: nothing (pure function, no DI, no I/O).
- Produces: `mapLoanRow(rowByHeader: Record<string, unknown>): LoanRowMappingResult`, `isLoanRowMappingFailure(result): result is LoanRowMappingFailure`, where:
  ```typescript
  export interface MappedLoanFields {
    customerId: string;
    customerName: string;
    accountNumber: string;
    address: string | null;
    branch: string | null;
    gender: string | null;
    phone: string | null;
    ippisNumber: string;
    agency: string | null;
    loanAmount: number;
    principalBalance: number;
    disbursementDate: Date;
    maturationDate: Date;
    effectiveDate: Date | null;
    moratoriumDays: number | null;
    product: string;
    linkedAccountNumber: string | null;
    bvn: string | null;
    interestRatePercent: number;
    accountOfficer: string | null;
    hasPreviouslyTakenLoan: boolean;
    rawFields: Record<string, unknown>;
  }
  export interface LoanRowMappingSuccess {
    ok: true;
    record: MappedLoanFields;
    warnings: string[];
  }
  export interface LoanRowMappingFailure {
    ok: false;
    reason: string;
  }
  export type LoanRowMappingResult = LoanRowMappingSuccess | LoanRowMappingFailure;
  ```
  `rowByHeader` keys are lowercase, trimmed header names exactly as they appear in the real file (e.g. `'customer id'`, `'account no.'`, `'moratarium (day)'` — note the source file's own spelling, not "moratorium") — Task 3's `buildRowByHeader` (extracted in that task) produces this shape.

- [ ] **Step 1: Write the failing tests**

`src/document-ingestion/parsers/loan-row-mapper.spec.ts`:

```typescript
import {
  isLoanRowMappingFailure,
  LoanRowMappingFailure,
  LoanRowMappingResult,
  LoanRowMappingSuccess,
  mapLoanRow,
} from './loan-row-mapper';

function assertSuccess(result: LoanRowMappingResult): asserts result is LoanRowMappingSuccess {
  if (!result.ok) throw new Error(`expected success but got failure: ${(result as LoanRowMappingFailure).reason}`);
}

function assertFailure(result: LoanRowMappingResult): asserts result is LoanRowMappingFailure {
  if (result.ok) throw new Error('expected failure but got success');
}

describe('mapLoanRow', () => {
  const baseRow = {
    'customer id': '025069',
    'customer name': 'TEST CUSTOMER',
    'account no.': '01290013294025069',
    address: 'TEST ADDRESS',
    branch: 'Head Office',
    gender: 'Male',
    'phone no.': '08000000000',
    'loan amount': 500000,
    'principal bal.': 0,
    'disbursement date': '08-Aug-2024',
    'maturation date': '30-May-2026',
    'effective date': '07-Oct-2024',
    'moratarium (day)': '60',
    product: 'NIGERIAN CIVIL DEFENCE - PERSONAL LOAN',
    'linked account number': '01290011240025069',
    bvn: '22209498402',
    'interest rate': 42,
    'account officer': 'TEST OFFICER',
    'has previously taken loan': 1,
    ippis: 'CD7038686',
  };

  it('maps a full row into MappedLoanFields', () => {
    const result = mapLoanRow(baseRow);
    assertSuccess(result);
    expect(result.record.customerId).toBe('025069');
    expect(result.record.customerName).toBe('TEST CUSTOMER');
    expect(result.record.loanAmount).toBe(500000);
    expect(result.record.disbursementDate).toEqual(new Date(Date.UTC(2024, 7, 8)));
    expect(result.record.maturationDate).toEqual(new Date(Date.UTC(2026, 4, 30)));
    expect(result.record.moratoriumDays).toBe(60);
    expect(result.record.hasPreviouslyTakenLoan).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('derives agency from the IPPIS prefix', () => {
    expect(mapLoanRow({ ...baseRow, ippis: 'CD7038686' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'NSCDC' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'PF0305850' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'NPF' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'NI1234567' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'IMMIGRATION' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'PR1234567' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'CORRECTIONAL' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'NCS123456' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'CUSTOM' }) }),
    );
  });

  it('sets agency to null with a warning for an unrecognized IPPIS prefix, without rejecting the row', () => {
    const result = mapLoanRow({ ...baseRow, ippis: 'ZZ9999999' });
    assertSuccess(result);
    expect(result.record.agency).toBeNull();
    expect(result.warnings[0]).toMatch(/unrecognized IPPIS prefix/);
  });

  it('captures unknown headers into rawFields', () => {
    const result = mapLoanRow({
      ...baseRow,
      'group name': 'TEST GROUP',
      'ministries, departments and agencies': 'NSCDC',
      'restructured disbursement date': '',
      'guarantor 1': 'TEST GUARANTOR',
    });
    assertSuccess(result);
    expect(result.record.rawFields).toEqual({
      'group name': 'TEST GROUP',
      'ministries, departments and agencies': 'NSCDC',
      'guarantor 1': 'TEST GUARANTOR',
    });
  });

  it.each([
    ['customer id', 'customerId'],
    ['customer name', 'customerName'],
    ['account no.', 'accountNumber'],
    ['product', 'product'],
    ['ippis', 'ippisNumber'],
  ])('rejects a row missing %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: '' });
    assertFailure(result);
  });

  it.each([
    ['loan amount', 'loanAmount'],
    ['principal bal.', 'principalBalance'],
    ['interest rate', 'interestRatePercent'],
  ])('rejects a row with a missing or unparseable %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: 'not-a-number' });
    assertFailure(result);
  });

  it.each([
    ['disbursement date', 'disbursementDate'],
    ['maturation date', 'maturationDate'],
  ])('rejects a row with a missing or unparseable %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: 'not-a-date' });
    assertFailure(result);
  });

  it('records a warning and nulls the field for an unparseable non-required date, without rejecting the row', () => {
    const result = mapLoanRow({ ...baseRow, 'effective date': 'not-a-date' });
    assertSuccess(result);
    expect(result.record.effectiveDate).toBeNull();
    expect(result.warnings.some((w) => w.includes('effective date'))).toBe(true);
  });

  it('parses "0"/missing has-previously-taken-loan as false', () => {
    const zero = mapLoanRow({ ...baseRow, 'has previously taken loan': 0 });
    assertSuccess(zero);
    expect(zero.record.hasPreviouslyTakenLoan).toBe(false);

    const { 'has previously taken loan': _omit, ...rowWithoutFlag } = baseRow;
    const missing = mapLoanRow(rowWithoutFlag);
    assertSuccess(missing);
    expect(missing.record.hasPreviouslyTakenLoan).toBe(false);
  });

  it('isLoanRowMappingFailure narrows correctly', () => {
    const failure = mapLoanRow({ ...baseRow, 'customer id': '' });
    expect(isLoanRowMappingFailure(failure)).toBe(true);
    const success = mapLoanRow(baseRow);
    expect(isLoanRowMappingFailure(success)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/loan-row-mapper.spec.ts`
Expected: FAIL — `Cannot find module './loan-row-mapper'`

- [ ] **Step 3: Implement `mapLoanRow`**

`src/document-ingestion/parsers/loan-row-mapper.ts`:

```typescript
const LOAN_KNOWN_HEADERS: Record<string, keyof Omit<MappedLoanFields, 'rawFields' | 'agency'>> = {
  'customer id': 'customerId',
  'customer name': 'customerName',
  'account no.': 'accountNumber',
  address: 'address',
  branch: 'branch',
  gender: 'gender',
  'phone no.': 'phone',
  ippis: 'ippisNumber',
  'loan amount': 'loanAmount',
  'principal bal.': 'principalBalance',
  'disbursement date': 'disbursementDate',
  'maturation date': 'maturationDate',
  'effective date': 'effectiveDate',
  'moratarium (day)': 'moratoriumDays',
  product: 'product',
  'linked account number': 'linkedAccountNumber',
  bvn: 'bvn',
  'interest rate': 'interestRatePercent',
  'account officer': 'accountOfficer',
  'has previously taken loan': 'hasPreviouslyTakenLoan',
};

const AGENCY_PREFIXES: Record<string, string> = {
  PF: 'NPF',
  CD: 'NSCDC',
  NI: 'IMMIGRATION',
  PR: 'CORRECTIONAL',
  NCS: 'CUSTOM',
};

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export interface MappedLoanFields {
  customerId: string;
  customerName: string;
  accountNumber: string;
  address: string | null;
  branch: string | null;
  gender: string | null;
  phone: string | null;
  ippisNumber: string;
  agency: string | null;
  loanAmount: number;
  principalBalance: number;
  disbursementDate: Date;
  maturationDate: Date;
  effectiveDate: Date | null;
  moratoriumDays: number | null;
  product: string;
  linkedAccountNumber: string | null;
  bvn: string | null;
  interestRatePercent: number;
  accountOfficer: string | null;
  hasPreviouslyTakenLoan: boolean;
  rawFields: Record<string, unknown>;
}

export interface LoanRowMappingSuccess {
  ok: true;
  record: MappedLoanFields;
  warnings: string[];
}

export interface LoanRowMappingFailure {
  ok: false;
  reason: string;
}

export type LoanRowMappingResult = LoanRowMappingSuccess | LoanRowMappingFailure;

export function isLoanRowMappingFailure(result: LoanRowMappingResult): result is LoanRowMappingFailure {
  return result.ok === false;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function requiredString(value: unknown): string | null {
  return stringOrNull(value);
}

function parseNumberCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseIntCell(value: unknown): number | null {
  const num = parseNumberCell(value);
  return num === null ? null : Math.trunc(num);
}

function parseBooleanFlag(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return value !== 0;
  const str = String(value).trim().toLowerCase();
  return str === '1' || str === 'true' || str === 'yes';
}

function parseLoanDateString(value: unknown): { date: Date | null; warning?: string } {
  if (value === null || value === undefined || value === '') return { date: null };
  if (value instanceof Date) return { date: value };
  const str = String(value).trim();
  const match = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = MONTH_ABBREVIATIONS[match[2].toLowerCase()];
    const year = parseInt(match[3], 10);
    if (month !== undefined) {
      const date = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(date.getTime())) return { date };
    }
  }
  const fallback = new Date(str);
  if (!Number.isNaN(fallback.getTime())) return { date: fallback };
  return { date: null, warning: `unparseable date value "${str}"` };
}

function deriveAgency(ippisNumber: string): { agency: string | null; warning?: string } {
  const upper = ippisNumber.toUpperCase();
  for (const prefix of Object.keys(AGENCY_PREFIXES)) {
    if (upper.startsWith(prefix)) {
      return { agency: AGENCY_PREFIXES[prefix] };
    }
  }
  return { agency: null, warning: `unrecognized IPPIS prefix in "${ippisNumber}"` };
}

export function mapLoanRow(rowByHeader: Record<string, unknown>): LoanRowMappingResult {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (LOAN_KNOWN_HEADERS[header]) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }

  const customerId = requiredString(rowByHeader['customer id']);
  if (!customerId) return { ok: false, reason: 'missing Customer ID' };

  const customerName = requiredString(rowByHeader['customer name']);
  if (!customerName) return { ok: false, reason: 'missing Customer Name' };

  const accountNumber = requiredString(rowByHeader['account no.']);
  if (!accountNumber) return { ok: false, reason: 'missing Account No.' };

  const product = requiredString(rowByHeader['product']);
  if (!product) return { ok: false, reason: 'missing Product' };

  const ippisNumber = requiredString(rowByHeader['ippis']);
  if (!ippisNumber) return { ok: false, reason: 'missing IPPIS number' };

  const loanAmount = parseNumberCell(rowByHeader['loan amount']);
  if (loanAmount === null) return { ok: false, reason: 'missing or unparseable Loan Amount' };

  const principalBalance = parseNumberCell(rowByHeader['principal bal.']);
  if (principalBalance === null) return { ok: false, reason: 'missing or unparseable Principal Bal.' };

  const interestRatePercent = parseNumberCell(rowByHeader['interest rate']);
  if (interestRatePercent === null) return { ok: false, reason: 'missing or unparseable Interest Rate' };

  const disbursementDateResult = parseLoanDateString(rowByHeader['disbursement date']);
  if (!disbursementDateResult.date) return { ok: false, reason: 'missing or unparseable Disbursement Date' };

  const maturationDateResult = parseLoanDateString(rowByHeader['maturation date']);
  if (!maturationDateResult.date) return { ok: false, reason: 'missing or unparseable Maturation Date' };

  const warnings: string[] = [];
  const effectiveDateResult = parseLoanDateString(rowByHeader['effective date']);
  if (effectiveDateResult.warning) warnings.push(`effective date: ${effectiveDateResult.warning}`);

  const agencyResult = deriveAgency(ippisNumber);
  if (agencyResult.warning) warnings.push(agencyResult.warning);

  return {
    ok: true,
    warnings,
    record: {
      customerId,
      customerName,
      accountNumber,
      address: stringOrNull(rowByHeader['address']),
      branch: stringOrNull(rowByHeader['branch']),
      gender: stringOrNull(rowByHeader['gender']),
      phone: stringOrNull(rowByHeader['phone no.']),
      ippisNumber,
      agency: agencyResult.agency,
      loanAmount,
      principalBalance,
      disbursementDate: disbursementDateResult.date,
      maturationDate: maturationDateResult.date,
      effectiveDate: effectiveDateResult.date,
      moratoriumDays: parseIntCell(rowByHeader['moratarium (day)']),
      product,
      linkedAccountNumber: stringOrNull(rowByHeader['linked account number']),
      bvn: stringOrNull(rowByHeader['bvn']),
      interestRatePercent,
      accountOfficer: stringOrNull(rowByHeader['account officer']),
      hasPreviouslyTakenLoan: parseBooleanFlag(rowByHeader['has previously taken loan']),
      rawFields,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/loan-row-mapper.spec.ts`
Expected: PASS — 17 tests (4 individual tests + 5 + 3 + 2 from the three `it.each` blocks + 3 more individual tests).

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/parsers/loan-row-mapper.ts src/document-ingestion/parsers/loan-row-mapper.spec.ts
git commit -m "feat: add pure disbursed-loans row-mapping function"
```

---

### Task 3: `DisbursedLoansParser` orchestration (+ shared `buildRowByHeader`)

**Files:**
- Create: `src/document-ingestion/parsers/build-row-by-header.ts`
- Modify: `src/document-ingestion/parsers/ippis-broadsheet.parser.ts` (use the extracted helper instead of its own copy)
- Create: `src/document-ingestion/parsers/disbursed-loans.parser.ts`
- Test: `src/document-ingestion/parsers/disbursed-loans.parser.spec.ts`

**Interfaces:**
- Consumes: `mapLoanRow`/`isLoanRowMappingFailure` (Task 2), `buildRowByHeader` (extracted here), `PrismaService` (`this.prisma.loan.findMany`/`.upsert`), `SnapshotExportService.exportSnapshot`, the `DocumentParser` interface.
- Produces: `DisbursedLoansParser implements DocumentParser` — Task 4 registers this class in `DOCUMENT_PARSERS`.

- [ ] **Step 1: Extract the shared header-mapping helper**

`src/document-ingestion/parsers/build-row-by-header.ts`:

```typescript
export function buildRowByHeader(headerValues: unknown[], rowValues: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  headerValues.forEach((header, index) => {
    if (typeof header !== 'string' || !header.trim()) return;
    result[header.trim().toLowerCase()] = rowValues[index];
  });
  return result;
}
```

- [ ] **Step 2: Update `IppisBroadsheetParser` to use the shared helper**

In `src/document-ingestion/parsers/ippis-broadsheet.parser.ts`:
- Remove the local `function buildRowByHeader(...)` definition (currently defined at the top of the file, right after the `SNAPSHOT_COLUMNS` constant).
- Add `import { buildRowByHeader } from './build-row-by-header';` alongside its other imports.
- Everything else in that file is unchanged — it already calls `buildRowByHeader(headerValues, row.values as unknown[])` with the same signature.

- [ ] **Step 3: Run the IPPIS parser's existing tests to confirm the refactor didn't break it**

Run: `npx jest src/document-ingestion/parsers/ippis-broadsheet.parser.spec.ts`
Expected: PASS — still 5 tests, unchanged behavior.

- [ ] **Step 4: Write the failing tests for `DisbursedLoansParser`**

`src/document-ingestion/parsers/disbursed-loans.parser.spec.ts`:

```typescript
import * as ExcelJS from 'exceljs';
import { DisbursedLoansParser } from './disbursed-loans.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

const REAL_HEADERS = [
  'Customer ID', 'Customer Name', 'Group Name', 'Account No.', 'Address', 'Branch', 'Gender',
  'Phone No.', 'Ministries, Departments and Agencies', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Effective Date', 'Moratarium (day)', 'Product',
  'Linked Account Number', 'BVN', 'Interest Rate', 'Account Officer',
  'Has Previously Taken Loan', 'IPPIS',
];

async function buildWorkbook(filterRowCount: number, dataRows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  for (let i = 0; i < filterRowCount; i++) {
    sheet.addRow([`Filter ${i}:`, 'All']);
  }
  sheet.addRow([]);
  sheet.addRow(REAL_HEADERS);
  dataRows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

function fullDataRow(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const base: Record<string, unknown> = {
    'Customer ID': 'CUST-1',
    'Customer Name': 'TEST CUSTOMER',
    'Group Name': '',
    'Account No.': 'ACC-1',
    Address: 'TEST ADDRESS',
    Branch: 'Head Office',
    Gender: 'Male',
    'Phone No.': '08000000000',
    'Ministries, Departments and Agencies': '',
    'Loan Amount': 500000,
    'Principal Bal.': 0,
    'Disbursement Date': '08-Aug-2024',
    'Maturation Date': '30-May-2026',
    'Effective Date': '07-Oct-2024',
    'Moratarium (day)': '60',
    Product: 'TEST PRODUCT',
    'Linked Account Number': 'LINKED-1',
    BVN: '22209498402',
    'Interest Rate': 42,
    'Account Officer': 'TEST OFFICER',
    'Has Previously Taken Loan': 1,
    IPPIS: 'CD7038686',
  };
  return REAL_HEADERS.map((header) => overrides[header] ?? base[header]);
}

describe('DisbursedLoansParser', () => {
  let parser: DisbursedLoansParser;
  let prisma: { loan: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = { loan: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) } };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new DisbursedLoansParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  it('locates the header row after a 7-row filter block (matching the real file) and upserts a new loan', async () => {
    const buffer = await buildWorkbook(7, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(prisma.loan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'CUST-1' },
        create: expect.objectContaining({ customerId: 'CUST-1', agency: 'NSCDC' }),
      }),
    );
  });

  it('locates the header row after a differently-sized filter block', async () => {
    const buffer = await buildWorkbook(2, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('fails the whole batch if no header row is found in the first 20 rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');
    for (let i = 0; i < 25; i++) sheet.addRow(['not a header row']);
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    await expect(parser.parse({} as DocumentUploadBatch, buffer)).rejects.toThrow(/header row/i);
  });

  it('counts an existing customerId as an update, not a create', async () => {
    prisma.loan.findMany.mockResolvedValue([{ customerId: 'CUST-1' }]);
    const buffer = await buildWorkbook(7, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('skips an invalid row (missing Customer ID) but still processes the rest', async () => {
    const buffer = await buildWorkbook(7, [
      fullDataRow({ 'Customer ID': '' }),
      fullDataRow({ 'Customer ID': 'CUST-2' }),
    ]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('calls exportSnapshot with the current Loan table before upserting', async () => {
    prisma.loan.findMany.mockResolvedValue([
      { id: 'l1', customerId: 'CUST-9', rawFields: { 'group name': 'X' } },
    ]);
    const buffer = await buildWorkbook(7, []);

    await parser.parse({} as DocumentUploadBatch, buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'DISBURSED_LOANS',
        tableName: 'Loan',
        rows: [expect.objectContaining({ id: 'l1', rawFields: JSON.stringify({ 'group name': 'X' }) })],
      }),
    );
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/parsers/disbursed-loans.parser.spec.ts`
Expected: FAIL — `Cannot find module './disbursed-loans.parser'`

- [ ] **Step 6: Implement `DisbursedLoansParser`**

`src/document-ingestion/parsers/disbursed-loans.parser.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { isLoanRowMappingFailure, mapLoanRow } from './loan-row-mapper';
import { buildRowByHeader } from './build-row-by-header';

const HEADER_SCAN_LIMIT = 20;

const SNAPSHOT_COLUMNS = [
  'id', 'customerId', 'customerName', 'accountNumber', 'address', 'branch', 'gender', 'phone',
  'ippisNumber', 'agency', 'loanAmount', 'principalBalance', 'disbursementDate', 'maturationDate',
  'effectiveDate', 'moratoriumDays', 'product', 'linkedAccountNumber', 'bvn', 'interestRatePercent',
  'accountOfficer', 'hasPreviouslyTakenLoan', 'rawFields', 'createdAt', 'updatedAt',
];

function findHeaderRowNumber(worksheet: ExcelJS.Worksheet): number | null {
  const maxScan = Math.min(worksheet.rowCount, HEADER_SCAN_LIMIT);
  for (let rowNumber = 1; rowNumber <= maxScan; rowNumber++) {
    const values = (worksheet.getRow(rowNumber).values as unknown[]) ?? [];
    const normalized = values.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : null));
    if (normalized.includes('customer id') && normalized.includes('ippis')) {
      return rowNumber;
    }
  }
  return null;
}

@Injectable()
export class DisbursedLoansParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(_batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled typings expect an older, non-generic Node `Buffer`
    // shape than this project's @types/node ships, hence `any` here.
    await workbook.xlsx.load(fileBuffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('Uploaded workbook has no worksheets');
    }

    const headerRowNumber = findHeaderRowNumber(worksheet);
    if (headerRowNumber === null) {
      throw new Error(
        `Could not locate a header row containing both "Customer ID" and "IPPIS" in the first ${HEADER_SCAN_LIMIT} rows`,
      );
    }

    const currentRecords = await this.prisma.loan.findMany();
    const existingCustomerIds = new Set(currentRecords.map((r) => r.customerId));

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.DISBURSED_LOANS,
      tableName: 'Loan',
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

    const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];

    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      rowsProcessed++;

      const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
      const mapped = mapLoanRow(rowByHeader);

      if (isLoanRowMappingFailure(mapped)) {
        rowsSkipped++;
        warnings.push(`Row ${rowNumber}: ${mapped.reason}`);
        continue;
      }
      warnings.push(...mapped.warnings.map((w) => `Row ${rowNumber}: ${w}`));

      const isUpdate = existingCustomerIds.has(mapped.record.customerId);

      await this.prisma.loan.upsert({
        where: { customerId: mapped.record.customerId },
        create: { ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
        update: { ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
      });

      if (isUpdate) {
        rowsUpdated++;
      } else {
        rowsCreated++;
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/parsers/disbursed-loans.parser.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 8: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/document-ingestion/parsers/build-row-by-header.ts src/document-ingestion/parsers/ippis-broadsheet.parser.ts src/document-ingestion/parsers/disbursed-loans.parser.ts src/document-ingestion/parsers/disbursed-loans.parser.spec.ts
git commit -m "feat: add DisbursedLoansParser orchestration"
```

---

### Task 4: Wire into the registry, e2e test, README, and Postman

**Files:**
- Modify: `src/document-ingestion/document-ingestion.module.ts`
- Test: `test/disbursed-loans-ingestion.e2e-spec.ts`
- Modify: `test/document-upload.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `DisbursedLoansParser` (Task 3), existing `DOCUMENT_PARSERS` token and `DocumentIngestionModule` (unchanged shape).
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
import { DisbursedLoansParser } from './parsers/disbursed-loans.parser';
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
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (
        noOpParser: NoOpDocumentParser,
        ippisParser: IppisBroadsheetParser,
        loansParser: DisbursedLoansParser,
      ) => ({
        [DocumentType.IPPIS_BROADSHEET]: ippisParser,
        [DocumentType.REPAYMENT_SCHEDULE]: noOpParser,
        [DocumentType.DISBURSED_LOANS]: loansParser,
      }),
      inject: [NoOpDocumentParser, IppisBroadsheetParser, DisbursedLoansParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
```

- [ ] **Step 2: Fix the now-stale `document-upload.e2e-spec.ts` test**

`DISBURSED_LOANS` no longer uses the no-op parser, so the test added in the IPPIS Broadsheet plan (`'uploads a disbursed-loans file, processes it via the no-op parser, and completes'`) will now fail the same way the original IPPIS one did — real parsing of garbage bytes legitimately fails. `REPAYMENT_SCHEDULE` is still the only document type using `NoOpDocumentParser`, so move this test there.

Replace that test in `test/document-upload.e2e-spec.ts`:

```typescript
  it('uploads a repayment-schedule file, processes it via the no-op parser, and completes', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-11')
      .attach('file', Buffer.from('fake-xlsx-content'), 'loans.xlsx')
      .expect(201);

    expect(res.body.documentType).toBe('REPAYMENT_SCHEDULE');
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(0);
  });
```

This makes the existing `'accepts a repayment-schedule upload with a valid period and records it on the batch'` test redundant in spirit but not in assertions (it checks `period` specifically) — leave it in place; both tests target the same no-op-backed endpoint deliberately, matching this file's role as the generic upload/queue-plumbing suite rather than a parser-behavior suite.

- [ ] **Step 3: Write the e2e test**

`test/disbursed-loans-ingestion.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const REAL_HEADERS = [
  'Customer ID', 'Customer Name', 'Account No.', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Product', 'Interest Rate', 'IPPIS',
];

async function buildLoansBuffer(customerId: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  sheet.addRow(['Title:', 'Disbursed Loans Report']);
  sheet.addRow([]);
  sheet.addRow(REAL_HEADERS);
  sheet.addRow([
    customerId, 'E2E Test Customer', 'ACC-E2E-1', 500000, 0,
    '08-Aug-2024', '30-May-2026', 'TEST PRODUCT', 42, 'CD7038686',
  ]);
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

describe('Disbursed loans ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const customerId = `E2E-CUST-${Date.now()}`;

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
      await prisma.loan.deleteMany({ where: { customerId } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded disbursed-loans report into a Loan and creates a snapshot export', async () => {
    const buffer = await buildLoansBuffer(customerId);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/disbursed-loans/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', buffer, 'loans.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(1);
    expect(batch!.rowsCreated).toBe(1);
    expect(batch!.snapshotExportId).not.toBeNull();

    const loan = await prisma.loan.findUnique({ where: { customerId } });
    expect(loan).not.toBeNull();
    expect(loan!.customerName).toBe('E2E Test Customer');
    expect(loan!.agency).toBe('NSCDC');
  });
});
```

- [ ] **Step 4: Run the affected e2e tests to verify they pass**

Run: `npx jest --config ./test/jest-e2e.json test/disbursed-loans-ingestion.e2e-spec.ts test/document-upload.e2e-spec.ts --runInBand`
Expected: PASS on both.

- [ ] **Step 5: Update the README**

In `README.md`'s "Document ingestion" section, replace the sentence about which document types are parsed with:

```markdown
**IPPIS Broadsheet and Disbursed Loans uploads are fully parsed** into
`IppisRecord` and `Loan` rows respectively (upserted by `agency`+`staffId`
and by `customerId`) — see `src/document-ingestion/parsers/`. Repayment
Schedule uploads are still processed by a no-op parser that records zero
rows; later work replaces its entry in `DOCUMENT_PARSERS`
(`src/document-ingestion/document-ingestion.module.ts`).
```

- [ ] **Step 6: Update the stale Postman description**

In `postman/public-sector-backend.postman_collection.json`, find the request named `"POST /admin/documents/disbursed-loans/upload - Success"` under **IPPIS > Documents**. Update its `request.description` (add one if none exists) to:

```
Attach an .xlsx file with a report-header block (any number of rows) followed by a row containing both "Customer ID" and "IPPIS" column headers — rows below that are upserted into Loan by customerId. Do NOT attach the real sample files under docs/added/ to a shared workspace — those contain real BVNs/bank data and are gitignored for that reason.
```

- [ ] **Step 7: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`
Expected: `VALID`

- [ ] **Step 8: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the new/modified ones from this plan.

- [ ] **Step 9: Commit**

```bash
git add src/document-ingestion/document-ingestion.module.ts test/disbursed-loans-ingestion.e2e-spec.ts test/document-upload.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: wire DisbursedLoansParser into the document-ingestion pipeline"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] Uploading a real-shaped Disbursed Loans workbook (report-header block + headers + data) produces a `Loan` row and a `DataSnapshotExport`, proven by `test/disbursed-loans-ingestion.e2e-spec.ts`.
- [ ] The header row is correctly located regardless of the report-header block's exact length — proven by `disbursed-loans.parser.spec.ts`.
- [ ] A workbook with no locatable header row fails the whole batch with a clear error — proven by `disbursed-loans.parser.spec.ts`.
- [ ] `agency` is correctly derived from each known IPPIS prefix, and set to `null` with a warning for an unrecognized one — proven by `loan-row-mapper.spec.ts`.
- [ ] A row missing any required field is skipped (not fatal to the batch) — proven by `loan-row-mapper.spec.ts`.
- [ ] Re-uploading the same `customerId` updates rather than duplicates — proven by `disbursed-loans.parser.spec.ts`.
- [ ] Postman's `POST /admin/documents/disbursed-loans/upload - Success` request no longer implies no-op behavior.
