# Client/IPPIS Onboarding Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a phone-verified `Client` through IPPIS linking, BVN/NIN identity verification, and face-match verification, to either auto-`VERIFIED` or `MANUAL_REVIEW`.

**Architecture:** A new `ClientOnboarding` model (one row per client, `step` field doubling as the resumability state machine). Two new pluggable-provider modules — `IdentityVerificationModule` (ordered-list dispatch, but only ever one *active* provider selected by `IDENTITY_VERIFICATION_PROVIDER` config, never blending mock and real — see Task 2's rationale) and `FaceVerificationModule` (single provider) — followed by a `ClientOnboardingModule` that orchestrates the four-step pipeline using both, plus the existing `FileStorageProvider` for photo storage.

**Tech Stack:** NestJS 10, Prisma 7, native `fetch` (Node 22, no new HTTP client dependency), Jest.

**Spec:** `docs/superpowers/specs/2026-09-17-client-onboarding-pipeline-design.md`

## Global Constraints

- `ClientOnboarding.bvn`/`.nin` are nullable at the DB level (`String?`) — they're only populated at the identity step, not at record creation (a correction from the spec's literal schema, caught during planning: the spec shows them as non-nullable, but `linkIppis` creates the row before either value exists).
- `identityVerified` requires `VERIFIED` only when **both** BVN and NIN lookups succeed; `faceMatchPassed` requires **both** the BVN-photo and NIN-photo comparisons to pass (spec §3, §4 — stricter than either-or).
- `IdentityVerificationProvider`/`FaceVerificationProvider` never blend mock and real implementations in the same active list — config selects exactly one active provider, so a real-vendor outage can never silently fall through to fabricated data (see Task 2).
- `DojahIdentityVerificationProvider` uses the **advance** tier: `GET /api/v1/kyc/bvn/advance` and `GET /api/v1/kyc/nin/advance`, headers `AppId`/`Authorization` (raw secret, not `Bearer`) — per Dojah's own docs, confirmed via `https://docs.dojah.io/api-reference/individual-verification/nigeria/`.
- Every automated test uses mock providers only — no real Dojah/face-verification network calls in unit or e2e tests, matching this repo's standing rule for every other external integration.
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints (Task 6).
- `IppisRecord`'s natural key is `(agency, staffId)`, not `staffId` alone, so the same Staff ID string could in principle exist under two different agencies. `linkIppis` looks up by `staffId` alone (`findFirst`, case-insensitive) since the client only knows their own IPPIS number, not which agency sheet it came from — an acknowledged, accepted ambiguity rather than a bug: real Staff IDs observed so far embed an agency-specific prefix (e.g. `NPF/1234`), making a genuine cross-agency collision unlikely in practice.

---

### Task 1: `ClientOnboarding` schema

**Files:**
- Modify: `prisma/schema.prisma` (add `OnboardingStep` enum, `ClientOnboarding` model, and reciprocal relation fields on `Client` and `IppisRecord`)

**Interfaces:**
- Produces: the `ClientOnboarding` Prisma model and `OnboardingStep` enum — every later task depends on these exact field names.

- [ ] **Step 1: Add the enum and model**

Add to `prisma/schema.prisma`, after the `IppisRecord` model:

```prisma
enum OnboardingStep {
  PHONE_VERIFIED
  IPPIS_LINKED
  IDENTITY_SUBMITTED
  FACE_MATCH_PENDING
  COMPLETED
}

model ClientOnboarding {
  id                String         @id @default(uuid())
  clientId          String         @unique
  client            Client         @relation(fields: [clientId], references: [id])
  ippisRecordId     String         @unique
  ippisRecord       IppisRecord    @relation(fields: [ippisRecordId], references: [id])
  employeeName      String
  agency            String
  bankName          String?
  accountNumber     String?
  bvn               String?
  nin               String?
  bvnSelfie         String?
  ninSelfie         String?
  liveSelfieKey     String?
  identityVerified  Boolean?
  faceMatchBvnScore Float?
  faceMatchNinScore Float?
  faceMatchPassed   Boolean?
  step              OnboardingStep @default(PHONE_VERIFIED)
  failureReasons    Json?
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
}
```

- [ ] **Step 2: Add the reciprocal relation fields**

Modify the existing `Client` model — add one field inside its braces:

```prisma
  onboarding ClientOnboarding?
```

Modify the existing `IppisRecord` model — add one field inside its braces:

```prisma
  clientOnboarding ClientOnboarding?
```

- [ ] **Step 3: Generate and run the migration**

Run: `npx prisma migrate dev --name add_client_onboarding`
Expected: creates and applies `prisma/migrations/<timestamp>_add_client_onboarding/migration.sql`.

- [ ] **Step 4: Explicitly regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 5: Verify the client regenerated correctly**

