# Disbursed Loans Ingestion Parser — Design

**Date:** 2026-09-16
**Status:** Approved for planning
**Depends on:** Document Ingestion & Reconciliation Engine design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md`), specifically §11 sequencing item 3 ("Disbursed Loans ingestion — Loan model, single-sheet parser, agency-from-prefix derivation"). Builds on the IPPIS Broadsheet ingestion parser (`docs/superpowers/specs/2026-09-16-ippis-broadsheet-ingestion-design.md`) for its established patterns (header-driven mapping, `rawFields` catch-all, snapshot-before-merge).

## 1. Purpose and scope

Replace the `NoOpDocumentParser` currently registered for `DocumentType.DISBURSED_LOANS` with a real parser that turns an uploaded Disbursed Loans Report workbook into `Loan` rows, upserted by `customerId`.

**In scope:**
- Parsing the single-sheet Disbursed Loans Report into `Loan` rows.
- Locating the real header row within a report-header block that precedes it.
- Deriving `agency` from the `IPPIS` column's prefix.
- Row-level validation with skip/warning semantics consistent with the parent design and the IPPIS Broadsheet parser.
- Wiring into the existing `DOCUMENT_PARSERS` registry, `SnapshotExportService`, and `DocumentIngestionProcessor` — no changes to that pipeline's shape.

**Explicitly out of scope / deferred:**
- IPPIS Broadsheet and Repayment Schedule parsers (already done / not yet started respectively).
- Reconciliation (depends on this *and* Repayment Schedule ingestion, per the parent design's sequencing).
- Any use of `Loan.ippisNumber` beyond storing and indexing it — the future reconciliation/onboarding-matching logic that reads it is out of scope here.

## 2. Real source data shape (confirmed from `docs/added/DisbursedLoans_Reports-82.xlsx` — headers and cell *types* only, never data values, per this repo's `.gitignore`/`CLAUDE.md` rule and this session's standing instruction to never read real user data beyond structure unless explicitly told to)

Single sheet, dimensions `A1:AD1115` (30 columns, 1106 data rows). **Rows 1–7 are a report-header block** (bank name; title; disbursed-date-range, status, product, branch, and account-officer filter values) — not part of the tabular data. **Row 9 holds the real column headers**; row 8 is blank. Column headers, in order:

`Customer ID | Customer Name | Group Name | Account No. | Address | Branch | Gender | Phone No. | Ministries, Departments and Agencies | Loan Amount | Principal Bal. | Disbursement Date | Maturation Date | Effective Date | Moratarium (day) | Restructured Disbursement Date | Restructured Maturation Date | Product | Linked Account Number | Linked Account Name | BVN | Interest Rate | Prin. Repay. | Int. Repay. | Account Officer | Guarantor 1 | Guarantor 2 | Has Previously Taken Loan | Security Deposit | IPPIS`

Cell-type findings (from the first data row's raw XML `t`/`s` attributes — types only): `Loan Amount`, `Principal Bal.`, `Interest Rate`, and `Has Previously Taken Loan` are numeric cells. **`Disbursement Date`/`Maturation Date`/`Effective Date`/`Restructured Disbursement Date`/`Restructured Maturation Date` are stored as strings**, not native Excel dates (unlike the IPPIS Broadsheet) — format observed as `DD-Mon-YYYY` (e.g. `01-Aug-2024`). `Moratarium (day)` is also a string despite being numeric in nature. `Customer ID`, `Account No.`, `Phone No.`, `BVN`, and `IPPIS` are all stored as strings — no numeric-coercion risk here, unlike the IPPIS Broadsheet's numeric BVN/phone cells.

Columns present in the real file but **not** in the approved `Loan` schema (parent design §4): `Group Name`, `Ministries, Departments and Agencies`, `Restructured Disbursement Date`, `Restructured Maturation Date`, `Prin. Repay.`/`Int. Repay.` (repayment-method descriptors like "Pro rated(Monthly)", not amounts), `Linked Account Name`, `Guarantor 1`, `Guarantor 2`, `Security Deposit`.

## 3. Schema change

The `Loan` model does not exist in `prisma/schema.prisma` yet. This plan adds it as specified in the parent design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md` §4), plus one addition — a `rawFields Json?` catch-all, same precedent as `IppisRecord`:

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

