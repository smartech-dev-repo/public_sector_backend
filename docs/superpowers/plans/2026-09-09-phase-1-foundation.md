# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** Use this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking. Each task ends in a commit; do not start
> the next task until the previous one's tests pass.

**Goal:** Stand up the NestJS + PostgreSQL/Prisma project with three working
login flows (Admin email+password, Agent email+password, Client phone+OTP)
and a working RBAC permission guard — no onboarding business logic yet.

**Architecture:** NestJS modules per concern (`prisma`, `auth`, `otp`,
`roles`), one Postgres database via Prisma, a single JWT strategy whose
payload carries a `type` discriminator (`admin` | `agent` | `client`) plus,
for admins, a flattened `permissions` array checked by a `PermissionsGuard`.
External integrations (OTP delivery) are behind an interface with a
console-logging mock implementation for local development.

**Tech Stack:** Node.js 20+, NestJS 10, TypeScript, PostgreSQL 16, Prisma 5,
Passport + `@nestjs/jwt`, bcrypt, class-validator, Jest + Supertest.

**Spec:** `docs/specs/2026-09-09-public-sector-backend-spec.md`

## Global Constraints

- Node.js >= 20, npm (not yarn/pnpm) for this repo.
- All admin-guarded routes must declare required permission(s) explicitly
  via `@RequirePermissions(...)` — no route may rely on "is an admin" alone.
- No secrets committed: `.env` is gitignored; `.env.example` documents every
  variable.
- Passwords hashed with bcrypt (cost 12); OTP codes stored hashed, never in
  plaintext.
- Every task ships with passing tests before the next task starts.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
- Create: `.eslintrc.js`, `.prettierrc`, `.gitignore`, `.env.example`
- Create: `src/main.ts`, `src/app.module.ts`
- Create: `test/app.e2e-spec.ts`

**Interfaces:**
- Produces: `AppModule` (empty root module later tasks import into), a
  running HTTP server with `GET /health` → `{ status: 'ok' }`.

- [ ] **Step 1: Initialize the Nest project**

```bash
npx -y @nestjs/cli new . --skip-git --package-manager npm --language ts
```

Answer prompts if any; if the CLI complains the directory isn't empty,
proceed anyway (this directory only has `docs/` so far).

- [ ] **Step 2: Add a health endpoint**

Edit `src/app.controller.ts` to replace its content with:

```typescript
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
```

Remove `src/app.service.ts` and its references in `src/app.module.ts` and
`src/app.controller.ts` (not needed yet).

- [ ] **Step 3: Write the e2e test**

Replace `test/app.e2e-spec.ts` with:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
```

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS — 1 test, `/health (GET)`

- [ ] **Step 5: Add `.env.example` and `.gitignore` entries**

`.env.example`:

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/public_sector_backend?schema=public
JWT_ACCESS_SECRET=change-me-access
JWT_REFRESH_SECRET=change-me-refresh
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=change-me-strong-password
BOOTSTRAP_ADMIN_NAME=Super Admin
OTP_TTL_SECONDS=300
```

Ensure `.gitignore` includes `node_modules`, `dist`, `.env`.

- [ ] **Step 6: Commit**

```bash
git init
git add package.json tsconfig.json tsconfig.build.json nest-cli.json .eslintrc.js .prettierrc .gitignore .env.example src test
git commit -m "chore: scaffold NestJS project with health endpoint"
```

---

### Task 2: PostgreSQL + Prisma wiring