Run: `grep -n "ClientOnboardingModel\|OnboardingStep" src/generated/prisma/client.ts`
Expected: `export type ClientOnboarding = Prisma.ClientOnboardingModel` and an `OnboardingStep` export both appear.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ClientOnboarding model"
```

---

### Task 2: `IdentityVerificationProvider` interface, mock, and dispatcher

**Files:**
- Create: `src/identity-verification/identity-verification-provider.interface.ts`
- Create: `src/identity-verification/mock-identity-verification.provider.ts`
- Create: `src/identity-verification/identity-verification.service.ts`
- Test: `src/identity-verification/identity-verification.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IdentityVerificationProvider` interface, `IdentityLookupResult`, `IDENTITY_VERIFICATION_PROVIDERS` DI token, `MockIdentityVerificationProvider`, `IdentityVerificationService.lookupBvn(bvn): Promise<IdentityLookupResult>` / `.lookupNin(nin): Promise<IdentityLookupResult>` — Task 3 adds the real Dojah provider to this same interface; Task 5 consumes `IdentityVerificationService`.

**Design note on why this isn't a plain failover list**: the original spec's OTP/Email pattern assumes every provider in the list is a real, interchangeable delivery mechanism — falling through from one real vendor to another on failure is safe. Here, one of the two implementations (`MockIdentityVerificationProvider`) fabricates data. If both were ever in the same active list, a real Dojah outage would silently "verify" a client using made-up bio-data — a KYC pipeline must never do that. So `IDENTITY_VERIFICATION_PROVIDERS` keeps the *type* of an ordered list (for when a second real vendor is added later) but its *factory* (Task 3) always resolves to exactly one active provider, chosen by config, never both.

- [ ] **Step 1: Write the failing test**

`src/identity-verification/identity-verification.service.spec.ts`:

```typescript
import { InternalServerErrorException } from '@nestjs/common';
import { IdentityVerificationService } from './identity-verification.service';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

function fakeProvider(name: string, impl: Partial<IdentityVerificationProvider>): IdentityVerificationProvider {
  return {
    name,
    lookupBvn: impl.lookupBvn ?? jest.fn().mockRejectedValue(new Error('not implemented')),
    lookupNin: impl.lookupNin ?? jest.fn().mockRejectedValue(new Error('not implemented')),
  };
}

const sampleResult: IdentityLookupResult = {
  firstName: 'Jane',
  lastName: 'Doe',
  dateOfBirth: '1990-01-01',
  phoneNumber: '08000000000',
  photoBase64: 'ZmFrZS1waG90bw==',
};

