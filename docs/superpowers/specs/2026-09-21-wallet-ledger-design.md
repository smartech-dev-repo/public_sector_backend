# Wallet & Ledger Design

## 1. Purpose

The first of two sub-projects from a broader loan-lifecycle overhaul (the
second, not yet designed, evolves `LoanRequest` into a single-active-loan
model with topup/repayment, and will apply overpayment excess to this
wallet and let a client spend their wallet balance toward a payment). This
sub-project builds the wallet/ledger subsystem on its own: a per-client
balance, an auditable transaction history, and admin tooling to credit or
debit it with a description. It is deliberately self-contained — it has no
dependency on the not-yet-designed loan lifecycle work, and is fully
testable on its own via the admin credit/debit endpoints.

## 2. Data model

A single new table, `WalletEntry`, keyed directly to `Client` — there is no
separate `Wallet` model, since there's no wallet-level metadata needed yet
(YAGNI). A client's balance is always the sum of their entries, never
stored as its own field, so it cannot drift out of sync with the history
that produced it.

```prisma
enum WalletEntryDirection {
  CREDIT
  DEBIT
}

model WalletEntry {
  id          String               @id @default(uuid())
  clientId    String
  client      Client               @relation(fields: [clientId], references: [id])
  amount      Decimal
  direction   WalletEntryDirection
  description String
  actorType   AuditActorType
  actorId     String?
  createdAt   DateTime             @default(now())

  @@index([clientId])
}
```

`actorType` reuses the existing `AuditActorType` enum (`ADMIN` / `AGENT` /
`CLIENT` / `SYSTEM`) rather than introducing a parallel one — only `ADMIN`
is produced by this sub-project (`actorId` is the `AdminUser.id` who acted).
`SYSTEM` and `CLIENT` are reserved for the loan-lifecycle sub-project
(automatic overpayment credit, and a client spending their own balance).

`amount` is always positive; `direction` carries the sign. Balance for a
client is `SUM(amount WHERE direction = CREDIT) - SUM(amount WHERE
direction = DEBIT)`.

## 3. Balance and debit validation

A debit is rejected — `422`, following this codebase's existing convention
for a well-formed request that fails a business rule (e.g. loan-request
eligibility) — if `amount` would take the computed balance below zero.
This means every debit recomputes the current balance first, then checks
`amount <= currentBalance` before writing the new `WalletEntry` row. There
is no negative-balance state in this system.

A credit has no upper bound check (a client's wallet can hold an
arbitrary positive balance).

Both `amount` values must be a positive number (`> 0`) and `description` a
required non-empty string — validated via a `class-validator` DTO before
either handler runs.

## 4. Endpoints

- **`GET /client/wallet`** (Client JWT) — the calling client's own
  `{ balance: number, entries: WalletEntry[] }`, entries ordered newest
  first. A client with no entries yet gets `{ balance: 0, entries: [] }`,
  not an error — matches this codebase's established "empty, not 404"
  convention for a client's own financial/history data (e.g.
  `GET /client/loans`).
- **`GET /admin/clients/:clientId/wallet`** (Admin JWT, new `wallets:read`
  permission) — same shape, for any client. `404` if `clientId` doesn't
  exist.
- **`POST /admin/clients/:clientId/wallet/credit`** (Admin JWT, new
  `wallets:manage` permission) — body `{ amount, description }`. Creates a
  `CREDIT` entry with `actorType: ADMIN`, `actorId` = the calling admin.
- **`POST /admin/clients/:clientId/wallet/debit`** (Admin JWT,
  `wallets:manage`) — body `{ amount, description }`. Creates a `DEBIT`
  entry the same way, subject to the balance-floor check in §3 (`422` if
  it would go negative).

Both admin mutations are recorded through the existing `AuditLogService`/
`AuditInterceptor` (`AuditActorType.ADMIN`, the calling admin's id, the
target client's id) — the same mechanism already used for every other
sensitive admin action on a client (e.g. approve/reject in
`AdminClientReviewController`), since a wallet credit/debit is exactly
that kind of action.

Two new permission keys, following this codebase's `<resource>:<action>`
convention (seeded in `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS`):
`wallets:read` ("View a client's wallet balance and entries") and
`wallets:manage` ("Credit or debit a client's wallet").

## 5. Module structure

A new `src/wallet/` module:
- `wallet.service.ts` — `WalletService` with `getBalance(clientId)`,
  `credit(clientId, amount, description, actor)`,
  `debit(clientId, amount, description, actor)` (`actor` is
  `{ actorType: AuditActorType; actorId?: string }`, so the loan-lifecycle
  sub-project can later call `credit()` with `actorType: SYSTEM` for
  automatic overpayment crediting without any change to this service).
- `client-wallet.controller.ts` — `GET /client/wallet`.
- `admin-wallet.controller.ts` — the two admin routes under
  `admin/clients/:clientId/wallet`, mirroring
  `AdminClientReviewController`'s guard/interceptor stack
  (`JwtAuthGuard`, `PermissionsGuard`, `AuditInterceptor`).
- `wallet.module.ts` — wires the above; registered in `app.module.ts`.

## 6. Testing

- Unit tests for `WalletService`: balance computed correctly from a mix of
  credits/debits; credit always succeeds; debit succeeds when within
  balance; debit rejected (without writing a row) when it would go
  negative; a client with zero entries has balance `0`.
- e2e tests: client views their own empty wallet, then after an admin
  credit sees the updated balance and entry; admin debit within balance
  succeeds and reduces the balance; admin debit beyond balance returns
  `422` and leaves the balance unchanged; both mutations produce an
  `AuditLog` row; permission-denied (`403`) for an admin without
  `wallets:manage` attempting credit/debit, and without `wallets:read`
  attempting the view endpoint.

## 7. Postman

Per this repo's `CLAUDE.md`, new Postman coverage under a new **Wallet**
sub-folder: under **Client** for `GET /client/wallet`, and under **Admin**
for the two `admin/clients/:clientId/wallet/...` mutations plus the admin
view endpoint (grouped with **Client Review**, since both concern an
Admin acting on a specific client — see `postman/README.md`'s folder
structure rationale). Each request needs a saved response example,
including the `422` over-debit case and a `403` permission-denied case.