(`repaymentVariances RepaymentVariance[]` from the parent design's full model is deferred — `RepaymentVariance` doesn't exist yet and belongs to the later Reconciliation sub-project, per the parent design's own sequencing. Adding a relation field to a model that doesn't exist yet would break `prisma generate`; it's added when Reconciliation is built.)

## 4. Parser architecture

One `DisbursedLoansParser implements DocumentParser`, replacing the `NoOpDocumentParser` binding for `DocumentType.DISBURSED_LOANS` in `DOCUMENT_PARSERS`.

**Header row location:** scan the first 20 rows of the (single) worksheet for the one containing both "Customer ID" and "IPPIS" as header values (case-insensitive) — more specific than "Customer ID" alone, which could collide with a report-header filter label. No match in the first 20 rows → the whole batch fails with a clear error message (this is a structural precondition, not a per-row concern — matches the parent design's principle that a genuinely malformed upload should fail clearly rather than silently produce zero rows).

**Row mapping:** a pure `mapLoanRow(rowByHeader: Record<string, unknown>): RowMappingResult` function, directly mirroring `mapIppisRow`'s shape and conventions (same `{ok: true, record, warnings}` / `{ok: false, reason}` discriminated union, same header-driven `rawFields` capture for unmapped columns). Field handling:
- `customerId`, `customerName`, `accountNumber`, `product`: read via a `stringOrNull`-style helper; missing any of these → row rejected.
- `ippisNumber` (from the `IPPIS` column): missing → row rejected (needed both as a required field and to derive `agency`).
- `loanAmount`, `principalBalance`, `interestRatePercent`: parsed as numbers; missing or unparseable → row rejected (these are the core financial facts of the loan).
- `disbursementDate`, `maturationDate`: parsed from the `DD-Mon-YYYY` string format; missing or unparseable → row rejected (both are NOT NULL in the schema).
- `effectiveDate`, restructured dates (captured into `rawFields`, not first-class): same string-date parser; unparseable → null + warning, not rejected (not required fields).
- `moratoriumDays`: parsed as an integer from its numeric-looking string; unparseable → null + warning.
- `hasPreviouslyTakenLoan`: numeric/truthy coercion (`1`/`"true"`/`"yes"` → `true`, everything else including missing → `false`, matching the schema's `@default(false)`).
- `agency`: derived from `ippisNumber`'s prefix — `PF`→`NPF`, `CD`→`NSCDC`, `NI`→`IMMIGRATION`, `PR`→`CORRECTIONAL`, `NCS`→`CUSTOM` (case-insensitive prefix match). No recognized prefix → `agency: null` + row-level warning; the row is still ingested (per parent design §9 — an unrecognized IPPIS prefix is flagged for review, not dropped).
- Everything else in §2's "not in the approved schema" list → `rawFields`.

**Upsert:** natural key `customerId` (confirmed), full overwrite on conflict — same precedent as `IppisRecord`.

## 5. Pipeline integration

Same shape as the IPPIS Broadsheet parser: before upserting, calls `SnapshotExportService.exportSnapshot()` with the entire current `Loan` table (columns matching the schema above, `rawFields` pre-serialized to a JSON string at the call site — same approach used for `IppisRecord`, avoiding any change to `SnapshotExportService` itself). Returns a `ParseResult` (`{rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId}`), unchanged interface.

## 6. Testing strategy

Same pattern as the IPPIS Broadsheet parser: a pure-function unit test suite for `mapLoanRow` (valid full row; each required-field-missing rejection case; agency derivation for each known prefix and for an unrecognized one; date-string parsing including an unparseable case; `rawFields` capture), an orchestration unit test suite for `DisbursedLoansParser` (header-row-location including a workbook whose filter block is a different length than the sample; malformed-workbook-with-no-header-row failure; upsert create-vs-update; snapshot export call), and one e2e test uploading a small synthetic workbook (built with `exceljs` at test time, mimicking the real report-header-block-then-headers structure with fabricated, non-real values) through the full upload → queue → parse → DB pipeline.

## 7. Error handling summary (delta from parent design §9)

Everything in the parent design's error-handling section applies unchanged, with one addition specific to this document type: if no row within the first 20 rows contains both "Customer ID" and "IPPIS" headers, the entire batch fails immediately (not a per-row skip) — this indicates the uploaded file isn't a recognizable Disbursed Loans Report at all, not a data-quality issue with individual rows.
