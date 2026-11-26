# IPPIS Broadsheet Ingestion Parser — Design

**Date:** 2026-09-16
**Status:** Approved for planning
**Depends on:** Document Ingestion & Reconciliation Engine design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md`), specifically §11 sequencing item 2 ("IPPIS Broadsheet ingestion — simplest of the three, good first real consumer of the ingestion infrastructure").

## 1. Purpose and scope

Replace the `NoOpDocumentParser` currently registered for `DocumentType.IPPIS_BROADSHEET` with a real parser that turns an uploaded IPPIS Broadsheet workbook into `IppisRecord` rows — the reference/master dataset of IPPIS-verified civil servants. This table is **not** itself a Client or an onboarding action; it is the data a future Client-onboarding flow will match a self-reported BVN/IPPIS number against, pulling the matched record's details into that client's profile. Nothing about that future matching flow is built here — this plan only produces the reference table faithfully from the source file.

**In scope:**
- Parsing every sheet in an uploaded IPPIS Broadsheet workbook into `IppisRecord` rows, upserted by `(agency, staffId)`.
- Handling real structural differences already found in the sample file across agency sheets (see §2).
- Row-level validation with skip/warning semantics consistent with the parent design's error-handling rules (§9 of the parent design).
- Wiring into the existing `DOCUMENT_PARSERS` registry, `SnapshotExportService`, and `DocumentIngestionProcessor` — no changes to that pipeline's shape.

**Explicitly out of scope / deferred:**
- Disbursed Loans and Repayment Schedule parsers (later, separate plans per the parent design's sequencing).
- Reconciliation.
- The future Client-onboarding BVN/IPPIS-number matching flow.
- Admin-configurable column mapping (still a hardcoded-per-format parser, per the parent design's explicit non-goal).

## 2. Real source data shape (confirmed from `docs/added/IPPIS BROADSHEET SAMPLE.xlsx` headers — never committed, per this repo's `.gitignore`/`CLAUDE.md` rule)

Four sheets: `NPF`, `NSCDC`, `IMMIGRATION`, `CORRECTIONAL`. NSCDC/IMMIGRATION/CORRECTIONAL share an identical 22-column layout; NPF has a 20-column layout that differs as follows:

| Column | NPF | NSCDC/IMMIGRATION/CORRECTIONAL |
|---|---|---|
| Department | absent | present |
| Sub Organization | present | present |
| Grade Category | present (NPF-only) | absent |
| Salary | present (NPF-only) | absent |
| PFA Name | absent | present |
| Pin Number | absent | present |
| Legacy ID | absent | present |

All four sheets share: Staff ID, Employee Name, Employee Status, Hire Date, Date Of Birth, Marital Status, Gender, **Email Address**, Job Title, **Assignment Status**, Grade, Step, Telephone Number, Bank Name, Account Number, Date Terminated, Bvn.

`Email Address` and `Assignment Status` are present on every sheet but are **not** part of the approved `IppisRecord` schema from the parent design. Per your decision, they go into a new catch-all field rather than being promoted to first-class columns, alongside NPF's `Grade Category`.

Cell-type findings from the sample: `Hire Date`/`Date Of Birth`/`Date Terminated` are native Excel dates. **`Bvn` and `Telephone Number` are stored as Excel numeric cells**, not text — a leading zero already lost at the source (in the original file) cannot be recovered by this parser; nothing upstream of the raw cell value is fixable here.

## 3. Schema change

The `IppisRecord` model does not exist in `prisma/schema.prisma` yet — the parent design specified its shape but no plan has created it so far. This plan adds it exactly as specified in the parent design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md` §4), plus one new field per your decision above:

```prisma
model IppisRecord {
  id              String    @id @default(uuid())
  agency          String
  staffId         String
  employeeName    String
  employeeStatus  String
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
  rawFields       Json?     // Email Address, Assignment Status (every sheet); Grade Category (NPF only)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([agency, staffId])
}
```

## 4. Parser architecture

One `IppisBroadsheetParser implements DocumentParser`, replacing the `NoOpDocumentParser` binding for `DocumentType.IPPIS_BROADSHEET` in `DOCUMENT_PARSERS`.

**Per sheet:**
1. Sheet name matched case-insensitively against known agencies (`NPF`, `NSCDC`, `IMMIGRATION`, `CORRECTIONAL`). No match → batch warning (`Unrecognized sheet "X" skipped`), sheet skipped entirely, processing continues with the next sheet (per parent design §9 — one bad/unknown sheet never fails the whole batch).
2. A single **header-driven column mapper** reads row 1, builds a `{ normalizedHeaderName: columnIndex }` map (case-insensitive, trimmed). A fixed table maps known header names to `IppisRecord` fields; any header present in the sheet but not in that table is captured into `rawFields` under its own header text as the key.
3. For each data row, the mapper reads each mapped column by its resolved index (so NPF's absent `Department`/`PFA Name`/`Pin Number`/`Legacy ID` naturally come through as `null`, and its `Grade Category` — plus every sheet's `Email Address`/`Assignment Status` — land in `rawFields`).

