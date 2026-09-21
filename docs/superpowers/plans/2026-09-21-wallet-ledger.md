# Wallet & Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every client a wallet backed by an append-only ledger — a client can view their own balance and history, and an admin can view any client's wallet and credit/debit it with a required description.

**Architecture:** A single new `WalletEntry` table keyed directly to `Client` (no separate `Wallet` model — balance is always derived from summing entries). A new `src/wallet/` module: `WalletService` (the only place balance/entries logic lives), a client-facing controller (`GET /client/wallet`) and an admin-facing controller (`GET`/`POST credit`/`POST debit` under `admin/clients/:clientId/wallet`), reusing the existing `AuditLogService`/`AuditInterceptor` for admin action logging exactly like `AdminClientReviewController` already does.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-21-wallet-ledger-design.md`

## Global Constraints

- Balance is always derived (`SUM(CREDIT) - SUM(DEBIT)`), never stored as its own field (spec §2).
- `WalletEntry.actorType` reuses the existing `AuditActorType` enum — no new parallel enum (spec §2).
- A debit that would take the balance below zero is rejected with `422` (`UnprocessableEntityException`, this codebase's existing convention for a business-rule failure — see `src/loan-request/loan-request.service.ts`); the balance never goes negative (spec §3).
- `amount` must be a positive number (`> 0`) on both credit and debit; `description` is required and non-empty — enforced by a shared DTO (spec §3).
- A client with no entries yet gets `{ balance: 0, entries: [] }`, never an error (spec §4).
- Both admin mutations are recorded via `AuditLogService.record()` with `actorType: ADMIN`, in addition to the automatic baseline `AuditInterceptor` logging every mutating admin request already gets (spec §4).
- Two new permission keys added to `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS`, following the existing `<resource>:<action>` naming convention: `wallets:read`, `wallets:manage` (spec §4).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task, not the full suite — save full unit+e2e runs for the very end of this plan.

---

### Task 1: Schema and permissions

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: `WalletEntryDirection` enum (`CREDIT`/`DEBIT`), `WalletEntry` model (`id`, `clientId`, `amount`, `direction`, `description`, `actorType`, `actorId`, `createdAt`) — every later task depends on these exact field names. Permission keys `wallets:read`/`wallets:manage`, consumed by Task 3's controller.

- [ ] **Step 1: Add the schema**

In `prisma/schema.prisma`, add this enum and model (near `RepaymentVariance`/`VarianceStatus`, or any top-level location — Prisma doesn't require declaration order):

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

Add the inverse relation to the existing `Client` model (alongside its existing `onboarding`/`loanRequests` fields):

```prisma
  walletEntries WalletEntry[]
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_wallet_entry`
Expected: creates and applies `prisma/migrations/<timestamp>_add_wallet_entry/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Add the permission keys**

In `prisma/seed.ts`, add to `BOOTSTRAP_PERMISSIONS` (after the existing `reconciliation:read` entry):

```typescript
  { key: 'wallets:read', description: "View a client's wallet balance and entries" },
  { key: 'wallets:manage', description: "Credit or debit a client's wallet" },
```

- [ ] **Step 5: Apply the new permissions**