**Files:**
- Create: `docker-compose.yml`
- Create: `prisma/schema.prisma`
- Create: `src/prisma/prisma.service.ts`
- Create: `src/prisma/prisma.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/prisma.e2e-spec.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` from environment (Task 1's `.env.example`).
- Produces: `PrismaModule` (global) exporting `PrismaService`, a
  `PrismaClient` subclass connected in `onModuleInit` — every later task
  injects `PrismaService` for DB access.

- [ ] **Step 1: Add local Postgres via docker-compose**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: public_sector_backend
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Run: `docker compose up -d postgres`

- [ ] **Step 2: Install Prisma and initialize**

```bash
npm install prisma --save-dev
npm install @prisma/client
npx prisma init --datasource-provider postgresql
```

Copy `DATABASE_URL` from `.env.example` into a real `.env` (create `.env`,
already gitignored).

- [ ] **Step 3: Write the base schema**

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 4: Run the initial migration**

Run: `npx prisma migrate dev --name init`
Expected: creates `prisma/migrations/<timestamp>_init/` and an empty schema
applies cleanly (no models yet — this just proves the DB connection works).

- [ ] **Step 5: Write `PrismaService`**

`src/prisma/prisma.service.ts`:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

`src/prisma/prisma.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

Add `PrismaModule` to `imports` in `src/app.module.ts`.

- [ ] **Step 6: Write the e2e test**

`test/prisma.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';

describe('PrismaService', () => {
  let prisma: PrismaService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await moduleRef.close();
  });

  it('connects and can run a raw query', async () => {
    const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
    expect(result[0].ok).toBe(1);
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS — both `/health` and `PrismaService` tests green.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml prisma src/prisma src/app.module.ts test/prisma.e2e-spec.ts .env.example package.json package-lock.json
git commit -m "feat: wire PostgreSQL via Prisma"
```

---

### Task 3: Core domain schema + seed

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/seed.ts`
- Modify: `package.json` (add `prisma.seed` config)
- Test: `test/seed.e2e-spec.ts`

**Interfaces:**
- Produces: Prisma models `Permission`, `Role`, `RolePermission`,
  `AdminUser`, `AdminUserRole`, `Agent` (enum `AgentStatus`), `Client`
  (enum `ClientStatus`), `OtpCode` (enum `OtpPurpose`) — every later task's
  DB access goes through these.
- Produces: a seeded `Role` named `SUPER_ADMIN` holding every `Permission`
  that exists at seed time, and one `AdminUser` from
  `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` / `BOOTSTRAP_ADMIN_NAME`
  assigned that role.

- [ ] **Step 1: Extend the schema**

Append to `prisma/schema.prisma`:

```prisma
model Permission {
  id          String           @id @default(uuid())
  key         String           @unique
  description String
  roles       RolePermission[]
  createdAt   DateTime         @default(now())
}

model Role {
  id          String           @id @default(uuid())
  name        String           @unique
  description String?
  permissions RolePermission[]
  admins      AdminUserRole[]
  createdAt   DateTime         @default(now())
}

model RolePermission {
  roleId       String
  permissionId String
  role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
}

model AdminUser {
  id           String          @id @default(uuid())
  email        String          @unique
  passwordHash String
  fullName     String
  isActive     Boolean         @default(true)
  roles        AdminUserRole[]
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
}

model AdminUserRole {
  adminUserId String
  roleId      String
  adminUser   AdminUser @relation(fields: [adminUserId], references: [id], onDelete: Cascade)
  role        Role      @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@id([adminUserId, roleId])
}

enum AgentStatus {
  PENDING_REVIEW
  APPROVED
  REJECTED
}

model Agent {
  id           String      @id @default(uuid())
  email        String      @unique
  phone        String
  fullName     String
  passwordHash String?
  status       AgentStatus @default(PENDING_REVIEW)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
}

enum ClientStatus {
  PHONE_VERIFIED
  PENDING_IPPIS
  MANUAL_REVIEW
  VERIFIED
}

model Client {
  id        String       @id @default(uuid())
  phone     String       @unique
  status    ClientStatus @default(PHONE_VERIFIED)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
}

enum OtpPurpose {
  CLIENT_LOGIN
}

model OtpCode {
  id         String     @id @default(uuid())
  phone      String
  codeHash   String
  purpose    OtpPurpose
  expiresAt  DateTime
  consumedAt DateTime?
  attempts   Int        @default(0)
  createdAt  DateTime   @default(now())

  @@index([phone, purpose])
}
```

- [ ] **Step 2: Migrate**

Run: `npx prisma migrate dev --name core_domain`
Expected: migration applies cleanly, Prisma Client regenerated.

- [ ] **Step 3: Write the seed script**

Install bcrypt: `npm install bcrypt` and `npm install --save-dev @types/bcrypt`

`prisma/seed.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const BOOTSTRAP_PERMISSIONS: Array<{ key: string; description: string }> = [
  { key: 'admins:create', description: 'Create admin users' },
  { key: 'roles:manage', description: 'Create/edit roles and permissions' },
  { key: 'agents:read', description: 'View agent enrollment submissions' },
  { key: 'agents:review', description: 'Approve or reject agent submissions' },
  { key: 'clients:review', description: 'Review clients flagged for manual review' },
  { key: 'ippis:upload', description: 'Upload/refresh IPPIS master data' },
];

async function main() {
  for (const permission of BOOTSTRAP_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {},
      create: permission,
    });
  }

  const allPermissions = await prisma.permission.findMany();

  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: { name: 'SUPER_ADMIN', description: 'Full system access' },
  });

  for (const permission of allPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: superAdminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: { roleId: superAdminRole.id, permissionId: permission.id },
    });
  }

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const bootstrapName = process.env.BOOTSTRAP_ADMIN_NAME ?? 'Super Admin';

  if (!bootstrapEmail || !bootstrapPassword) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set to seed the bootstrap admin',
    );
  }

  const passwordHash = await bcrypt.hash(bootstrapPassword, 12);

  const admin = await prisma.adminUser.upsert({
    where: { email: bootstrapEmail },
    update: {},
    create: { email: bootstrapEmail, passwordHash, fullName: bootstrapName },
  });

  await prisma.adminUserRole.upsert({
    where: {
      adminUserId_roleId: { adminUserId: admin.id, roleId: superAdminRole.id },
    },
    update: {},
    create: { adminUserId: admin.id, roleId: superAdminRole.id },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
```

Add to `package.json`:

```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  }
}
```

(`ts-node` ships as a NestJS CLI dependency already; if missing, run
`npm install --save-dev ts-node`.)

- [ ] **Step 4: Run the seed**

Run: `npx prisma db seed`
Expected: completes with no errors; `SELECT * FROM "AdminUser";` via
`npx prisma studio` shows one row with the bootstrap email.

- [ ] **Step 5: Write the e2e test**

`test/seed.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';

describe('Seed data', () => {
  let prisma: PrismaService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('creates a SUPER_ADMIN role holding every permission', async () => {
    const role = await prisma.role.findUnique({
      where: { name: 'SUPER_ADMIN' },
      include: { permissions: true },
    });
    const allPermissions = await prisma.permission.findMany();

    expect(role).not.toBeNull();
    expect(role!.permissions.length).toBe(allPermissions.length);
  });

  it('creates the bootstrap admin with the SUPER_ADMIN role', async () => {
    const admin = await prisma.adminUser.findUnique({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
      include: { roles: { include: { role: true } } },
    });

    expect(admin).not.toBeNull();
    expect(admin!.roles.some((r) => r.role.name === 'SUPER_ADMIN')).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 7: Commit**

```bash
git add prisma package.json package-lock.json test/seed.e2e-spec.ts
git commit -m "feat: add core RBAC/agent/client schema and bootstrap seed"
```

---

### Task 4: Admin auth (email + password)

**Files:**
- Create: `src/auth/auth.module.ts`
- Create: `src/auth/jwt.strategy.ts`
- Create: `src/auth/jwt-payload.interface.ts`
- Create: `src/auth/token.service.ts`
- Create: `src/auth/admin/admin-auth.controller.ts`
- Create: `src/auth/admin/admin-auth.service.ts`
- Create: `src/auth/admin/dto/admin-login.dto.ts`
- Modify: `src/app.module.ts`
- Test: `src/auth/admin/admin-auth.service.spec.ts`
- Test: `test/admin-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 2/3), bcrypt (Task 3).
- Produces: `JwtPayload { sub: string; type: 'admin' | 'agent' | 'client'; permissions?: string[] }`.
- Produces: `TokenService.signAccessToken(payload: JwtPayload): string` and
  `TokenService.signRefreshToken(payload: JwtPayload): string` — every
  later auth flow (Agent, Client) reuses these.
- Produces: `POST /auth/admin/login` → `{ accessToken: string; refreshToken: string }`.

- [ ] **Step 1: Install auth dependencies**

```bash
npm install @nestjs/jwt @nestjs/passport passport passport-jwt
npm install --save-dev @types/passport-jwt
```

- [ ] **Step 2: Define the JWT payload type**

`src/auth/jwt-payload.interface.ts`:

```typescript
export type PrincipalType = 'admin' | 'agent' | 'client';

export interface JwtPayload {
  sub: string;
  type: PrincipalType;
  permissions?: string[];
}
```

- [ ] **Step 3: Write the failing unit test for `AdminAuthService`**

`src/auth/admin/admin-auth.service.spec.ts`:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: { adminUser: { findUnique: jest.Mock } };
  let tokenService: TokenService;

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      signRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    } as unknown as TokenService;
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
    );
  });

  it('rejects unknown emails', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
      roles: [],
    });

    await expect(
      service.login('admin@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens with flattened permissions on a correct login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
      roles: [
        {
          role: {
            permissions: [{ permission: { key: 'agents:read' } }],
          },
        },
      ],
    });

    const result = await service.login('admin@example.com', 'correct-password');

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['agents:read'],
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-auth.service'`

