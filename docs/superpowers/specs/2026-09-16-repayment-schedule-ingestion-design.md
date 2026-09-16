# Repayment Schedule Ingestion Parser — Design

**Date:** 2026-09-16
**Status:** Approved for planning (subject to further adjustment as this is refined)
**Depends on:** Document Ingestion & Reconciliation Engine design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md`), specifically §11 sequencing item 4 ("Repayment Schedule ingestion — the most complex parser, built after Disbursed Loans since reconciliation needs both"). Builds on the IPPIS Broadsheet and Disbursed Loans parsers for established conventions (`rawFields` catch-all, snapshot-before-merge, pure row-mapper + orchestration split).

## 1. Purpose and scope

Replace the `NoOpDocumentParser` currently registered for `DocumentType.REPAYMENT_SCHEDULE` with a real parser that turns an uploaded Repayment Schedule workbook into `LoanRepaymentRecord` rows, upserted by `(agency, staffId, period, elementName)`.

**In scope:**
- Parsing all 6 agency sheets (`NPF`, `NSCDC`, `IMMIGRATION`, `CORRECTIONAL`, `CUSTOM`, `LASG`) into `LoanRepaymentRecord` rows, each via its own hardcoded per-agency mapping function (these sheets share almost no column names — see §2).
- Locating LASG's header row, which is not row 1 (see §2).
- Period fallback logic: sheets with their own per-row period column normalize and compare it to the upload's stated period; sheets without one use the upload's period directly (per the parent design, unchanged here).
- Wiring into the existing `DOCUMENT_PARSERS` registry, `SnapshotExportService`, and `DocumentIngestionProcessor` — no changes to that pipeline's shape.

**Explicitly out of scope / deferred:**
- Reconciliation (depends on this *and* Disbursed Loans ingestion, both required — Disbursed Loans is done, this finishes the pair).
- Any use of `LoanRepaymentRecord.staffId`/`period`/`amount` beyond storing them — the future reconciliation logic that reads them is out of scope here.
- Multi-lender disambiguation beyond `elementName` (explicitly deferred in the parent design §10 — the sample data shows one lender per sheet).

## 2. Real source data shape (confirmed from `docs/added/REPAYMENT SCHEDULE.xlsx` — headers, sheet/row structure, and cell types only, never data values, per this repo's `.gitignore`/`CLAUDE.md` rule and this session's standing instruction to never read real user data beyond structure unless explicitly told to)

Six sheets, each with a **genuinely different column layout** (unlike the IPPIS Broadsheet's 3-near-identical/1-different pattern):

| Sheet | Rows | Header row | Columns |
|---|---|---|---|
| NPF | 6863 | 1 | Staff ID, CHECK, Legacy Id, Full Name, Element, Amount, Period, Command, Reason/Comments |
| NSCDC | 1949 | 1 | Employee Name, IPPIS NO, Amount |
| IMMIGRATION | 536 | 1 | Surname, Other Names, IPPIS NUMBER, StaffID, CIT MICROFINANCE |
| CORRECTIONAL | 124 | 1 | Surname Other Names, IPPIS NUMBER, StaffID, Amount, Account Number, Bank, Element Name, Deduction Beneficiary |
| CUSTOM | 27 | 1 | S/N, Period, Staff Number, Staff Name, Loan Type, Deduction |
| LASG | 233 | **3** | Employee_Number, Employee_Name, Ministry_Name, Grade_Level, Step, Result_Value SUM, Element_Name |

LASG's rows 1–2 are a title block (row 1 holds a single malformed/concatenated title string, row 2 is blank) before the real header row at row 3 — a smaller-scale version of the Disbursed Loans report-header-block problem, but confined to one sheet rather than the whole file.

Only **NPF** has an explicit per-deduction-type "Element" column (a staff member can have multiple rows per period, one per deduction type — union dues, other loans, etc., not just this lender). The other five sheets have no such column; each row there represents a single Moneyfield MFB loan deduction. **CUSTOM** additionally has a "Loan Type" column that reads as a natural per-row label even though it doesn't function as the natural-key discriminator (see §4).

Two sheets — **IMMIGRATION** and **CORRECTIONAL** — carry both an "IPPIS NUMBER" column and a separate "StaffID" column. Per your decision, "IPPIS NUMBER" is authoritative (consistent with every other sheet's identifier being IPPIS-terminology, and with the IPPIS Broadsheet/Disbursed Loans parsers' own identifier fields).

Only **NPF** and **CUSTOM** have their own per-row "Period" column; the other four sheets have none.

## 3. Schema

The `LoanRepaymentRecord` model does not exist in `prisma/schema.prisma` yet. New model, per the parent design's shape plus one addition (`elementDetail`, per your decision to preserve CUSTOM's "Loan Type" without disturbing the natural key):

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

(No `updatedAt` — unlike `IppisRecord`/`Loan`, the parent design's natural key here includes `period` and `elementName`, so a genuinely *changed* value for the same staff/period/element is rare enough that this repo's existing precedent — full overwrite on upsert conflict — doesn't need change-tracking beyond `createdAt`. This matches the parent design's original `LoanRepaymentRecord` shape, which also omitted `updatedAt`.)

## 4. Parser architecture

One `RepaymentScheduleParser implements DocumentParser`, replacing the `NoOpDocumentParser` binding for `DocumentType.REPAYMENT_SCHEDULE` in `DOCUMENT_PARSERS`. Unlike the IPPIS Broadsheet parser (one generic header-driven mapper reused across near-identical sheets), this uses **one small pure mapping function per agency**, each hardcoded to that sheet's real columns — matching the parent design's original, already-approved architecture (`AGENCY_ROW_MAPPERS: Record<AgencyKey, RowMapper>` dispatch table keyed by sheet name).

All six mappers produce the same `MappedRepaymentFields` shape:

```typescript
interface MappedRepaymentFields {
  staffId: string;
  elementName: string;
  elementDetail: string | null;
  amount: number;
  period: string | null; // this row's own period if the sheet has one; null if it should fall back to the upload's period
  rawFields: Record<string, unknown>;
}
```

Per-sheet mapping (confirmed column names from §2):

| Agency | staffId | amount | elementName | elementDetail | own period? |
|---|---|---|---|---|---|
| NPF | `Staff ID` | `Amount` | `Element` (real value) | `null` | `Period` column |
| NSCDC | `IPPIS NO` | `Amount` | `"LOAN_REPAYMENT"` | `null` | none |
| IMMIGRATION | `IPPIS NUMBER` | `CIT MICROFINANCE` | `"LOAN_REPAYMENT"` | `null` | none |
| CORRECTIONAL | `IPPIS NUMBER` | `Amount` | `"LOAN_REPAYMENT"` | `null` | none |
| CUSTOM | `Staff Number` | `Deduction` | `"LOAN_REPAYMENT"` | `Loan Type` (real value) | `Period` column |
| LASG | `Employee_Number` | `Result_Value SUM` | `"LOAN_REPAYMENT"` | `null` | none |

Every column not consumed by a given mapper (e.g. NPF's `CHECK`/`Legacy Id`/`Command`/`Reason/Comments`; IMMIGRATION's `Surname`/`Other Names`/`StaffID`; CORRECTIONAL's `Account Number`/`Bank`/`Deduction Beneficiary`) goes into `rawFields`, following the established convention from the other two parsers.

**Required-field validation** (skip + warn, per established convention): missing/blank staff-identifier column or missing/unparseable amount → row rejected. A sheet with no rows at all (e.g. an agency with nothing to report this period) is not an error — zero processed rows for that sheet, no warning needed.

**LASG header location:** since only this one sheet has the row-3-header quirk, its own mapper's entry point scans that sheet's first 5 rows for one containing both "Employee_Number" and "Employee_Name" (mirroring the Disbursed Loans header-scan pattern, scoped to this sheet only) rather than assuming row 1.

**Sheet dispatch:** the orchestrator iterates every sheet in the workbook, matches sheet names to the known agency keys (case-insensitive, same as the IPPIS Broadsheet parser), and calls that agency's mapper for each data row. An unrecognized sheet name → batch warning, sheet skipped (per parent design §9).

**Period fallback (per parent design §5, unchanged):**
- If a mapper's row has its own `period` value (NPF, CUSTOM), normalize it and compare to the upload's stated `period` (the `DocumentUploadBatch.period` field, already required at the HTTP layer for this document type). A mismatch → batch warning, but the row is still ingested under its *own* stated period, not the upload's.
- If a mapper's row has no period (`period: null` — NSCDC, IMMIGRATION, CORRECTIONAL, LASG), the upload's period is used directly.

**Upsert:** natural key `(agency, staffId, period, elementName)`, full overwrite on conflict — same precedent as the other two parsers.

## 5. Pipeline integration

Same shape as the other two parsers: before upserting, calls `SnapshotExportService.exportSnapshot()` with the entire current `LoanRepaymentRecord` table, `rawFields` pre-serialized to a JSON string at the call site. Returns a `ParseResult`, unchanged interface.

## 6. Testing strategy

Unit tests per agency mapper (6 small pure-function suites, each covering: a valid row, a missing-staff-identifier rejection, a missing/unparseable-amount rejection, and that agency's specific quirk — NPF's real `Element` value flowing through as `elementName`; CUSTOM's `Loan Type` flowing into `elementDetail`; IMMIGRATION/CORRECTIONAL preferring `IPPIS NUMBER` over `StaffID`). An orchestration unit test suite for `RepaymentScheduleParser` covering: sheet-to-agency dispatch, LASG's header-row location, period-mismatch warning (own-period sheet), period-fallback (no-period sheet), unrecognized sheet warning, upsert create-vs-update, snapshot export call. One e2e test uploading a small synthetic workbook (built with `exceljs` at test time, covering at least one own-period sheet and one no-period sheet, with fabricated non-real values) through the full upload → queue → parse → DB pipeline.

## 7. Error handling summary (delta from parent design §9)

Everything in the parent design's error-handling section applies unchanged, including the row-level-period-mismatch-is-a-warning-not-a-rejection rule from §5.

One gap this plan closes: the parent design's §9 states "any unhandled parser exception for one sheet → that sheet's rows are marked skipped, a warning is recorded, and processing continues with the remaining sheets" — but neither the IPPIS Broadsheet nor the Disbursed Loans parser actually wraps its per-row loop in a try/catch for this (their row-mapping functions never throw; they return a discriminated `{ok: false, reason}` result instead, so the scenario never arose). With six heterogeneous per-agency mappers here, a genuinely malformed sheet is more likely, so this parser wraps each sheet's row-processing loop in a try/catch: an uncaught exception mid-sheet marks the remaining unprocessed rows in that sheet as skipped, records a warning with the exception message, and moves on to the next sheet rather than failing the whole batch.