Run: `npx prisma db seed`
Expected: completes without error (the bootstrap `SUPER_ADMIN` role picks up both new permissions automatically, since seeding grants every existing `Permission` row to it).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts
git commit -m "feat: add WalletEntry schema and wallets:read/wallets:manage permissions"
```

---

### Task 2: `WalletService`

**Files:**
- Create: `src/wallet/wallet.service.ts`
- Test: `src/wallet/wallet.service.spec.ts`

**Interfaces:**
- Consumes: `WalletEntry`/`WalletEntryDirection`/`AuditActorType` (Task 1).
- Produces: `interface WalletActor { actorType: AuditActorType; actorId?: string }`, `WalletService.getWallet(clientId: string): Promise<{ balance: number; entries: WalletEntry[] }>`, `.credit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry>`, `.debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry>` — Task 3's controllers consume all three methods.

- [ ] **Step 1: Write the failing tests**

`src/wallet/wallet.service.spec.ts`:

```typescript
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, WalletEntryDirection } from '../generated/prisma/client';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    client: { findUnique: jest.Mock };
    walletEntry: { findMany: jest.Mock; create: jest.Mock };
  };

  const adminActor = { actorType: AuditActorType.ADMIN, actorId: 'admin-1' };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      walletEntry: { findMany: jest.fn(), create: jest.fn() },
    };
    service = new WalletService(prisma as unknown as PrismaService);
  });

  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance and empty entries for a client with no history', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);

      const result = await service.getWallet('client-1');

      expect(result).toEqual({ balance: 0, entries: [] });
    });

    it('sums credits and subtracts debits to compute the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ]);

      const result = await service.getWallet('client-1');

      expect(result.balance).toBe(3700);
    });
  });

  describe('credit', () => {
    it('creates a CREDIT entry with the given actor', async () => {
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-1' });

      await service.credit('client-1', 5000, 'Goodwill credit', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 5000,
          direction: WalletEntryDirection.CREDIT,
          description: 'Goodwill credit',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.credit('missing', 5000, 'x', adminActor)).rejects.toThrow(NotFoundException);
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('debit', () => {
    it('creates a DEBIT entry when the amount is within the current balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 5000, direction: WalletEntryDirection.CREDIT }]);
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-2' });

      await service.debit('client-1', 3000, 'Excess deduction', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 3000,
          direction: WalletEntryDirection.DEBIT,
          description: 'Excess deduction',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('rejects a debit that would take the balance below zero, without writing an entry', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 1000, direction: WalletEntryDirection.CREDIT }]);

      await expect(service.debit('client-1', 1500, 'Too much', adminActor)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.debit('missing', 100, 'x', adminActor)).rejects.toThrow(NotFoundException);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/wallet/wallet.service.spec.ts`
Expected: FAIL — `Cannot find module './wallet.service'`.

- [ ] **Step 3: Implement `WalletService`**

`src/wallet/wallet.service.ts`:

```typescript
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';

export interface WalletActor {
  actorType: AuditActorType;
  actorId?: string;
}

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getWallet(clientId: string): Promise<{ balance: number; entries: WalletEntry[] }> {
    await this.assertClientExists(clientId);

    const entries = await this.prisma.walletEntry.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    return { balance: this.sumEntries(entries), entries };
  }

  async credit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    await this.assertClientExists(clientId);

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.CREDIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  async debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    const { balance } = await this.getWallet(clientId);

    if (amount > balance) {
      throw new UnprocessableEntityException('Insufficient wallet balance');
    }

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.DEBIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
  }

  private sumEntries(entries: Array<{ amount: unknown; direction: WalletEntryDirection }>): number {
    return entries.reduce((total, entry) => {
      const amount = Number(entry.amount);
      return total + (entry.direction === WalletEntryDirection.CREDIT ? amount : -amount);
    }, 0);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/wallet/wallet.service.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/wallet/wallet.service.ts src/wallet/wallet.service.spec.ts
git commit -m "feat: add WalletService"
```

---

### Task 3: Controllers, DTO, and module wiring

**Files:**
- Create: `src/wallet/dto/wallet-transaction.dto.ts`
- Create: `src/wallet/client-wallet.controller.ts`
- Create: `src/wallet/admin-wallet.controller.ts`
- Create: `src/wallet/wallet.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `WalletService` (Task 2), `AuditModule`/`AuditLogService`/`AuditInterceptor` (already exist), `JwtAuthGuard`/`ClientOnlyGuard`/`PermissionsGuard`/`RequirePermissions` (already exist).
- Produces: `GET /client/wallet`, `GET /admin/clients/:clientId/wallet`, `POST /admin/clients/:clientId/wallet/credit`, `POST /admin/clients/:clientId/wallet/debit`.

- [ ] **Step 1: Add the DTO**

`src/wallet/dto/wallet-transaction.dto.ts`:

```typescript
import { IsNumber, IsPositive, IsString, MinLength } from 'class-validator';

export class WalletTransactionDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @MinLength(1)
  description: string;
}
```

- [ ] **Step 2: Add the client controller**

`src/wallet/client-wallet.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { WalletService } from './wallet.service';

@Controller('client/wallet')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientWalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  getWallet(@Req() req: { user: JwtPayload }) {
    return this.walletService.getWallet(req.user.sub);
  }
}
```

- [ ] **Step 3: Add the admin controller**

`src/wallet/admin-wallet.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';
import { WalletService } from './wallet.service';
import { WalletTransactionDto } from './dto/wallet-transaction.dto';

@Controller('admin/clients/:clientId/wallet')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminWalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('wallets:read')
  getWallet(@Param('clientId') clientId: string) {
    return this.walletService.getWallet(clientId);
  }

  @Post('credit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  async credit(
    @Param('clientId') clientId: string,
    @Body() dto: WalletTransactionDto,
    @Req() req: { user: JwtPayload },
  ) {
    const entry = await this.walletService.credit(clientId, dto.amount, dto.description, {
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
    });
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'wallet.credit',
      targetType: 'Client',
      targetId: clientId,
      metadata: { amount: dto.amount, description: dto.description },
    });
    return entry;
  }

  @Post('debit')
  @HttpCode(200)
  @RequirePermissions('wallets:manage')
  async debit(
    @Param('clientId') clientId: string,
    @Body() dto: WalletTransactionDto,
    @Req() req: { user: JwtPayload },
  ) {
    const entry = await this.walletService.debit(clientId, dto.amount, dto.description, {
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
    });
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'wallet.debit',
      targetType: 'Client',
      targetId: clientId,
      metadata: { amount: dto.amount, description: dto.description },
    });
    return entry;
  }
}
```

- [ ] **Step 4: Add the module and wire it into `AppModule`**

`src/wallet/wallet.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WalletService } from './wallet.service';
import { ClientWalletController } from './client-wallet.controller';
import { AdminWalletController } from './admin-wallet.controller';

@Module({
  imports: [AuditModule],
  controllers: [ClientWalletController, AdminWalletController],
  providers: [WalletService],
})
export class WalletModule {}
```

In `src/app.module.ts`, add the import:

```typescript
import { WalletModule } from './wallet/wallet.module';
```

And add `WalletModule` to the `imports` array, directly after `ClientLoansModule`.

- [ ] **Step 5: Type-check and run the wallet unit suite**

Run: `npx tsc --noEmit && npx jest src/wallet`
Expected: both clean — no type errors, `WalletService`'s 8 tests still pass (this task adds no new unit tests of its own; controllers in this codebase are verified via e2e — see Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/wallet/dto src/wallet/client-wallet.controller.ts src/wallet/admin-wallet.controller.ts src/wallet/wallet.module.ts src/app.module.ts
git commit -m "feat: add client/admin wallet controllers and module wiring"
```

---

### Task 4: e2e tests, README, and Postman

**Files:**
- Create: `test/wallet.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-3.

- [ ] **Step 1: Write the e2e test**

Read `test/admin-client-review.e2e-spec.ts` first for the admin-login/client-fixture pattern this mirrors (shown in this plan's own research above). `test/wallet.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Wallet (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let clientId: string;
  let clientAccessToken: string;
  const phone = `+234802${Date.now().toString().slice(-7)}`;

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
    adminAccessToken = loginRes.body.accessToken;

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;

    const tokenService = moduleFixture.get(TokenService);
    clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.walletEntry.deleteMany({ where: { clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns a zero balance and empty entries for a client with no wallet history', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/wallet')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .expect(200);

    expect(res.body).toEqual({ balance: 0, entries: [] });
  });

  it('lets an admin credit a client wallet, reflected on both the admin and client views', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 5000, description: 'Overpayment excess' })
      .expect(200);

    const adminView = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(adminView.body.balance).toBe(5000);
    expect(adminView.body.entries).toHaveLength(1);
    expect(adminView.body.entries[0].description).toBe('Overpayment excess');

    const clientView = await request(app.getHttpServer())
      .get('/client/wallet')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .expect(200);
    expect(clientView.body.balance).toBe(5000);
  });

  it('lets an admin debit within the balance, and rejects a debit beyond it with a 422', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/debit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 2000, description: 'Manual correction' })
      .expect(200);

    const afterDebit = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(afterDebit.body.balance).toBe(3000);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/debit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 999999, description: 'Too much' })
      .expect(422);

    const afterRejectedDebit = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(afterRejectedDebit.body.balance).toBe(3000);
  });

  it('rejects an invalid credit body with a 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: -5, description: '' })
      .expect(400);
  });

  it('returns 404 for a nonexistent client', async () => {
    await request(app.getHttpServer())
      .get('/admin/clients/00000000-0000-0000-0000-000000000000/wallet')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/client/wallet').expect(401);
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/wallet.e2e-spec.ts --runInBand`
Expected: PASS — 6 tests.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Client loan dashboard` section:

```markdown
## Wallet

Every client has a wallet backed by an append-only ledger of
`WalletEntry` rows — there is no separate `Wallet` model; the balance is
always the sum of a client's entries (`SUM(CREDIT) - SUM(DEBIT)`), so it
can never drift out of sync with its own history. `GET /client/wallet`
(Client JWT) returns the caller's own `{ balance, entries }`, empty/zero
if they have no history yet. Admins holding `wallets:read`/
`wallets:manage` can view any client's wallet
(`GET /admin/clients/:clientId/wallet`) and credit or debit it
(`POST .../wallet/credit`, `POST .../wallet/debit`, both `{ amount,
description }`) — a debit that would take the balance below zero is
rejected with `422`; the balance never goes negative. Both admin
mutations are recorded through the existing `AuditLogService`, the same
mechanism used for every other sensitive admin action on a client (e.g.
approve/reject in `AdminClientReviewController`). This is the first of
two sub-projects in a broader loan-lifecycle overhaul — a second,
not-yet-built piece will let overpayment on a loan auto-credit this same
wallet, and let a client spend their balance toward a payment.
```

- [ ] **Step 4: Add Postman coverage**

Create a new **Wallet** sub-folder: one request under **Client** (`GET /client/wallet - Success`), and three under **Admin** (grouped alongside **Client Review**, per this repo's `postman/README.md` folder-structure rationale — both concern an admin acting on a specific client): `GET /admin/clients/:clientId/wallet - Success`, `POST /admin/clients/:clientId/wallet/credit - Success`, `POST /admin/clients/:clientId/wallet/debit - Insufficient balance (422)`. Every request needs a saved response example authored from the actual controller/service/DTO code from Tasks 1-3 — not guessed. Use a surgical text-based/jq-based insert into the JSON, not a full rewrite (watch out for `ensure_ascii` re-escaping non-ASCII characters like em-dashes if using Python's `json` module — pass `ensure_ascii=False` and verify a no-op roundtrip first).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If a single pre-existing, unrelated suite times out under the full serialized run, re-run just that suite in isolation before treating it as a real regression — this repo has known environmental e2e flakiness under machine load.

- [ ] **Step 7: Commit**

```bash
git add test/wallet.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add wallet e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] A client can view their own wallet (empty by default), and an admin can view, credit, and debit any client's wallet with a required description — proven by unit and e2e tests.
- [ ] A debit beyond the current balance is rejected with `422` and never writes an entry — proven by unit and e2e tests.
- [ ] Balance is never stored — every read derives it fresh from `WalletEntry` rows.
- [ ] Both admin mutations produce an audit trail via the existing `AuditLogService`.
- [ ] Postman has coverage for all four endpoints, including the `422` case.