describe('IdentityVerificationService', () => {
  it('returns the first provider\'s successful BVN lookup', async () => {
    const provider = fakeProvider('primary', { lookupBvn: jest.fn().mockResolvedValue(sampleResult) });
    const service = new IdentityVerificationService([provider]);

    const result = await service.lookupBvn('12345678901');
    expect(result).toEqual(sampleResult);
  });

  it('falls through to the next provider in the list on failure', async () => {
    const failing = fakeProvider('primary', { lookupNin: jest.fn().mockRejectedValue(new Error('timeout')) });
    const backup = fakeProvider('backup', { lookupNin: jest.fn().mockResolvedValue(sampleResult) });
    const service = new IdentityVerificationService([failing, backup]);

    const result = await service.lookupNin('12345678901');
    expect(result).toEqual(sampleResult);
  });

  it('throws once every provider has failed', async () => {
    const failing = fakeProvider('only', { lookupBvn: jest.fn().mockRejectedValue(new Error('down')) });
    const service = new IdentityVerificationService([failing]);

    await expect(service.lookupBvn('12345678901')).rejects.toThrow(InternalServerErrorException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/identity-verification/identity-verification.service.spec.ts`
Expected: FAIL — `Cannot find module './identity-verification.service'`

- [ ] **Step 3: Implement the interface, mock, and service**

`src/identity-verification/identity-verification-provider.interface.ts`:

```typescript
export const IDENTITY_VERIFICATION_PROVIDERS = Symbol('IDENTITY_VERIFICATION_PROVIDERS');

export interface IdentityLookupResult {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  photoBase64: string;
}

export interface IdentityVerificationProvider {
  readonly name: string;
  lookupBvn(bvn: string): Promise<IdentityLookupResult>;
  lookupNin(nin: string): Promise<IdentityLookupResult>;
}
```

`src/identity-verification/mock-identity-verification.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

const PLACEHOLDER_PHOTO_BASE64 = Buffer.from('mock-identity-photo').toString('base64');

@Injectable()
export class MockIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'mock';

  async lookupBvn(_bvn: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
    };
  }

  async lookupNin(_nin: string): Promise<IdentityLookupResult> {
    return {
      firstName: 'Test',
      lastName: 'Client',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: PLACEHOLDER_PHOTO_BASE64,
    };
  }
}
```

`src/identity-verification/identity-verification.service.ts`:

```typescript
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  IDENTITY_VERIFICATION_PROVIDERS,
  IdentityLookupResult,
  IdentityVerificationProvider,
} from './identity-verification-provider.interface';

@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger(IdentityVerificationService.name);

  constructor(
    @Inject(IDENTITY_VERIFICATION_PROVIDERS) private readonly providers: IdentityVerificationProvider[],
  ) {}

  async lookupBvn(bvn: string): Promise<IdentityLookupResult> {
    return this.withFailover((provider) => provider.lookupBvn(bvn), 'BVN');
  }

  async lookupNin(nin: string): Promise<IdentityLookupResult> {
    return this.withFailover((provider) => provider.lookupNin(nin), 'NIN');
  }

  private async withFailover(
    fn: (provider: IdentityVerificationProvider) => Promise<IdentityLookupResult>,
    label: string,
  ): Promise<IdentityLookupResult> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        return await fn(provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`${label} provider "${provider.name}" failed: ${message}`);
        failures.push(`${provider.name}: ${message}`);
      }
    }

    throw new InternalServerErrorException(`All ${label} providers failed: ${failures.join('; ')}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/identity-verification/identity-verification.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/identity-verification/identity-verification-provider.interface.ts src/identity-verification/mock-identity-verification.provider.ts src/identity-verification/identity-verification.service.ts src/identity-verification/identity-verification.service.spec.ts
git commit -m "feat: add IdentityVerificationService with mock provider"
```

---

### Task 3: `DojahIdentityVerificationProvider` + module wiring

**Files:**
- Create: `src/identity-verification/dojah-identity-verification.provider.ts`
- Test: `src/identity-verification/dojah-identity-verification.provider.spec.ts`
- Create: `src/identity-verification/identity-verification.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `IdentityVerificationProvider` (Task 2).
- Produces: `DojahIdentityVerificationProvider`, `IdentityVerificationModule` (exports `IdentityVerificationService`) — Task 5 imports this module.

- [ ] **Step 1: Write the failing test**

`src/identity-verification/dojah-identity-verification.provider.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { DojahIdentityVerificationProvider } from './dojah-identity-verification.provider';

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing config: ${key}`);
      return values[key];
    },
    get: (key: string, defaultValue?: string) => (key in values ? values[key] : defaultValue),
  } as unknown as ConfigService;
}

describe('DojahIdentityVerificationProvider', () => {
  const config = fakeConfig({ DOJAH_APP_ID: 'app-id', DOJAH_SECRET_KEY: 'secret' });
  let provider: DojahIdentityVerificationProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    provider = new DojahIdentityVerificationProvider(config);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('calls the advance BVN endpoint with the correct headers and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number1: '08000000000',
          image: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      phoneNumber: '08000000000',
      photoBase64: 'ZmFrZS1waG90bw==',
    });
  });

  it('calls the advance NIN endpoint and maps the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entity: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-01',
          phone_number: '08000000000',
          photo: 'ZmFrZS1waG90bw==',
        },
      }),
    });

    const result = await provider.lookupNin('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/nin/advance?nin=12345678901',
      { headers: { AppId: 'app-id', Authorization: 'secret' } },
    );
    expect(result.photoBase64).toBe('ZmFrZS1waG90bw==');
  });

  it('throws when Dojah returns a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(provider.lookupBvn('12345678901')).rejects.toThrow('404');
  });

  it('uses DOJAH_BASE_URL when set (e.g. production)', async () => {
    const prodConfig = fakeConfig({
      DOJAH_APP_ID: 'app-id',
      DOJAH_SECRET_KEY: 'secret',
      DOJAH_BASE_URL: 'https://api.dojah.io',
    });
    const prodProvider = new DojahIdentityVerificationProvider(prodConfig);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ entity: { first_name: 'A', last_name: 'B', date_of_birth: null, phone_number1: null, image: 'x' } }),
    });

    await prodProvider.lookupBvn('12345678901');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.dojah.io/api/v1/kyc/bvn/advance?bvn=12345678901',
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/identity-verification/dojah-identity-verification.provider.spec.ts`
Expected: FAIL — `Cannot find module './dojah-identity-verification.provider'`

- [ ] **Step 3: Implement `DojahIdentityVerificationProvider` and the module**

`src/identity-verification/dojah-identity-verification.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityLookupResult, IdentityVerificationProvider } from './identity-verification-provider.interface';

interface DojahBvnEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number1: string | null;
  image: string;
}

interface DojahNinEntity {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone_number: string | null;
  photo: string;
}

@Injectable()
export class DojahIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'dojah';

  constructor(private readonly configService: ConfigService) {}

  private baseUrl(): string {
    return this.configService.get<string>('DOJAH_BASE_URL', 'https://sandbox.dojah.io');
  }

  // Credentials are read lazily (on first use), not in the constructor —
  // same reasoning as every other lazy-init provider in this codebase
  // (S3FileStorageProvider, GcsFileStorageProvider): this provider is
  // always constructed for DI purposes, but shouldn't break app startup
  // when it isn't the active provider (see identity-verification.module.ts).
  private headers(): Record<string, string> {
    return {
      AppId: this.configService.getOrThrow<string>('DOJAH_APP_ID'),
      Authorization: this.configService.getOrThrow<string>('DOJAH_SECRET_KEY'),
    };
  }

  async lookupBvn(bvn: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/bvn/advance?bvn=${encodeURIComponent(bvn)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah BVN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahBvnEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number1,
      photoBase64: body.entity.image,
    };
  }

  async lookupNin(nin: string): Promise<IdentityLookupResult> {
    const response = await fetch(`${this.baseUrl()}/api/v1/kyc/nin/advance?nin=${encodeURIComponent(nin)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Dojah NIN lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as { entity: DojahNinEntity };
    return {
      firstName: body.entity.first_name,
      lastName: body.entity.last_name,
      dateOfBirth: body.entity.date_of_birth,
      phoneNumber: body.entity.phone_number,
      photoBase64: body.entity.photo,
    };
  }
}
```

`src/identity-verification/identity-verification.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityVerificationService } from './identity-verification.service';
import { MockIdentityVerificationProvider } from './mock-identity-verification.provider';
import { DojahIdentityVerificationProvider } from './dojah-identity-verification.provider';
import { IDENTITY_VERIFICATION_PROVIDERS } from './identity-verification-provider.interface';