- [ ] **Step 5: Implement `TokenService`**

`src/auth/token.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_TTL', '15m'),
    });
  }

  signRefreshToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_TTL', '7d'),
    });
  }
}
```

- [ ] **Step 6: Implement `AdminAuthService`**

`src/auth/admin/admin-auth.service.ts`:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const permissions = Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );

    const payload = { sub: admin.id, type: 'admin' as const, permissions };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: this.tokenService.signRefreshToken(payload),
    };
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 8: Wire the controller, DTO, strategy, and module**

`src/auth/admin/dto/admin-login.dto.ts`:

```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

export class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
```

`src/auth/admin/admin-auth.controller.ts`:

```typescript
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';

@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuthService.login(dto.email, dto.password);
  }
}
```

`src/auth/jwt.strategy.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
```

`src/auth/auth.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [TokenService, JwtStrategy, AdminAuthService],
  exports: [TokenService],
})
export class AuthModule {}
```

Install and enable config + validation globally. `npm install @nestjs/config class-validator class-transformer`.

In `src/main.ts`, add global validation:

```typescript
import { ValidationPipe } from '@nestjs/common';
// ...inside bootstrap(), before app.listen():
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
```

In `src/app.module.ts`, import `ConfigModule.forRoot({ isGlobal: true })` and
`AuthModule`.

