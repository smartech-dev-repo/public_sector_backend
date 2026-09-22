# Client Onboarding IPPIS-Sourced Fields Implementation Plan (Sub-project C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy `employeeStatus`/`legacyId` from `IppisRecord` onto `ClientOnboarding` at link time, and surface a computed length-of-service (from `hireDate`) in both the client status endpoint and the admin client view.

**Architecture:** Two new nullable scalar columns on `ClientOnboarding`, copied in `ClientOnboardingService.linkIppis` alongside the four fields it already copies. A new pure `computeLengthOfService()` util, consumed by both `ClientOnboardingService.getStatus` and `AdminClientReviewService.findById` (both widened to include the `ippisRecord` relation needed for `hireDate`).

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-22-client-onboarding-ippis-fields-design.md`

## Global Constraints

- "Command ID" is explicitly out of scope for this plan — deferred pending clarification of whether it's the existing `staffId` or something else entirely (spec §1).
- Marital-status auto-population from IPPIS is explicitly out of scope for this plan — it belongs to Sub-project B, not yet spec'd (spec §1).
- `employeeStatus`/`legacyId` are copied at `linkIppis` time, the same snapshot pattern already used for `employeeName`/`agency`/`bankName`/`accountNumber` — not read live via the relation (spec §2).
- `computeLengthOfService` is a pure function, not stored — computed at read time in both `getStatus` and `findById` (spec §3).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task. This spec is a standalone, single-plan initiative — its own final task runs the one genuine full-suite check.
- **File-conflict note for whoever executes this**: Sub-project A (Client Onboarding Document Collection) may have a background task still running against `test/*onboarding*.e2e-spec.ts`, `README.md`, and `postman/public-sector-backend.postman_collection.json` at the same time this plan starts. Tasks 1-4 of this plan touch none of those three files, so they're safe to run concurrently with Sub-project A's own closing task — but this plan's own Task 5 touches all three, so it must not start until Sub-project A's closing task has finished and committed, to avoid a concurrent-edit conflict on the same files.

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `ClientOnboarding.employeeStatus`, `ClientOnboarding.legacyId` — Task 3 depends on these exact names.

- [ ] **Step 1: Add the fields**

In `prisma/schema.prisma`, add to the existing `ClientOnboarding` model (alongside the existing `employeeName`/`agency`/`bankName`/`accountNumber`):

```prisma
  employeeStatus String?
  legacyId       String?
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_client_onboarding_ippis_snapshot_fields`
Expected: creates and applies `prisma/migrations/<timestamp>_add_client_onboarding_ippis_snapshot_fields/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add employeeStatus and legacyId to ClientOnboarding"
```

---

### Task 2: `computeLengthOfService`

**Files:**
- Create: `src/client-onboarding/length-of-service.util.ts`
- Test: `src/client-onboarding/length-of-service.util.spec.ts`

**Interfaces:**
- Produces: `interface LengthOfService { years: number; months: number }`, `computeLengthOfService(hireDate: Date | null): LengthOfService | null` — Task 3's `ClientOnboardingService.getStatus` and Task 4's `AdminClientReviewService.findById` both consume this.

- [ ] **Step 1: Write the failing tests**

`src/client-onboarding/length-of-service.util.spec.ts`:

```typescript
import { computeLengthOfService } from './length-of-service.util';

describe('computeLengthOfService', () => {
  it('returns null when hireDate is null', () => {
    expect(computeLengthOfService(null)).toBeNull();
  });

  it('computes exact years and months when the day-of-month has already passed this month', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 2, now.getMonth() - 3, 1);
    // 1st of the month has definitely already passed by "now" (whatever today's date is),
    // so this is exactly 2 years and 3 months with no rollback needed.
    expect(computeLengthOfService(hireDate)).toEqual({ years: 2, months: 3 });
  });

  it('rolls back one month when the hire day-of-month has not yet occurred this month', () => {
    const now = new Date();
    const farFutureDay = 28;
    // Guard against a short month edge case (e.g. February) by only running this specific
    // assertion when "now" is unambiguously before the 28th — otherwise skip, since the
    // rollback behavior is already exercised by the exact-boundary test above either way.
    if (now.getDate() < farFutureDay) {
      // Same month, one year back: naive count is exactly 12 (1 year, 0 months), which the
      // day-of-month rollback then pulls back to 11 (0 years, 11 months).
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), farFutureDay);
      expect(computeLengthOfService(hireDate)).toEqual({ years: 0, months: 11 });
    }
  });

  it('rolls a full 12 months over into an extra year', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 3, now.getMonth(), 1);
    expect(computeLengthOfService(hireDate)).toEqual({ years: 3, months: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/length-of-service.util.spec.ts`
Expected: FAIL — `Cannot find module './length-of-service.util'`.

- [ ] **Step 3: Implement `computeLengthOfService`**

`src/client-onboarding/length-of-service.util.ts`:

```typescript
export interface LengthOfService {
  years: number;
  months: number;
}

export function computeLengthOfService(hireDate: Date | null): LengthOfService | null {
  if (!hireDate) {
    return null;
  }
  const now = new Date();
  let months = (now.getFullYear() - hireDate.getFullYear()) * 12 + (now.getMonth() - hireDate.getMonth());
  if (now.getDate() < hireDate.getDate()) {
    months -= 1;
  }
  return { years: Math.floor(months / 12), months: months % 12 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/length-of-service.util.spec.ts`
Expected: PASS — 4 tests (one of which may be a no-op skip on days 28-31 of the month it runs, per its own guard — that's expected, not a failure).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client-onboarding/length-of-service.util.ts src/client-onboarding/length-of-service.util.spec.ts
git commit -m "feat: add computeLengthOfService"
```

---

### Task 3: `linkIppis` snapshot fields and `getStatus`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`

**Interfaces:**
- Consumes: `computeLengthOfService` (Task 2).
- Produces: `ClientOnboardingService.getStatus`'s response gains a `lengthOfService: LengthOfService | null` field.

- [ ] **Step 1: Write the failing tests**

Read `src/client-onboarding/client-onboarding.service.spec.ts`'s current full state first (as modified by the Document Collection plan — it now has `determineStepAfterIdentity`/`uploadDocument` blocks too). Update the existing `linkIppis` describe block's two success tests (`'creates a ClientOnboarding row pulling the matched IppisRecord fields'` and `'sets Client.status to PENDING_IPPIS once linked'`) — both currently mock `prisma.ippisRecord.findFirst` without `employeeStatus`/`legacyId`. Add those two fields to the mocked `IppisRecord` object in both tests:

```typescript
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
      });
```

Update the first test's assertion to also expect the two new fields being passed to `create`:

```typescript
      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          employeeName: 'Jane Doe',
          agency: 'NPF',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          employeeStatus: 'ACTIVE',
          legacyId: 'LEGACY-001',
          step: 'IPPIS_LINKED',
        }),
      });
```

Append a new `describe('getStatus', ...)` extension — read the existing single test in that block first (`'returns PHONE_VERIFIED when no onboarding row exists yet'`), then add:

```typescript
    it('returns a null lengthOfService when there is no onboarding row yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.lengthOfService).toBeNull();
    });

    it('computes lengthOfService from the linked IppisRecord\'s hireDate', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 2, now.getMonth(), 1);
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'COMPLETED',
        ippisRecord: { hireDate },
      });

      const result = await service.getStatus('client-1');

      expect(prisma.clientOnboarding.findUnique).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        include: { ippisRecord: true },
      });
      expect(result.lengthOfService).toEqual({ years: 2, months: 0 });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: FAIL — the updated `linkIppis` assertions won't match (fields not yet copied), and `result.lengthOfService` will be `undefined`, not matching the new assertions.

- [ ] **Step 3: Implement the changes**

In `src/client-onboarding/client-onboarding.service.ts`, add `import { computeLengthOfService } from './length-of-service.util';`.

In `linkIppis`, add the two fields to the `create` call's `data` (alongside the existing four):

```typescript
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });
```

Replace `getStatus`:

```typescript
  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding,
      lengthOfService: computeLengthOfService(onboarding?.ippisRecord?.hireDate ?? null),
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step (this task added 2 new `getStatus` tests on top of the file's pre-existing count, and modified 2 existing `linkIppis` tests in place rather than adding new ones there).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat: copy employeeStatus/legacyId at link time and surface lengthOfService in getStatus"
```

---

### Task 4: Admin `findById` — `lengthOfService`

**Files:**
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: `computeLengthOfService` (Task 2).
- Produces: `AdminClientReviewService.findById`'s response gains `onboarding.lengthOfService: LengthOfService | null` when an onboarding record exists.

- [ ] **Step 1: Write the failing test**

Read `src/admin-client-review/admin-client-review.service.spec.ts`'s current full state first (as modified by the Document Collection plan's Tasks 3-4 — `findById` now resolves signed document URLs too). Append this test to the existing `describe('findById', ...)` block:

```typescript
    it('includes a computed lengthOfService from the linked IppisRecord', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', ippisRecord: { hireDate } },
      });

      const result = await service.findById('c1');

      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: { onboarding: { include: { documents: true, ippisRecord: true } } },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — the `include` shape doesn't match yet (missing `ippisRecord: true`), and `result.onboarding.lengthOfService` is `undefined`.

- [ ] **Step 3: Implement the change**

In `src/admin-client-review/admin-client-review.service.ts`, add `import { computeLengthOfService } from '../client-onboarding/length-of-service.util';`. Update `findById`'s `include` and the returned shape:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true, ippisRecord: true } } },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (client.onboarding) {
      const documents = await Promise.all(
        (client.onboarding.documents ?? []).map(async (document) => ({
          documentType: document.documentType,
          url: await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey),
          uploadedAt: document.uploadedAt,
        })),
      );
      const lengthOfService = computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null);
      return { ...client, onboarding: { ...client.onboarding, documents, lengthOfService } };
    }

    return client;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks (this task added 1 new test). The pre-existing document-resolution test (added by the Document Collection plan's Task 4) must still pass unchanged — its mocked `onboarding` object doesn't include `ippisRecord`, so `client.onboarding.ippisRecord?.hireDate ?? null` correctly resolves to `null` via optional chaining, giving `lengthOfService: null` for that test without needing to touch it.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: surface lengthOfService in admin client view"
```

---

### Task 5: e2e tests, README, Postman, and the full suite run

**Files:**
- Modify: the client-onboarding e2e spec (find via `find test -iname "*onboarding*"`)
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

**Do not start this task until Sub-project A's (Client Onboarding Document Collection) own closing task has finished and committed** — both plans' closing tasks touch the same e2e spec file, `README.md`, and Postman collection, and running them concurrently risks a lost-update conflict. Check `git log --oneline -5` first; Sub-project A's closing commit message is `"feat: add client onboarding document collection e2e coverage and docs"` — confirm that commit (or a later one) is already present before proceeding.

This is the last task of this plan's own single-spec initiative — per this plan's Global Constraints, Step 6 below is a genuine full-suite run.

- [ ] **Step 1: Extend the e2e test**

Read the client-onboarding e2e spec's current full state first (it now includes the Document Collection plan's additions). In the fixture that seeds an `IppisRecord` for the full-pipeline test, add `employeeStatus`/`legacyId` values, e.g.:

```typescript
      data: { agency, staffId, employeeName: 'E2E Onboarding Test', salary: 1000000, hireDate: new Date(2020, 0, 1), employeeStatus: 'ACTIVE', legacyId: 'LEGACY-E2E-001' },
```

After the `ippis-link` step, assert `GET /client/onboarding/status` reflects these on the onboarding object and returns a non-null `lengthOfService` with a plausible `years` value (e.g. `expect(res.body.lengthOfService.years).toBeGreaterThanOrEqual(5)` given the `2020` hire date). After the pipeline reaches `COMPLETED`, assert `GET /admin/clients/:id` (admin JWT) also returns `onboarding.employeeStatus`/`onboarding.legacyId` matching the fixture, and a non-null `onboarding.lengthOfService`.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json <the e2e spec file> --runInBand`
Expected: PASS.

- [ ] **Step 3: Update the README**

Find the existing client-onboarding documentation section in `README.md` (already extended by the Document Collection plan) and add a note that `employeeStatus`/`legacyId` are now copied onto the onboarding record at link time, and that both `GET /client/onboarding/status` and `GET /admin/clients/:id` now include a computed `lengthOfService: { years, months } | null`, derived from the linked `IppisRecord`'s `hireDate`.

- [ ] **Step 4: Update Postman**

Update the existing `GET /client/onboarding/status` and `GET /admin/clients/:id` saved response examples to include `employeeStatus`/`legacyId` (on the onboarding object) and the new `lengthOfService` field — no new endpoints, so no new requests, just updated examples. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Commit**

```bash
git add test/*onboarding*.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add IPPIS-sourced fields e2e coverage and docs"
```

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness (confirmed benign multiple times in this codebase already) rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] Step 7's full unit + e2e suite run passes clean.
- [ ] `linkIppis` copies `employeeStatus`/`legacyId` from the matched `IppisRecord`.
- [ ] `GET /client/onboarding/status` and `GET /admin/clients/:id` both return a correctly computed `lengthOfService`, `null` when there's no linked `IppisRecord`.
- [ ] Postman's existing examples for both endpoints reflect the new fields.