@Module({
  providers: [
    IdentityVerificationService,
    MockIdentityVerificationProvider,
    DojahIdentityVerificationProvider,
    {
      provide: IDENTITY_VERIFICATION_PROVIDERS,
      // Exactly one active provider, chosen by config — never both in the
      // same list. See Task 2's design note: blending mock and real here
      // would risk silently "verifying" a client with fabricated data if
      // the real vendor ever failed.
      useFactory: (
        configService: ConfigService,
        mock: MockIdentityVerificationProvider,
        dojah: DojahIdentityVerificationProvider,
      ) => {
        const selected = configService.get<string>('IDENTITY_VERIFICATION_PROVIDER', 'mock');
        return selected === 'dojah' ? [dojah] : [mock];
      },
      inject: [ConfigService, MockIdentityVerificationProvider, DojahIdentityVerificationProvider],
    },
  ],
  exports: [IdentityVerificationService],
})
export class IdentityVerificationModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/identity-verification/dojah-identity-verification.provider.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Document the new env vars**

Add to `.env.example`:

```
# mock | dojah — mock is the safe default; never mixes with dojah in the
# same active list (a real-vendor outage must never silently fall back to
# fabricated identity data).
IDENTITY_VERIFICATION_PROVIDER=mock
DOJAH_APP_ID=
DOJAH_SECRET_KEY=
# https://sandbox.dojah.io for testing, https://api.dojah.io for production
DOJAH_BASE_URL=https://sandbox.dojah.io
```

- [ ] **Step 6: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/identity-verification/dojah-identity-verification.provider.ts src/identity-verification/dojah-identity-verification.provider.spec.ts src/identity-verification/identity-verification.module.ts .env.example
git commit -m "feat: add DojahIdentityVerificationProvider"
```

---

### Task 4: `FaceVerificationProvider` interface, mock, and module

**Files:**
- Create: `src/face-verification/face-verification-provider.interface.ts`
- Create: `src/face-verification/mock-face-verification.provider.ts`
- Test: `src/face-verification/mock-face-verification.provider.spec.ts`
- Create: `src/face-verification/face-verification.module.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FaceVerificationProvider` interface, `FaceMatchResult`, `FACE_VERIFICATION_PROVIDER` DI token, `MockFaceVerificationProvider`, `FaceVerificationModule` (exports the token) — Task 5 injects `FACE_VERIFICATION_PROVIDER` directly (no wrapping service — single-provider, matching `FileStorageProvider`'s own no-wrapper precedent, since there's no failover to dispatch).

- [ ] **Step 1: Write the failing test**

`src/face-verification/mock-face-verification.provider.spec.ts`:

```typescript
import { MockFaceVerificationProvider } from './mock-face-verification.provider';