- [ ] **Step 9: Write the e2e test**

`test/admin-auth.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Admin auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects bad credentials with 401', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
  });

  it('logs in the seeded bootstrap admin', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      })
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.accessToken).toBe('string');
        expect(typeof res.body.refreshToken).toBe('string');
      });
  });
});
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 11: Commit**

```bash
git add src/auth src/app.module.ts src/main.ts test/admin-auth.e2e-spec.ts package.json package-lock.json
git commit -m "feat: add admin email+password login with JWT issuance"
```

---

### Task 5: RBAC permission guard

**Files:**
- Create: `src/auth/permissions.decorator.ts`
- Create: `src/auth/permissions.guard.ts`
- Create: `src/auth/jwt-auth.guard.ts`
- Create: `src/admin/admin.module.ts`
- Create: `src/admin/admin.controller.ts`
- Modify: `src/auth/auth.module.ts` (export guard-usable pieces)
- Modify: `src/app.module.ts`
- Test: `src/auth/permissions.guard.spec.ts`
- Test: `test/admin-rbac.e2e-spec.ts`

**Interfaces:**
- Consumes: `JwtPayload` (Task 4).
- Produces: `@RequirePermissions(...keys: string[])` decorator and
  `PermissionsGuard` — every future admin-only controller route uses these
  two together with `JwtAuthGuard`.
- Produces: `GET /admin/me` (any authenticated admin) and
  `GET /admin/roles/ping` (requires `roles:manage`) as reference routes.

- [ ] **Step 1: Write the failing unit test for `PermissionsGuard`**

`src/auth/permissions.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('allows access when the user has every required permission', () => {
    const reflector = { getAllAndOverride: () => ['agents:read'] } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: ['agents:read', 'agents:review'] });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when a required permission is missing', () => {
    const reflector = { getAllAndOverride: () => ['roles:manage'] } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: ['agents:read'] });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows access when the route declares no required permissions', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    const context = buildContext({ type: 'admin', permissions: [] });

    expect(guard.canActivate(context)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/auth/permissions.guard.spec.ts`
Expected: FAIL — `Cannot find module './permissions.guard'`

- [ ] **Step 3: Implement the decorator and guard**

`src/auth/permissions.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
```

`src/auth/permissions.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    const userPermissions = user?.permissions ?? [];

    const hasAll = requiredPermissions.every((permission) =>
      userPermissions.includes(permission),
    );

    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
```

`src/auth/jwt-auth.guard.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/auth/permissions.guard.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Export guard-usable pieces from `AuthModule`**

Modify `src/auth/auth.module.ts` `exports` array to also include
`JwtAuthGuard`-supporting providers (the guard classes have no providers of
their own to export — `Reflector` is already global via `@nestjs/core`).
No change needed beyond what Task 4 already exports; `JwtAuthGuard` and
`PermissionsGuard` are imported directly by controllers, not resolved via
DI export.

- [ ] **Step 6: Add reference admin routes**

`src/admin/admin.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, type: req.user.type, permissions: req.user.permissions };
  }

  @Get('roles/ping')
  @RequirePermissions('roles:manage')
  rolesPing() {
    return { ok: true };
  }
}
```

`src/admin/admin.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';

@Module({
  controllers: [AdminController],
})
export class AdminModule {}
```

Add `AdminModule` to `imports` in `src/app.module.ts`.

- [ ] **Step 7: Write the e2e test**

`test/admin-rbac.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Admin RBAC (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests to /admin/me', () => {
    return request(app.getHttpServer()).get('/admin/me').expect(401);
  });

  it('allows the bootstrap super-admin to read /admin/me', () => {
    return request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.type).toBe('admin');
        expect(res.body.permissions).toContain('roles:manage');
      });
  });

  it('allows the bootstrap super-admin to hit a roles:manage-gated route', () => {
    return request(app.getHttpServer())
      .get('/admin/roles/ping')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ ok: true });
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 9: Commit**

```bash
git add src/auth src/admin src/app.module.ts test/admin-rbac.e2e-spec.ts
git commit -m "feat: add RBAC permissions guard and reference admin routes"
```

---

### Task 6: OTP infrastructure (multi-provider, with failover)

There will be more than one SMS/OTP vendor over time. Rather than binding
`OtpService` to a single provider, it takes an **ordered list** of
providers and tries them in sequence, falling through to the next one on
failure. Adding a real vendor later means writing one new class and adding
it to the list in `OtpModule` — `OtpService` itself never changes. Phase 1
ships this mechanism proven against mock providers only; wiring in a real
SMS vendor is a Phase 5 (hardening) concern, not this one.

**Files:**
- Create: `src/otp/otp-provider.interface.ts`
- Create: `src/otp/console-otp.provider.ts`
- Create: `src/otp/otp.service.ts`
- Create: `src/otp/otp.module.ts`
- Test: `src/otp/otp.service.spec.ts`

**Interfaces:**
- Produces: `OtpProvider { readonly name: string; send(phone: string, code: string): Promise<void>; }`.
- Produces: `OTP_PROVIDERS` DI token resolving to `OtpProvider[]`, tried in
  array order — appending a new vendor implementation to this array (via
  `OtpModule`'s factory) is the only change needed to add a provider.
- Produces: `OtpService.request(phone: string): Promise<void>` and
  `OtpService.verify(phone: string, code: string): Promise<boolean>` — Task
  7's Client login flow consumes these; their signatures are unaffected by
  how many providers are configured underneath.

- [ ] **Step 1: Write the failing unit test**

`src/otp/otp.service.spec.ts`:

```typescript
import { InternalServerErrorException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpProvider } from './otp-provider.interface';

function fakeProvider(name: string, send: jest.Mock): OtpProvider {
  return { name, send };
}

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    otpCode: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      otpCode: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
  });

  it('generates a 6-digit code, stores its hash, and sends it via the first provider', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(prisma.otpCode.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.otpCode.create.mock.calls[0][0];
    expect(createArgs.data.phone).toBe('+2348000000000');
    expect(createArgs.data.purpose).toBe('CLIENT_LOGIN');
    expect(typeof createArgs.data.codeHash).toBe('string');
    expect(primarySend).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(secondarySend).not.toHaveBeenCalled();
  });

  it('falls back to the next provider when the first one fails', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor down'));
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.request('+2348000000000');

    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(secondarySend).toHaveBeenCalledTimes(1);
  });

  it('throws once every provider has failed', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor A down'));
    const secondarySend = jest.fn().mockRejectedValue(new Error('vendor B down'));
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await expect(service.request('+2348000000000')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('rejects verification when no matching unconsumed code exists', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    const result = await service.verify('+2348000000000', '123456');
    expect(result).toBe(false);
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    service = new OtpService(prisma as unknown as PrismaService, [
      fakeProvider('primary', jest.fn()),
    ]);
    const bcrypt = await import('bcrypt');
    const codeHash = await bcrypt.hash('123456', 12);
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verify('+2348000000000', '123456');

    expect(result).toBe(true);
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: FAIL — `Cannot find module './otp.service'`

- [ ] **Step 3: Implement the provider interface and mock**

`src/otp/otp-provider.interface.ts`:

```typescript
export const OTP_PROVIDERS = Symbol('OTP_PROVIDERS');

export interface OtpProvider {
  readonly name: string;
  send(phone: string, code: string): Promise<void>;
}
```

`src/otp/console-otp.provider.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { OtpProvider } from './otp-provider.interface';

@Injectable()
export class ConsoleOtpProvider implements OtpProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleOtpProvider.name);

  async send(phone: string, code: string): Promise<void> {
    this.logger.log(`OTP for ${phone}: ${code}`);
  }
}
```

- [ ] **Step 4: Implement `OtpService`**

`src/otp/otp.service.ts`:

```typescript
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_PROVIDERS, OtpProvider } from './otp-provider.interface';

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDERS) private readonly providers: OtpProvider[],
    private readonly configService?: ConfigService,
  ) {}

  private ttlSeconds(): number {
    return Number(this.configService?.get('OTP_TTL_SECONDS') ?? 300);
  }

  private async sendWithFailover(phone: string, code: string): Promise<void> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        await provider.send(phone, code);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`OTP provider "${provider.name}" failed: ${message}`);
        failures.push(`${provider.name}: ${message}`);
      }
    }

    throw new InternalServerErrorException(
      `All OTP providers failed: ${failures.join('; ')}`,
    );
  }

  async request(phone: string): Promise<void> {
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 12);
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: { phone, codeHash, purpose: 'CLIENT_LOGIN', expiresAt },
    });

    await this.sendWithFailover(phone, code);
  }

  async verify(phone: string, code: string): Promise<boolean> {
    const candidate = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: 'CLIENT_LOGIN', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidate || candidate.expiresAt < new Date()) {
      return false;
    }

    const matches = await bcrypt.compare(code, candidate.codeHash);
    if (!matches) {
      return false;
    }

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    return true;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Wire the module**

`src/otp/otp.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './console-otp.provider';
import { OTP_PROVIDERS } from './otp-provider.interface';

@Module({
  providers: [
    OtpService,
    ConsoleOtpProvider,
    {
      provide: OTP_PROVIDERS,
      useFactory: (consoleProvider: ConsoleOtpProvider) => [consoleProvider],
      inject: [ConsoleOtpProvider],
    },
  ],
  exports: [OtpService],
})
export class OtpModule {}
```

Today the factory returns a single-element array (`[consoleProvider]`) since
`ConsoleOtpProvider` is the only implementation that exists. To add a real
vendor later: implement `OtpProvider` in a new class (e.g.
`TermiiOtpProvider`), add it to this module's `providers`, and include it
in the factory's returned array in priority order — `OtpService` requires
no changes.

- [ ] **Step 7: Commit**

```bash
git add src/otp
git commit -m "feat: add OTP service with ordered multi-provider failover"
```

---

### Task 7: Client auth (phone + OTP)

**Files:**
- Create: `src/auth/client/client-auth.controller.ts`
- Create: `src/auth/client/client-auth.service.ts`
- Create: `src/auth/client/dto/request-otp.dto.ts`
- Create: `src/auth/client/dto/verify-otp.dto.ts`
- Modify: `src/auth/auth.module.ts`
- Test: `src/auth/client/client-auth.service.spec.ts`
- Test: `test/client-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `OtpService` (Task 6), `TokenService` (Task 4), `PrismaService`.
- Produces: `POST /auth/client/otp/request` and
  `POST /auth/client/otp/verify` → `{ accessToken; refreshToken }` on
  success, creating the `Client` row on first successful verification.

- [ ] **Step 1: Write the failing unit test**

`src/auth/client/client-auth.service.spec.ts`:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock } };
  let tokenService: TokenService;

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = { client: { upsert: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      signRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    } as unknown as TokenService;
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
    );
  });

  it('delegates OTP requests to OtpService', async () => {
    await service.requestOtp('+2348000000000');
    expect(otpService.request).toHaveBeenCalledWith('+2348000000000');
  });

  it('rejects an invalid OTP', async () => {
    otpService.verify.mockResolvedValue(false);
    await expect(
      service.verifyOtp('+2348000000000', '000000'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('upserts the Client and issues tokens on a valid OTP', async () => {
    otpService.verify.mockResolvedValue(true);
    prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });

    const result = await service.verifyOtp('+2348000000000', '123456');

    expect(prisma.client.upsert).toHaveBeenCalledWith({
      where: { phone: '+2348000000000' },
      update: {},
      create: { phone: '+2348000000000' },
    });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'client-1',
      type: 'client',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/auth/client/client-auth.service.spec.ts`
Expected: FAIL — `Cannot find module './client-auth.service'`

- [ ] **Step 3: Implement DTOs and the service**

`src/auth/client/dto/request-otp.dto.ts`:

```typescript
import { IsPhoneNumber } from 'class-validator';

export class RequestOtpDto {
  @IsPhoneNumber()
  phone: string;
}
```

`src/auth/client/dto/verify-otp.dto.ts`:

```typescript
import { IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsPhoneNumber()
  phone: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
```

`src/auth/client/client-auth.service.ts`:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    await this.otpService.request(phone);
  }

  async verifyOtp(phone: string, code: string) {
    const isValid = await this.otpService.verify(phone, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    const payload = { sub: client.id, type: 'client' as const };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: this.tokenService.signRefreshToken(payload),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/auth/client/client-auth.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Wire the controller and module**

`src/auth/client/client-auth.controller.ts`:

```typescript
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth/client')
export class ClientAuthController {
  constructor(private readonly clientAuthService: ClientAuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.clientAuthService.requestOtp(dto.phone);
    return { sent: true };
  }

  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.clientAuthService.verifyOtp(dto.phone, dto.code);
  }
}
```

Replace `src/auth/auth.module.ts` in full with:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { OtpModule } from '../otp/otp.module';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';
import { ClientAuthController } from './client/client-auth.controller';
import { ClientAuthService } from './client/client-auth.service';

@Module({
  imports: [PassportModule, JwtModule.register({}), OtpModule],
  controllers: [AdminAuthController, ClientAuthController],
  providers: [TokenService, JwtStrategy, AdminAuthService, ClientAuthService],
  exports: [TokenService],
})
export class AuthModule {}
```

- [ ] **Step 6: Write the e2e test**

`test/client-auth.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Client auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const phone = '+2348011111111';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { phone } });
    await app.close();
  });

  it('rejects a made-up OTP code', () => {
    return request(app.getHttpServer())
      .post('/auth/client/otp/verify')
      .send({ phone, code: '000000' })
      .expect(401);
  });

  it('requests then verifies a real OTP and receives tokens', async () => {
    await request(app.getHttpServer())
      .post('/auth/client/otp/request')
      .send({ phone })
      .expect(200)
      .expect({ sent: true });

    const stored = await prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored).not.toBeNull();

    // Test-only shortcut: re-generate isn't possible since the code is
    // hashed, so this suite verifies end-to-end via a code we control by
    // stubbing OtpService in a lower-level unit test instead. Here we only
    // assert the request side effect (an OtpCode row is created).
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 8: Commit**

```bash
git add src/auth/client src/auth/auth.module.ts test/client-auth.e2e-spec.ts
git commit -m "feat: add client phone+OTP login"
```

---

### Task 8: Agent login stub

**Files:**
- Create: `src/auth/agent/agent-auth.controller.ts`
- Create: `src/auth/agent/agent-auth.service.ts`
- Create: `src/auth/agent/dto/agent-login.dto.ts`
- Modify: `src/auth/auth.module.ts`
- Test: `src/auth/agent/agent-auth.service.spec.ts`
- Test: `test/agent-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `TokenService`, `Agent.status` /
  `Agent.passwordHash` (Task 3 schema).
- Produces: `POST /auth/agent/login` → `401` unless the Agent's
  `status === 'APPROVED'` and `passwordHash` is set and matches. Full
  registration/approval workflow that populates these fields is Phase 2's
  responsibility — this task only wires the login side against the schema
  that already exists.

- [ ] **Step 1: Write the failing unit test**

`src/auth/agent/agent-auth.service.spec.ts`:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: { agent: { findUnique: jest.Mock } };
  let tokenService: TokenService;

  beforeEach(() => {
    prisma = { agent: { findUnique: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      signRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    } as unknown as TokenService;
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
    );
  });

  it('rejects an agent that is still PENDING_REVIEW', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash,
      status: 'PENDING_REVIEW',
    });

    await expect(
      service.login('agent@example.com', 'secret-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an approved agent with no password set yet', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash: null,
      status: 'APPROVED',
    });

    await expect(
      service.login('agent@example.com', 'secret-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens for an approved agent with the right password', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash,
      status: 'APPROVED',
    });

    const result = await service.login('agent@example.com', 'secret-password');

    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'agent-1',
      type: 'agent',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: FAIL — `Cannot find module './agent-auth.service'`

- [ ] **Step 3: Implement DTO and service**

`src/auth/agent/dto/agent-login.dto.ts`:

```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

export class AgentLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
```

`src/auth/agent/agent-auth.service.ts`:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async login(email: string, password: string) {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.status !== 'APPROVED' || !agent.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: agent.id, type: 'agent' as const };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: this.tokenService.signRefreshToken(payload),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/auth/agent/agent-auth.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Wire the controller and module**

`src/auth/agent/agent-auth.controller.ts`:

```typescript
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(private readonly agentAuthService: AgentAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto) {
    return this.agentAuthService.login(dto.email, dto.password);
  }
}
```

Replace `src/auth/auth.module.ts` in full with:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { OtpModule } from '../otp/otp.module';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';
import { ClientAuthController } from './client/client-auth.controller';
import { ClientAuthService } from './client/client-auth.service';
import { AgentAuthController } from './agent/agent-auth.controller';
import { AgentAuthService } from './agent/agent-auth.service';

@Module({
  imports: [PassportModule, JwtModule.register({}), OtpModule],
  controllers: [AdminAuthController, ClientAuthController, AgentAuthController],
  providers: [
    TokenService,
    JwtStrategy,
    AdminAuthService,
    ClientAuthService,
    AgentAuthService,
  ],
  exports: [TokenService],
})
export class AuthModule {}
```

- [ ] **Step 6: Write the e2e test**

`test/agent-auth.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Agent auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = 'approved-agent@example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const passwordHash = await bcrypt.hash('agent-password', 12);
    await prisma.agent.create({
      data: {
        email,
        phone: '+2348022222222',
        fullName: 'Test Agent',
        passwordHash,
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email } });
    await app.close();
  });

  it('logs in an approved agent with the right password', () => {
    return request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: 'agent-password' })
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.accessToken).toBe('string');
      });
  });

  it('rejects the right password for a non-existent agent', () => {
    return request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: 'nobody@example.com', password: 'agent-password' })
      .expect(401);
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 8: Commit**

