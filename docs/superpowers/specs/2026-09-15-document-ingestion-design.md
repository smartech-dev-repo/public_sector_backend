# Document Ingestion & Reconciliation Engine — Design

**Date:** 2026-09-15
**Status:** Approved for planning
**Depends on:** Phase 1 Foundation (RBAC/`PermissionsGuard`, Prisma/Postgres setup, multi-provider-with-failover pattern) and the Back-Office Governance Bundle (`AuditLogService`, `AdminUser`/`Role`/`Permission`).

## 1. Purpose and scope

This is the second half of the requirements raised against the three sample
documents (IPPIS Broadsheet, Repayment Schedule, Disbursed Loans Report):
uploading each document type, versioning the prior state before merging in
new data, and reconciling expected vs. actual loan repayments.

**In scope:**
- Upload endpoints for all three document types, each producing a normalized
  domain record set.
- Before every merge: export the *entire current table* (from inception, not
  a diff) as SQL + CSV, push both to a bucket, and record a downloadable
  link.
- Merge (upsert) new/changed records by a natural key per document type.
- Reconciliation: for each loan, compute the expected repayment for a period
  via amortization and compare it against actual IPPIS deductions for that
  staff member/period, producing a variance record.
- Background processing via BullMQ + Redis (already present in the
  environment) rather than synchronous request handling.

**Explicitly out of scope / deferred:**
- Real GCS/S3 vendor wiring — only a local-disk mock `FileStorageProvider`,
  matching every other external integration in this project so far.
- Admin-configurable column mapping — parsers are hardcoded per
  (agency, document type) pair; onboarding a new agency is a code change.
- Full CRUD/editing of ingested records — these are derived/ingested data,
  browsable and filterable, not directly admin-editable.
- A UI for reviewing variances beyond a listable API.

## 2. Source data shapes (from the three sample files)

- **IPPIS Broadsheet**: one sheet per agency (`NPF`, `NSCDC`, `IMMIGRATION`,
  `CORRECTIONAL` in the sample). Personnel/payroll master data: Staff ID,
  name, employment status, dates, job title, department, grade/step, bank
  details, BVN. NPF's sheet lacks PFA Name/Pin Number/Legacy ID that the
  other three have, and has Salary/Grade Category instead — columns are
  **not uniform even within this one document**.
- **Repayment Schedule**: one sheet per agency (`NPF`, `NSCDC`,
  `IMMIGRATION`, `CORRECTIONAL`, `CUSTOM`, `LASG` in the sample), each with a
  **completely different column layout**. Some have an explicit per-row
  period (`SEPTEMBER 2024`, `202512`); LASG has none at all.
- **Disbursed Loans Report**: single sheet, one row per loan, with a report
  header block (bank name, title, date range, filters) before the real
  column headers. Per-loan detail including an `IPPIS` column linking back
  to the broadsheet.

## 3. Pipeline overview

1. `POST /admin/documents/:type/upload` (multipart; `type` is
   `ippis-broadsheet` | `repayment-schedule` | `disbursed-loans`) — for
   `repayment-schedule`, the request also requires a `period` field (e.g.
   `2024-12`) stating which month the file covers.
2. The raw file is validated (extension, size limit) and stored via
   `FileStorageProvider`. A `DocumentUploadBatch` row is created
   (`status: PENDING`) and a job is enqueued on the `document-ingestion`
   BullMQ queue with `{ batchId }`. The endpoint returns immediately with
   the batch id.
3. A worker picks up the job, loads the batch, and dispatches by
   `documentType`:
   - Iterates every sheet in the workbook.
   - For a sheet whose name matches a known agency, runs that
     `(agency, documentType)`'s hardcoded parser, producing normalized
     records.
   - A sheet whose name doesn't match any known agency is skipped with a
     warning recorded on the batch — never a hard failure of the whole
     upload.