describe('MockFaceVerificationProvider', () => {
  it('returns a passing match for any pair of keys', async () => {
    const provider = new MockFaceVerificationProvider();
    const result = await provider.compare('reference-key', 'candidate-key');
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/face-verification/mock-face-verification.provider.spec.ts`
Expected: FAIL — `Cannot find module './mock-face-verification.provider'`

- [ ] **Step 3: Implement the interface, mock, and module**

`src/face-verification/face-verification-provider.interface.ts`:

```typescript
export const FACE_VERIFICATION_PROVIDER = Symbol('FACE_VERIFICATION_PROVIDER');

export interface FaceMatchResult {
  score: number;
  passed: boolean;
}

export interface FaceVerificationProvider {
  compare(referencePhotoKey: string, candidatePhotoKey: string): Promise<FaceMatchResult>;
}
```

`src/face-verification/mock-face-verification.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { FaceMatchResult, FaceVerificationProvider } from './face-verification-provider.interface';

@Injectable()
export class MockFaceVerificationProvider implements FaceVerificationProvider {
  async compare(_referencePhotoKey: string, _candidatePhotoKey: string): Promise<FaceMatchResult> {
    return { score: 0.95, passed: true };
  }
}
```

`src/face-verification/face-verification.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MockFaceVerificationProvider } from './mock-face-verification.provider';
import { FACE_VERIFICATION_PROVIDER } from './face-verification-provider.interface';

@Module({
  providers: [
    MockFaceVerificationProvider,
    // Single-provider for now (per the original spec — no second vendor
    // exists yet), so this binds directly rather than through a
    // config-driven factory. Swapping in a real implementation later is a
    // one-line change here plus a new provider class, no other code changes.
    { provide: FACE_VERIFICATION_PROVIDER, useExisting: MockFaceVerificationProvider },
  ],
  exports: [FACE_VERIFICATION_PROVIDER],
})
export class FaceVerificationModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/face-verification/mock-face-verification.provider.spec.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/face-verification/
git commit -m "feat: add FaceVerificationProvider with mock implementation"
```

---

### Task 5: `ClientOnlyGuard` and `ClientOnboardingService`

**Files:**
- Create: `src/auth/client-only.guard.ts`
- Test: `src/auth/client-only.guard.spec.ts`
- Create: `src/client-onboarding/client-onboarding.service.ts`
- Test: `src/client-onboarding/client-onboarding.service.spec.ts`

**Interfaces:**
- Consumes: `IdentityVerificationService` (Task 2/3), `FACE_VERIFICATION_PROVIDER` (Task 4), `FILE_STORAGE_PROVIDER` (existing), `PrismaService`.
- Produces: `ClientOnlyGuard`, `ClientOnboardingService.linkIppis(clientId, ippisNumber)`, `.submitIdentity(clientId, bvn, nin)`, `.submitFaceMatch(clientId, selfieBuffer)`, `.getStatus(clientId)` — Task 6's controller consumes all four.

- [ ] **Step 1: Write the failing test for `ClientOnlyGuard`**

`src/auth/client-only.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ClientOnlyGuard } from './client-only.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('ClientOnlyGuard', () => {
  const guard = new ClientOnlyGuard();

  it('allows a client-type principal', () => {
    expect(guard.canActivate(contextWithUser({ type: 'client', sub: 'c1' }))).toBe(true);
  });

  it('rejects a non-client principal', () => {
    expect(() => guard.canActivate(contextWithUser({ type: 'admin', sub: 'a1' }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request', () => {
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/client-only.guard.spec.ts`
Expected: FAIL — `Cannot find module './client-only.guard'`

- [ ] **Step 3: Implement `ClientOnlyGuard`**

`src/auth/client-only.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class ClientOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (request.user?.type !== 'client') {
      throw new ForbiddenException('This endpoint is only available to Client accounts');
    }
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/client-only.guard.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing tests for `ClientOnboardingService`**

`src/client-onboarding/client-onboarding.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClientOnboardingService } from './client-onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FaceVerificationProvider } from '../face-verification/face-verification-provider.interface';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('ClientOnboardingService', () => {
  let service: ClientOnboardingService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    ippisRecord: { findFirst: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
  };
  let identityVerificationService: { lookupBvn: jest.Mock; lookupNin: jest.Mock };
  let faceVerificationProvider: { compare: jest.Mock };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      ippisRecord: { findFirst: jest.fn() },
      client: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    identityVerificationService = { lookupBvn: jest.fn(), lookupNin: jest.fn() };
    faceVerificationProvider = { compare: jest.fn() };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };

    service = new ClientOnboardingService(
      prisma as unknown as PrismaService,
      identityVerificationService as unknown as IdentityVerificationService,
      faceVerificationProvider as unknown as FaceVerificationProvider,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('linkIppis', () => {
    it('rejects when onboarding already started for this client', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the IPPIS number is not found', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(NotFoundException);
    });

    it('rejects when the IPPIS record is already linked to another client', async () => {
      prisma.clientOnboarding.findUnique
        .mockResolvedValueOnce(null) // no existing onboarding for this client
        .mockResolvedValueOnce({ id: 'other' }); // already linked to someone else
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', employeeName: 'X', agency: 'NPF' });
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(ConflictException);
    });

    it('creates a ClientOnboarding row pulling the matched IppisRecord fields', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.linkIppis('client-1', 'NPF/1');

      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          employeeName: 'Jane Doe',
          agency: 'NPF',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          step: 'IPPIS_LINKED',
        }),
      });
    });
  });

  describe('submitIdentity', () => {
    it('rejects when the client has no onboarding row yet', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.submitIdentity('client-1', '12345678901', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client is not at the IPPIS_LINKED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IDENTITY_SUBMITTED' });
      await expect(service.submitIdentity('client-1', '12345678901', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('looks up BVN and NIN, stores both photos, and marks identityVerified', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'YnZuLXBob3Rv',
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'bmluLXBob3Rv',
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitIdentity('client-1', '12345678901', '98765432109');

      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          bvn: '12345678901',
          nin: '98765432109',
          identityVerified: true,
          step: 'IDENTITY_SUBMITTED',
        }),
      });
    });
  });

  describe('submitFaceMatch', () => {
    it('rejects when the client is not at the IDENTITY_SUBMITTED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IPPIS_LINKED' });
      await expect(service.submitFaceMatch('client-1', Buffer.from('selfie'))).rejects.toThrow(ConflictException);
    });

    it('completes and sets Client VERIFIED when identity and both face matches pass', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'IDENTITY_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare.mockResolvedValue({ score: 0.95, passed: true });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });

    it('routes to MANUAL_REVIEW when a face match fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'IDENTITY_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare
        .mockResolvedValueOnce({ score: 0.95, passed: true })
        .mockResolvedValueOnce({ score: 0.2, passed: false });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'MANUAL_REVIEW' },
      });
    });
  });

  describe('getStatus', () => {
    it('returns PHONE_VERIFIED when no onboarding row exists yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.step).toBe('PHONE_VERIFIED');
    });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: FAIL — `Cannot find module './client-onboarding.service'`

- [ ] **Step 7: Implement `ClientOnboardingService`**

`src/client-onboarding/client-onboarding.service.ts`:

```typescript
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FACE_VERIFICATION_PROVIDER, FaceVerificationProvider } from '../face-verification/face-verification-provider.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientStatus, OnboardingStep } from '../generated/prisma/client';

@Injectable()
export class ClientOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityVerificationService: IdentityVerificationService,
    @Inject(FACE_VERIFICATION_PROVIDER) private readonly faceVerificationProvider: FaceVerificationProvider,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  private async requireOnboarding(clientId: string) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (!onboarding) {
      throw new ConflictException('Client has not started IPPIS linking yet');
    }
    return onboarding;
  }

  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      throw new ConflictException('Onboarding already started for this client');
    }

    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const alreadyLinked = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (alreadyLinked) {
      throw new ConflictException('This IPPIS record is already linked to another client');
    }

    return this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });
  }

  async submitIdentity(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }

    const [bvnResult, ninResult] = await Promise.all([
      this.identityVerificationService.lookupBvn(bvn),
      this.identityVerificationService.lookupNin(nin),
    ]);

    const bvnSelfieKey = `client-onboarding/${clientId}/bvn-selfie.jpg`;
    const ninSelfieKey = `client-onboarding/${clientId}/nin-selfie.jpg`;
    await this.fileStorageProvider.putObject(bvnSelfieKey, Buffer.from(bvnResult.photoBase64, 'base64'));
    await this.fileStorageProvider.putObject(ninSelfieKey, Buffer.from(ninResult.photoBase64, 'base64'));

    const identityVerified = Boolean(bvnResult.firstName) && Boolean(ninResult.firstName);

    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        bvn,
        nin,
        bvnSelfie: bvnSelfieKey,
        ninSelfie: ninSelfieKey,
        identityVerified,
        step: OnboardingStep.IDENTITY_SUBMITTED,
      },
    });
  }

  async submitFaceMatch(clientId: string, selfieBuffer: Buffer) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED) {
      throw new ConflictException(`Expected step IDENTITY_SUBMITTED, but client is at ${onboarding.step}`);
    }

    const liveSelfieKey = `client-onboarding/${clientId}/live-selfie.jpg`;
    await this.fileStorageProvider.putObject(liveSelfieKey, selfieBuffer);

    const [bvnMatch, ninMatch] = await Promise.all([
      this.faceVerificationProvider.compare(onboarding.bvnSelfie!, liveSelfieKey),
      this.faceVerificationProvider.compare(onboarding.ninSelfie!, liveSelfieKey),
    ]);

    const faceMatchPassed = bvnMatch.passed && ninMatch.passed;
    const completed = Boolean(onboarding.identityVerified) && faceMatchPassed;

    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        liveSelfieKey,
        faceMatchBvnScore: bvnMatch.score,
        faceMatchNinScore: ninMatch.score,
        faceMatchPassed,
        step: completed ? OnboardingStep.COMPLETED : OnboardingStep.FACE_MATCH_PENDING,
        failureReasons: completed
          ? null
          : { identityVerified: onboarding.identityVerified, faceMatchPassed },
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: completed ? ClientStatus.VERIFIED : ClientStatus.MANUAL_REVIEW },
    });

    return updated;
  }

  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding,
    };
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 9: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/auth/client-only.guard.ts src/auth/client-only.guard.spec.ts src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "feat: add ClientOnboardingService and ClientOnlyGuard"
```

---

### Task 6: Controller, module wiring, e2e test, README, and Postman

**Files:**
- Create: `src/client-onboarding/dto/link-ippis.dto.ts`
- Create: `src/client-onboarding/dto/submit-identity.dto.ts`
- Create: `src/client-onboarding/client-onboarding.controller.ts`
- Create: `src/client-onboarding/client-onboarding.module.ts`
- Modify: `src/app.module.ts`
- Modify: `prisma/schema.prisma` bank/accountNumber source note — none needed (already in Task 1)
- Test: `test/client-onboarding.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `ClientOnboardingService`, `ClientOnlyGuard` (Task 5).
- Produces: `POST /client/onboarding/ippis-link`, `POST /client/onboarding/identity`, `POST /client/onboarding/face-match`, `GET /client/onboarding/status`.