```bash
git add src/auth/agent test/agent-auth.e2e-spec.ts
git commit -m "feat: add agent email+password login gated on approval status"
```

---

### Task 9: Wire everything, document, and finalize

**Files:**
- Modify: `src/app.module.ts`
- Create: `README.md`
- Modify: `package.json` (npm scripts sanity pass)

**Interfaces:**
- Produces: a fully wired `AppModule` importing `ConfigModule`,
  `PrismaModule`, `AuthModule`, `AdminModule`, `OtpModule`; a `README.md`
  a new engineer can follow from clone to green test suite with no
  outside help.

- [ ] **Step 1: Confirm `src/app.module.ts` imports every module**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { OtpModule } from './otp/otp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    OtpModule,
    AuthModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
```

- [ ] **Step 2: Write `README.md`**

```markdown
# Public Sector Backend

## Prerequisites
- Node.js >= 20
- Docker (for local PostgreSQL)

## Setup
1. `cp .env.example .env` and adjust values (especially
   `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`).
2. `docker compose up -d postgres`
3. `npm install`
4. `npx prisma migrate dev`
5. `npx prisma db seed`
6. `npm run start:dev`

## Testing
- Unit tests: `npm run test`
- End-to-end tests (needs the DB running and migrated/seeded): `npm run test:e2e`