4. **Before** writing anything, the worker exports the *entire current*
   table for that document type's target entity (every record accumulated
   since inception, not just what's changing) as both a SQL script (plain
   `INSERT` statements) and a CSV, uploads both via `FileStorageProvider`,
   and creates a `DataSnapshotExport` row with their download URLs.
5. The worker upserts the normalized records by natural key (see §4).
6. For `disbursed-loans` and `repayment-schedule` uploads, the worker then
   runs reconciliation (§6) for the affected loans/periods.
7. The batch is marked `COMPLETED` (or `FAILED` with an error message) with
   final row counts (`processed`/`created`/`updated`/`skipped`).

## 4. Data model

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
  period           String?             // required (validated) for REPAYMENT_SCHEDULE, null otherwise
  status           DocumentBatchStatus @default(PENDING)
  rowsProcessed    Int                 @default(0)
  rowsCreated      Int                 @default(0)
  rowsUpdated      Int                 @default(0)
  rowsSkipped      Int                 @default(0)
  warnings         Json?               // e.g. unrecognized sheet names, period mismatches
  errorMessage     String?
  snapshotExportId String?             @unique
  snapshotExport   DataSnapshotExport? @relation(fields: [snapshotExportId], references: [id])
  startedAt        DateTime?
  completedAt      DateTime?
  createdAt        DateTime            @default(now())
}

model DataSnapshotExport {
  id            String        @id @default(uuid())
  documentType  DocumentType
  recordCount   Int
  sqlStorageKey String
  csvStorageKey String
  sqlUrl        String
  csvUrl        String
  generatedAt   DateTime      @default(now())
  batch         DocumentUploadBatch?
}

model IppisRecord {
  id             String    @id @default(uuid())
  agency         String
  staffId        String
  employeeName   String
  employeeStatus String
  hireDate       DateTime?
  dateOfBirth    DateTime?
  maritalStatus  String?
  gender         String?
  jobTitle       String?
  department     String?
  subOrganization String?
  grade          String?
  step           String?
  salary         Decimal?
  phone          String?
  bankName       String?
  accountNumber  String?
  pfaName        String?
  pinNumber      String?
  dateTerminated DateTime?
  bvn            String?
  legacyId       String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([agency, staffId])
}

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
  agency                 String?   // null when the IPPIS prefix isn't recognized — flagged for review
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
  repaymentVariances     RepaymentVariance[]
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  @@index([ippisNumber])
}

model LoanRepaymentRecord {
  id          String    @id @default(uuid())
  agency      String
  staffId     String
  period      String?   // YYYY-MM; null only if truly unrecoverable (shouldn't happen once upload-level period is required)
  elementName String
  amount      Decimal
  rawFields   Json?     // agency-specific columns that don't fit the common shape (Command/Reason, Bank, etc.)
  createdAt   DateTime  @default(now())

  @@unique([agency, staffId, period, elementName])
}

enum VarianceStatus {
  MATCHED
  UNDER_PAID
  OVER_PAID
  NO_DEDUCTION_FOUND
}

model RepaymentVariance {
  id             String         @id @default(uuid())
  loanId         String
  loan           Loan           @relation(fields: [loanId], references: [id])
  period         String
  expectedAmount Decimal
  actualAmount   Decimal
  variance       Decimal
  status         VarianceStatus
  generatedAt    DateTime       @default(now())

  @@unique([loanId, period])
}
```

## 5. Parsers and natural keys

Two agency-keyed maps, one per document type that has per-agency sheets:

```typescript
type AgencyKey = 'NPF' | 'NSCDC' | 'IMMIGRATION' | 'CORRECTIONAL' | 'CUSTOM' | 'LASG';

type IppisBroadsheetParser = (rows: RawRow[]) => NormalizedIppisRecord[];
type RepaymentScheduleParser = (rows: RawRow[], uploadPeriod: string) => NormalizedRepaymentRecord[];