- [ ] **Step 1: Add the DTOs**

`src/client-onboarding/dto/link-ippis.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class LinkIppisDto {
  @IsString()
  @MinLength(1)
  ippisNumber: string;
}
```

`src/client-onboarding/dto/submit-identity.dto.ts`:

```typescript
import { IsString, Matches } from 'class-validator';

export class SubmitIdentityDto {
  @IsString()
  @Matches(/^\d{11}$/, { message: 'bvn must be an 11-digit number' })
  bvn: string;

  @IsString()
  @Matches(/^\d{11}$/, { message: 'nin must be an 11-digit number' })
  nin: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/client-onboarding/client-onboarding.controller.ts`:

```typescript
import { Body, Controller, Get, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientOnboardingService } from './client-onboarding.service';
import { LinkIppisDto } from './dto/link-ippis.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';

@Controller('client/onboarding')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('ippis-link')
  linkIppis(@Body() dto: LinkIppisDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.linkIppis(req.user.sub, dto.ippisNumber);
  }

  @Post('identity')
  submitIdentity(@Body() dto: SubmitIdentityDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.submitIdentity(req.user.sub, dto.bvn, dto.nin);
  }

  @Post('face-match')
  @UseInterceptors(FileInterceptor('selfie'))
  submitFaceMatch(@UploadedFile() file: Express.Multer.File, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.submitFaceMatch(req.user.sub, file.buffer);
  }

  @Get('status')
  getStatus(@Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.getStatus(req.user.sub);
  }
}
```