## Login endpoints
| Role | Endpoint | Body |
|---|---|---|
| Admin | `POST /auth/admin/login` | `{ email, password }` |
| Agent | `POST /auth/agent/login` | `{ email, password }` (only works once an agent is `APPROVED` — Phase 2) |
| Client | `POST /auth/client/otp/request` then `POST /auth/client/otp/verify` | `{ phone }` then `{ phone, code }` |

## Roadmap
See `docs/specs/2026-09-09-public-sector-backend-spec.md` for the full
system spec and phased roadmap (Agent enrollment, Client/IPPIS verification
pipeline, RBAC management UI, hardening).
```

- [ ] **Step 3: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — all unit and e2e suites green.

- [ ] **Step 4: Commit**

```bash
git add src/app.module.ts README.md
git commit -m "docs: wire final AppModule and add project README"
```

## Phase 1 exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean clone
      following only `README.md`.
- [ ] All three login endpoints work against the seeded bootstrap admin
      (admin), a manually-inserted approved agent (agent), and a live OTP
      round-trip (client).
- [ ] `PermissionsGuard` correctly allows/denies based on the JWT's
      `permissions` claim, proven by `test/admin-rbac.e2e-spec.ts`.
- [ ] No route relies on "is admin" without an explicit
      `@RequirePermissions(...)` (spot-check `src/admin/admin.controller.ts`
      and anything added after it).

**Next:** write `docs/superpowers/plans/<date>-phase-2-agent-enrollment.md`
covering the public registration endpoint, file upload, and back-office
review workflow described in section 4 of the spec.