**Row-level field handling:**
- `Bvn`, `Telephone Number`: numeric cells stringified via `String(Math.trunc(value))`; string cells passed through as-is (trimmed).
- `Hire Date`, `Date Of Birth`, `Date Terminated`: accepted as native `Date` objects (as in the sample) or parsed from a date-like string (`Date.parse` fallback); unparseable → `null` + a row-level warning (the row is **not** rejected for this alone).
- `Salary`: parsed as `Decimal` when present and numeric; `null` otherwise (matches the sample, where it's empty for NSCDC/IMMIGRATION/CORRECTIONAL sheets that don't have the column at all, and empty in the NPF sample rows too).

**Row-level validation (skip + warn, per parent design §9's "row still counted, batch continues" pattern):**
- Missing/blank `Staff ID` or `Employee Name` → row skipped, counted in `rowsSkipped`, warning recorded (`Row N on sheet "X": missing Staff ID/Employee Name`).
- `Bvn` present but not exactly 11 digits after stringification → row **rejected** (skipped, not ingested), counted in `rowsSkipped`, warning recorded (`Row N on sheet "X": BVN "..." is not 11 digits`) — per your decision, since a malformed BVN is actively harmful for the future onboarding-matching use case rather than merely informational.

**Upsert:** natural key `(agency, staffId)`, full overwrite on conflict — unchanged from the parent design (the pre-merge snapshot already preserves history).

## 5. Pipeline integration

No changes to `DocumentIngestionProcessor`, `DocumentBatchService`, or the controller. `SnapshotExportService.exportSnapshot()` is called before the upsert step with the **entire current** `IppisRecord` table (already-approved behavior from the parent design, unchanged) — columns include the new `rawFields` (serialized as JSON text in the CSV/SQL export, consistent with how other `Json?` fields would need to render; `rawFields` is the first `Json?` column `SnapshotExportService` has had to export, so its `sqlValue`/`csvValue` helpers need a branch for objects: `JSON.stringify(value)`, since the current implementation's `String(value)` fallback would already produce syntactically-passable-but-ugly output (`[object Object]`) for a plain object — this is a small existing-code fix bundled into this parser's task since it's the first real caller to exercise that path).

`IppisBroadsheetParser.parse()` returns a `ParseResult` (`{ rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId }`) exactly as the interface already requires — `rowsCreated`/`rowsUpdated` distinguished by checking whether the upsert's `(agency, staffId)` key existed beforehand (one `findMany` of existing keys before the upsert loop, diffed against the incoming batch's keys).

## 6. Dependency

Adds `exceljs` (already installed, `^4.4.0`) for reading `.xlsx` workbooks — chosen over `xlsx`/SheetJS because the npm-published `xlsx` package has two unpatched high-severity advisories (prototype pollution, ReDoS) with no fix available from the npm registry (SheetJS only ships patched versions from its own CDN). `exceljs` has one moderate transitive advisory (via `uuid`), not exploitable in this codebase's usage (no untrusted uuid generation), against a pre-existing baseline of 26 unrelated advisories already in the project.

## 7. Testing strategy

Unit tests for `IppisBroadsheetParser` against small synthetic workbooks built in-code with `exceljs`'s own writer (never `docs/added/`'s real file), covering:
- NPF-shape row → correct field mapping, `Grade Category`/`Email Address`/`Assignment Status` land in `rawFields`.
- NSCDC-shape row → `Department`/`PFA Name`/`Pin Number`/`Legacy ID` populated, `Email Address`/`Assignment Status` in `rawFields`.
- Missing Staff ID → row skipped, warning recorded, `rowsSkipped` incremented.
- Numeric Bvn with != 11 digits → row skipped, warning recorded.
- Numeric Bvn/Telephone Number stringified correctly (11-digit case).
- Unrecognized sheet name → warning recorded, sheet skipped, other sheets still processed.
- Upsert semantics: a second parse of the same workbook updates rather than duplicates (`rowsUpdated`, not `rowsCreated`, on the second run).

One e2e test (extends `test/document-upload.e2e-spec.ts` or a new file) that uploads a small synthetic `.xlsx` (built at test-time with `exceljs`), polls the batch to completion, and verifies: batch `COMPLETED` with correct row counts, `IppisRecord` rows exist with expected values including `rawFields`, and a `DataSnapshotExport` row was created. This exercises the now-isolated `document-ingestion` BullMQ queue (fixed today via `REDIS_KEY_PREFIX`) so it should run cleanly and deterministically, unlike the earlier cross-environment queue collision.

## 8. Error handling summary (delta from parent design §9)

Everything in the parent design's error-handling section applies unchanged. This parser adds one row-level rule not explicit there: a malformed BVN (wrong digit count) is treated as a hard per-row rejection, not just a warning — called out explicitly since it's stricter than the general "warn but still ingest" pattern used for e.g. unparseable dates.