- [ ] **Step 3: Implement the module and wire it into `AppModule`**

`src/client-onboarding/client-onboarding.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ClientOnboardingController } from './client-onboarding.controller';
import { ClientOnboardingService } from './client-onboarding.service';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module';
import { FaceVerificationModule } from '../face-verification/face-verification.module';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
  imports: [IdentityVerificationModule, FaceVerificationModule, FileStorageModule],
  controllers: [ClientOnboardingController],
  providers: [ClientOnboardingService],
})
export class ClientOnboardingModule {}
```

Modify `src/app.module.ts`: add `import { ClientOnboardingModule } from './client-onboarding/client-onboarding.module';` and add `ClientOnboardingModule` to the `imports` array.

- [ ] **Step 4: Write the e2e test**

`test/client-onboarding.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234800${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-ONBOARD-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const client = await prisma.client.create({ data: { phone } });
    clientId = client.id;
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'E2E Onboarding Test',
        bankName: 'Test Bank',
        accountNumber: '0000000000',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('rejects a non-client token', async () => {
    return request(app.getHttpServer())
      .get('/client/onboarding/status')
      .expect(401);
  });

  it('returns PHONE_VERIFIED before any onboarding step has run', () => {
    return request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.step).toBe('PHONE_VERIFIED');
      });
  });

  it('walks the client through IPPIS link, identity, and face match to COMPLETED', async () => {
    await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IPPIS_LINKED');
        expect(res.body.employeeName).toBe('E2E Onboarding Test');
      });

    await request(app.getHttpServer())
      .post('/client/onboarding/identity')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IDENTITY_SUBMITTED');
        expect(res.body.identityVerified).toBe(true);
      });

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  });
});
```

- [ ] **Step 5: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-onboarding.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 6: Update the README**

Add a new section to `README.md`, after the "Document ingestion" / reconciliation-related content (wherever the most recent feature section ends):