const IPPIS_BROADSHEET_PARSERS: Partial<Record<AgencyKey, IppisBroadsheetParser>> = { /* NPF, NSCDC, IMMIGRATION, CORRECTIONAL */ };
const REPAYMENT_SCHEDULE_PARSERS: Partial<Record<AgencyKey, RepaymentScheduleParser>> = { /* NPF, NSCDC, IMMIGRATION, CORRECTIONAL, CUSTOM, LASG */ };
```

(`AdminUser` needs a corresponding `uploadedDocumentBatches DocumentUploadBatch[]`
back-relation field added alongside its existing `roles`/`sentInvites` —
noted here rather than reprinting the whole model, same as the governance
bundle design's treatment of `Role`/`AdminUser`.)

Each `RepaymentScheduleParser` receives the batch's required `uploadPeriod`
and applies the fallback logic from the LASG discussion:
- If the sheet has its own per-row period (NPF: `"SEPTEMBER 2024"`, CUSTOM:
  `"202512"`), normalize it and compare to `uploadPeriod`; a mismatch adds a
  warning to the batch (surfaces an admin uploading the wrong file) but
  still ingests the row under its *own* stated period, not the upload's.
- If the sheet has no period column at all (LASG), every row uses
  `uploadPeriod` directly. This is the general mechanism — it isn't
  LASG-specific, so any future agency with the same gap is handled the same
  way with no new logic.

Disbursed Loans Report is single-sheet; one parser derives `agency` per row
from the `IPPIS` column's prefix (`PF`→NPF, `CD`→NSCDC, `NI`→IMMIGRATION,
`PR`→CORRECTIONAL, `NCS`→CUSTOM). An unrecognized prefix sets `agency: null`
and adds a batch warning rather than guessing.

**Natural keys for upsert:**
- `IppisRecord`: `(agency, staffId)`
- `Loan`: `customerId`
- `LoanRepaymentRecord`: `(agency, staffId, period, elementName)`

On conflict, all mapped fields are overwritten with the latest upload's
values — full overwrite, not field-by-field diffing — because the
pre-merge snapshot (§3 step 4) already preserves the prior state for
history/audit purposes. There's no need for the live table itself to carry
that history too.

## 6. Reconciliation

For each `Loan` affected by a `disbursed-loans` or `repayment-schedule`
upload, and for the period(s) touched by that upload:

1. Compute the expected installment via standard reducing-balance
   amortization from `loanAmount`, `interestRatePercent`, and the
   `disbursementDate`→`maturationDate` term — a pure function, independent
   of any I/O, straightforward to unit test against known amortization
   tables.
2. Sum `LoanRepaymentRecord.amount` for `(agency, staffId, period)` matching
   the loan's `ippisNumber`/`agency`.
3. Compare: `variance = actual - expected`. Status is `MATCHED` (variance
   within a small rounding tolerance), `UNDER_PAID`, `OVER_PAID`, or
   `NO_DEDUCTION_FOUND` (no matching repayment records at all for that
   period).
4. Upsert a `RepaymentVariance` row keyed on `(loanId, period)`.

This is an assumption about repayment method (standard amortization) since
the source data has no explicit "expected installment" field — flagged
explicitly per your review of the design.

## 7. New endpoints and permissions

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /admin/documents/ippis-broadsheet/upload` | `ippis:upload` (exists) | Multipart file upload |
| `POST /admin/documents/repayment-schedule/upload` | `repayments:upload` (new) | Multipart + required `period` field |
| `POST /admin/documents/disbursed-loans/upload` | `loans:upload` (new) | Multipart file upload |
| `GET /admin/documents/batches` | `documents:read` (new) | List upload history, filterable by type/status |
| `GET /admin/documents/batches/:id` | `documents:read` | Batch detail incl. warnings, snapshot links |
| `GET /admin/reconciliation` | `reconciliation:read` (new) | List variances, filterable by agency/status/period |
| `GET /admin/loans` | `loans:upload` (reused — same people who upload should be able to browse) | Basic listing/filtering |
| `GET /admin/ippis-records` | `ippis:upload` (reused) | Basic listing/filtering |

## 8. File storage and job queue

`FileStorageProvider { putObject(key, buffer): Promise<void>; getSignedDownloadUrl(key): Promise<string>; deleteObject(key): Promise<void>; }`
with a `LocalFileStorageProvider` (writes under a local directory, returns
`file://`-style or app-served URLs) as the only implementation for now —
same "mock is fine to start" precedent already used for `OtpProvider` and
`EmailProvider`. A real GCS/S3 vendor is a later, separate change behind the
same interface.

BullMQ + the Redis instance already present in the environment. One
`document-ingestion` queue; one processor dispatches internally on
`batch.documentType` rather than using separate queues per type — keeps
worker setup simple while the volume is low.

## 9. Error handling

- Unrecognized sheet name → warning on the batch, that sheet skipped, batch
  continues.
- Unrecognized IPPIS prefix on a Disbursed Loans row → `agency: null` on
  that `Loan`, warning on the batch, row still ingested (not dropped) so
  it's visible for manual correction.
- Repayment Schedule upload missing the required `period` field → `400`
  at the HTTP layer, before any job is enqueued.
- A row-level period that doesn't match the upload's stated period → warning
  on the batch; the row is still ingested under its own period.
- Any unhandled parser exception for one sheet → that sheet's rows are
  marked `rowsSkipped`, a warning is recorded, and processing continues with
  the remaining sheets — one bad sheet must never fail an entire batch.
- A worker crash mid-batch → batch stays `PROCESSING`; a stale-batch sweep
  is deferred (see §10) rather than built now, matching this project's
  existing pattern of not building infrastructure ahead of a proven need.

## 10. Deferred / explicitly not building now

- Real GCS/S3 vendor wiring.
- Admin-configurable column mapping (new agency = code change + deploy).
- A stale/stuck-batch sweep (background job to detect a worker that died
  mid-processing and mark the batch `FAILED`).
- Editing ingested records directly through the API.
- Multi-lender repayment disambiguation beyond `elementName` (the sample
  data shows one lender per sheet; if a sheet ever mixes lenders for the
  same staff/period, the current unique key would need a lender field
  added — not needed yet).

## 11. Implementation sequencing note

This design is larger than a single implementation plan should be (roughly
comparable to, or larger than, the 12-task governance bundle). When moving
to `writing-plans`, expect it to split into sequential plans rather than
one document, following the natural dependency order:

1. **Ingestion infrastructure** — `FileStorageProvider` + local mock,
   BullMQ wiring, `DocumentUploadBatch`/`DataSnapshotExport` models, the
   generic snapshot/export mechanism (SQL+CSV generation, bucket push).
   Nothing document-specific yet.
2. **IPPIS Broadsheet ingestion** — simplest of the three (no reconciliation
   dependency), good first real consumer of (1).
3. **Disbursed Loans ingestion** — `Loan` model, single-sheet parser,
   agency-from-prefix derivation.
4. **Repayment Schedule ingestion** — the most complex parser (6
   inconsistent sheet layouts, the period fallback logic), built after (3)
   since reconciliation needs both.
5. **Reconciliation** — amortization function, `RepaymentVariance`, the
   `GET /admin/reconciliation` endpoint. Depends on (3) and (4).

## 12. Testing strategy

Same pattern as every prior phase: unit tests per parser (against small
fixtures resembling the real sheets, not the real files themselves — the
real files contain actual people's BVNs/bank accounts and must never be
committed, per this repo's existing `.gitignore` rule for `docs/added/`),
unit tests for the amortization function against known values, and e2e
tests per upload flow (upload → poll batch → verify snapshot export exists
→ verify records upserted → verify reconciliation ran).