```markdown
## Client/IPPIS onboarding

After phone/OTP login, a Client links their IPPIS number, submits BVN/NIN
for lookup (via a pluggable `IdentityVerificationProvider` — mock by
default, `DojahIdentityVerificationProvider` when
`IDENTITY_VERIFICATION_PROVIDER=dojah` and `DOJAH_APP_ID`/`DOJAH_SECRET_KEY`
are set), then submits a live selfie compared against both the BVN and NIN
reference photos via a pluggable `FaceVerificationProvider` (mock only for
now). Passing both auto-verifies the client; any failure routes to
`MANUAL_REVIEW` (existing `clients:review` permission covers visibility).

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /client/onboarding/ippis-link` | Client JWT | `{ ippisNumber }` |
| `POST /client/onboarding/identity` | Client JWT | `{ bvn, nin }` |
| `POST /client/onboarding/face-match` | Client JWT | multipart, field `selfie` |
| `GET /client/onboarding/status` | Client JWT | resumability — `step` says exactly where to continue |
```

- [ ] **Step 7: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the **Client** top-level folder, add a new sub-folder `"Onboarding"` (alongside the existing `Auth` and `Session` sub-folders) with these requests — a success scenario per step plus the meaningful failure scenarios, following this collection's existing conventions (test scripts capturing what later requests need):

```json
{
  "name": "Onboarding",
  "item": [
    {
      "name": "GET /client/onboarding/status - Unauthenticated (401)",
      "request": {
        "method": "GET",
        "header": [],
        "url": { "raw": "{{base_url}}/client/onboarding/status", "host": ["{{base_url}}"], "path": ["client", "onboarding", "status"] }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 401', () => pm.response.to.have.status(401));"] } }]
    },
    {
      "name": "GET /client/onboarding/status - Success (before any step)",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": { "raw": "{{base_url}}/client/onboarding/status", "host": ["{{base_url}}"], "path": ["client", "onboarding", "status"] },
        "description": "Run 'Client > Auth > POST /auth/client/otp/verify - Success' first to populate client_access_token."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }]
    },
    {
      "name": "POST /client/onboarding/ippis-link - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"ippisNumber\": \"{{test_ippis_staff_id}}\"\n}" },
        "url": { "raw": "{{base_url}}/client/onboarding/ippis-link", "host": ["{{base_url}}"], "path": ["client", "onboarding", "ippis-link"] },
        "description": "test_ippis_staff_id must be a Staff ID that exists in IppisRecord (e.g. from a prior IPPIS Broadsheet upload) and isn't already linked to another client."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 201', () => pm.response.to.have.status(201));", "pm.test('step is IPPIS_LINKED', () => pm.expect(pm.response.json().step).to.eql('IPPIS_LINKED'));"] } }]
    },
    {
      "name": "POST /client/onboarding/ippis-link - Not found (404)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"ippisNumber\": \"DOES-NOT-EXIST\"\n}" },
        "url": { "raw": "{{base_url}}/client/onboarding/ippis-link", "host": ["{{base_url}}"], "path": ["client", "onboarding", "ippis-link"] }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 404', () => pm.response.to.have.status(404));"] } }]
    },
    {
      "name": "POST /client/onboarding/identity - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"bvn\": \"12345678901\",\n  \"nin\": \"98765432109\"\n}" },
        "url": { "raw": "{{base_url}}/client/onboarding/identity", "host": ["{{base_url}}"], "path": ["client", "onboarding", "identity"] },
        "description": "Uses the mock IdentityVerificationProvider by default (IDENTITY_VERIFICATION_PROVIDER=mock) — any 11-digit values work."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 201', () => pm.response.to.have.status(201));", "pm.test('step is IDENTITY_SUBMITTED', () => pm.expect(pm.response.json().step).to.eql('IDENTITY_SUBMITTED'));"] } }]
    },
    {
      "name": "POST /client/onboarding/identity - Invalid BVN/NIN format (400)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"bvn\": \"123\",\n  \"nin\": \"98765432109\"\n}" },
        "url": { "raw": "{{base_url}}/client/onboarding/identity", "host": ["{{base_url}}"], "path": ["client", "onboarding", "identity"] }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 400', () => pm.response.to.have.status(400));"] } }]
    },
    {
      "name": "POST /client/onboarding/face-match - Success",
      "request": {
        "method": "POST",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "body": { "mode": "formdata", "formdata": [{ "key": "selfie", "type": "file", "src": [] }] },
        "url": { "raw": "{{base_url}}/client/onboarding/face-match", "host": ["{{base_url}}"], "path": ["client", "onboarding", "face-match"] },
        "description": "Attach any image file — the mock FaceVerificationProvider always passes. Run the identity request above first."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 201', () => pm.response.to.have.status(201));", "pm.test('step is COMPLETED', () => pm.expect(pm.response.json().step).to.eql('COMPLETED'));"] } }]
    },
    {
      "name": "GET /client/onboarding/status - Success (after completion)",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": { "raw": "{{base_url}}/client/onboarding/status", "host": ["{{base_url}}"], "path": ["client", "onboarding", "status"] }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('step is COMPLETED', () => pm.expect(pm.response.json().step).to.eql('COMPLETED'));"] } }]
    }
  ]
}
```

Add one new collection variable alongside the existing ones: `{ "key": "test_ippis_staff_id", "value": "" }`.

- [ ] **Step 8: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

Add a line to `postman/README.md`'s Client bullet in "Folder structure" mentioning the new **Onboarding** sub-folder.

- [ ] **Step 9: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the new ones from this plan.

- [ ] **Step 10: Commit**

```bash
git add src/client-onboarding src/app.module.ts test/client-onboarding.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: wire up the Client/IPPIS onboarding pipeline endpoints"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] A phone-verified client can link an IPPIS number, submit BVN/NIN, submit a selfie, and reach `Client.status = VERIFIED` — proven by `test/client-onboarding.e2e-spec.ts`.
- [ ] `IDENTITY_VERIFICATION_PROVIDERS` never contains both the mock and Dojah provider at once — proven by `identity-verification.module.ts`'s config-driven single-selection factory and its absence from any test asserting otherwise.
- [ ] A second client cannot link an IPPIS number already claimed by another client — proven by `client-onboarding.service.spec.ts`.
- [ ] A face-match failure on either the BVN or NIN comparison routes to `MANUAL_REVIEW`, not `VERIFIED` — proven by `client-onboarding.service.spec.ts`.
- [ ] `GET /client/onboarding/status` correctly reports the current step at every stage — proven by the e2e test.
- [ ] Postman has full coverage of all four endpoints under `Client > Onboarding`.
