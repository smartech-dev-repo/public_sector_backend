# Admin Department & Single-Role Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-CRUD `Department` entity, give `Role` an optional editable department, and restructure `AdminUser`↔`Role` from today's unconstrained many-to-many into exactly one required role per admin, with department inherited (copied) onto the admin whenever their role is set.

**Architecture:** `Department` is a new, independent module mirroring the existing `Role`/`Permission` pattern exactly. `Role` gets an additive, optional `departmentId` FK — non-breaking on its own. The `AdminUser`↔`Role` restructure (dropping the `AdminUserRole` join table for a direct required `AdminUser.roleId`) is one atomic unit of work: Prisma's generated types couple the schema change to every consuming service, so schema + all four consuming services + the seed script + their tests must land together in one task, or the codebase won't compile in between.

**Tech Stack:** NestJS, Prisma, `class-validator`, Jest + Supertest, the shared `PaginationDto`/`buildPaginatedResult` convention already established in this codebase.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-department-single-role-design.md`

## Global Constraints

- New `Department` model: `id`, `name` (unique), `description?`, `createdAt`.
- New permission `departments:manage` gates all five Department endpoints (added to `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS`).
- `GET /admin/departments` is paginated from day one (`page`/`limit` default 1/25 max 100, `q` searches `name`) — this project's standing list-endpoint convention.
- `Role.departmentId` is optional and freely editable, including on SUPER_ADMIN.
- `AdminUser.roleId` becomes required; `AdminUser.departmentId` is denormalized, copied from the role's `departmentId` every time the role is set (including at invite-accept time and at the one-time backfill).
- `AdminUserRole` (the join table) is dropped entirely. `assignRole`/`removeRole` (two calls) collapse into one `setRole(adminId, roleId)` / `PATCH /admin/admins/:id/role`.
- No `Co-Authored-By: Claude` trailer on any commit.
- This plan is its own complete phase — its closing task runs the full unit + e2e suite.

---

### Task 1: `Department` entity — full CRUD

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/admin-department/department.service.ts`
- Create: `src/admin-department/department.service.spec.ts`
- Create: `src/admin-department/dto/create-department.dto.ts`
- Create: `src/admin-department/dto/update-department.dto.ts`
- Create: `src/admin-department/dto/list-departments-query.dto.ts`
- Create: `src/admin-department/admin-departments.controller.ts`
- Create: `src/admin-department/admin-department.module.ts`
- Modify: `src/app.module.ts`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (`src/common/pagination/`).
- Produces: `DepartmentService.create/list/findById/update/remove`, all importable from `src/admin-department/department.service.ts`, consumed by Task 2 (`RoleService`) and Task 3 (`AdminRoleAssignmentService`/`AdminAuthService`) only via the `Department` Prisma model they create rows in — no direct service-to-service dependency.

- [ ] **Step 1: Add the `Department` model and give `Role` nothing yet (Task 2's job)**

In `prisma/schema.prisma`, add a new model anywhere near `Role`/`Permission`:

```prisma
model Department {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  createdAt   DateTime @default(now())
}
```

Run: `npx prisma migrate dev --name add_department`
Expected: a new migration folder appears under `prisma/migrations/`, Prisma client regenerates with a `Department` model.

- [ ] **Step 2: Write the failing unit tests**

Create `src/admin-department/department.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DepartmentService } from './department.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DepartmentService', () => {
  let service: DepartmentService;
  let prisma: {
    department: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    role: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      department: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      role: { count: jest.fn() },
    };
    service = new DepartmentService(prisma as unknown as PrismaService);
  });

  it('create stores the name and description', async () => {
    prisma.department.create.mockResolvedValue({ id: 'dept-1', name: 'Finance', description: 'Finance team' });
    const result = await service.create({ name: 'Finance', description: 'Finance team' });
    expect(prisma.department.create).toHaveBeenCalledWith({ data: { name: 'Finance', description: 'Finance team' } });
    expect(result.id).toBe('dept-1');
  });

  it('create converts a duplicate-name DB error into ConflictException', async () => {
    prisma.department.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ name: 'Finance' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.department.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('update throws NotFoundException for an unknown id', async () => {
    prisma.department.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
  });

  it('update updates the given fields', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.department.update.mockResolvedValue({ id: 'dept-1', name: 'Finance & Accounts' });
    await service.update('dept-1', { name: 'Finance & Accounts' });
    expect(prisma.department.update).toHaveBeenCalledWith({
      where: { id: 'dept-1' },
      data: { name: 'Finance & Accounts', description: undefined },
    });
  });

  it('remove rejects deleting a department assigned to any role', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.role.count.mockResolvedValue(1);
    await expect(service.remove('dept-1')).rejects.toThrow(ConflictException);
    expect(prisma.department.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an unused department', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.role.count.mockResolvedValue(0);
    await service.remove('dept-1');
    expect(prisma.department.delete).toHaveBeenCalledWith({ where: { id: 'dept-1' } });
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(0);
      const result = await service.list();
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: undefined }, orderBy: { name: 'asc' }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by name', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(0);
      await service.list({ q: 'fina' });
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: { contains: 'fina', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(9);
      const result = await service.list({}, { page: 2, limit: 4 });
      expect(prisma.department.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 4 }));
      expect(result.meta).toEqual({ total: 9, page: 2, limit: 4, totalPages: 3 });
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/admin-department/department.service.spec.ts`
Expected: FAIL — `Cannot find module './department.service'`.

- [ ] **Step 4: Implement `DepartmentService`**

Create `src/admin-department/department.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Department, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';

export interface CreateDepartmentParams {
  name: string;
  description?: string;
}

export interface UpdateDepartmentParams {
  name?: string;
  description?: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class DepartmentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateDepartmentParams): Promise<Department> {
    try {
      return await this.prisma.department.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A department named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: { q?: string } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<Department>> {
    const { page, limit } = pagination;
    const where: Prisma.DepartmentWhereInput = {
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.department.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.department.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(id: string): Promise<Department> {
    const department = await this.prisma.department.findUnique({ where: { id } });
    if (!department) {
      throw new NotFoundException('Department not found');
    }
    return department;
  }

  async update(id: string, params: UpdateDepartmentParams): Promise<Department> {
    await this.findById(id);
    return this.prisma.department.update({ where: { id }, data: params });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    const roleCount = await this.prisma.role.count({ where: { departmentId: id } });
    if (roleCount > 0) {
      throw new ConflictException('Cannot delete a department that is currently assigned to one or more roles');
    }
    await this.prisma.department.delete({ where: { id } });
  }
}
```

(`this.prisma.role.count({ where: { departmentId: id } })` will not type-check until Task 2 adds `departmentId` to `Role` — this is fine, Task 1 and Task 2 land together in practice since Task 1 alone leaves `tsc` red on this one line; if executing strictly task-by-task, note this in your Task 1 commit message and proceed straight to Task 2 before considering Task 1 "done".)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/admin-department/department.service.spec.ts`
Expected: PASS (10/10).

- [ ] **Step 6: Create the DTOs**

Create `src/admin-department/dto/create-department.dto.ts`:

```typescript
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateDepartmentDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

Create `src/admin-department/dto/update-department.dto.ts`:

```typescript
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

Create `src/admin-department/dto/list-departments-query.dto.ts`:

```typescript
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListDepartmentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;
}
```

- [ ] **Step 7: Create the controller**

Read `src/admin-rbac/admin-roles.controller.ts` first to match its exact audit-logging pattern. Create `src/admin-department/admin-departments.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { DepartmentService } from './department.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { ListDepartmentsQueryDto } from './dto/list-departments-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/departments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminDepartmentsController {
  constructor(
    private readonly departmentService: DepartmentService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('departments:manage')
  async create(@Body() dto: CreateDepartmentDto, @Req() req: { user: JwtPayload }) {
    const department = await this.departmentService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'department.created',
      targetType: 'Department',
      targetId: department.id,
      metadata: { name: department.name },
    });
    return department;
  }

  @Get()
  @RequirePermissions('departments:manage')
  list(@Query() query: ListDepartmentsQueryDto) {
    return this.departmentService.list({ q: query.q }, { page: query.page, limit: query.limit });
  }

  @Get(':id')
  @RequirePermissions('departments:manage')
  findOne(@Param('id') id: string) {
    return this.departmentService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('departments:manage')
  update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto) {
    return this.departmentService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('departments:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.departmentService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'department.deleted',
      targetType: 'Department',
      targetId: id,
    });
    return { deleted: true };
  }
}
```

- [ ] **Step 8: Create the module and register it**

Create `src/admin-department/admin-department.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DepartmentService } from './department.service';
import { AdminDepartmentsController } from './admin-departments.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminDepartmentsController],
  providers: [DepartmentService],
})
export class AdminDepartmentModule {}
```

In `src/app.module.ts`, add `import { AdminDepartmentModule } from './admin-department/admin-department.module';` near the other feature-module imports, and add `AdminDepartmentModule` to the `imports` array near `AdminRbacModule`.

- [ ] **Step 9: Add the permission to the seed script**

In `prisma/seed.ts`, add a new entry to `BOOTSTRAP_PERMISSIONS`:

```typescript
  { key: 'departments:manage', description: 'Create, edit, and delete department definitions' },
```

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean (the `role.count({ where: { departmentId: id } })` line in `DepartmentService.remove` requires `Role.departmentId` to exist — if this fails here because Task 2 hasn't run yet, that's expected per Step 4's note; proceed directly to Task 2 before treating this as a blocker).

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts src/admin-department/ src/app.module.ts
git commit -m "feat: add Department entity with full CRUD"
```

---

### Task 2: `Role` gains an optional, editable `departmentId`

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/admin-rbac/role.service.ts`
- Modify: `src/admin-rbac/role.service.spec.ts`
- Modify: `src/admin-rbac/dto/create-role.dto.ts`
- Modify: `src/admin-rbac/dto/update-role.dto.ts`

**Interfaces:**
- Consumes: `Department` model (Task 1).
- Produces: `RoleService.create`'s `CreateRoleParams` and `RoleService.update`'s `UpdateRoleParams` both gain `departmentId?: string` — Task 3's `AdminRoleAssignmentService.setRole` reads `role.departmentId` directly off the Prisma `Role` row, not through these params.

- [ ] **Step 1: Add `departmentId` to the `Role` model**

In `prisma/schema.prisma`, find the `Role` model and add:

```prisma
model Role {
  id           String           @id @default(uuid())
  name         String           @unique
  description  String?
  departmentId String?
  department   Department?      @relation(fields: [departmentId], references: [id])
  permissions  RolePermission[]
  admins       AdminUserRole[]
  invites      AdminInvite[]
  createdAt    DateTime         @default(now())
}
```

(`admins AdminUserRole[]` is still present here — Task 3 removes it. Leaving it for this task keeps the diff focused on `Role` alone.)

Run: `npx prisma migrate dev --name add_role_department`
Expected: new migration created and applied.

- [ ] **Step 2: Update the failing unit tests**

Read `src/admin-rbac/role.service.spec.ts` in full first. Replace the existing `'update allows editing SUPER_ADMIN description without touching name'` test:

```typescript
  it('update allows editing SUPER_ADMIN description without touching name', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({ where: { id: 'role-1' }, data: { name: undefined, description: 'new' } });
  });
```

with:

```typescript
  it('update allows editing SUPER_ADMIN description without touching name', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: 'new', departmentId: undefined },
    });
  });

  it('create stores the departmentId when given', async () => {
    prisma.role.create.mockResolvedValue({ id: 'role-2', name: 'REVIEWER', departmentId: 'dept-1' });
    await service.create({ name: 'REVIEWER', departmentId: 'dept-1' });
    expect(prisma.role.create).toHaveBeenCalledWith({ data: { name: 'REVIEWER', departmentId: 'dept-1' } });
  });

  it('update sets departmentId when given, and clears it when explicitly set to null', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'REVIEWER' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'REVIEWER', departmentId: null });
    await service.update('role-1', { departmentId: null });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: undefined, departmentId: null },
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: FAIL — `create`/`update` don't accept `departmentId` yet, and the existing test's strict `toHaveBeenCalledWith` doesn't yet include `departmentId: undefined`.

- [ ] **Step 4: Update `RoleService`**

In `src/admin-rbac/role.service.ts`, replace:

```typescript
export interface CreateRoleParams {
  name: string;
  description?: string;
}

export interface UpdateRoleParams {
  name?: string;
  description?: string;
}
```

with:

```typescript
export interface CreateRoleParams {
  name: string;
  description?: string;
  departmentId?: string;
}

export interface UpdateRoleParams {
  name?: string;
  description?: string;
  departmentId?: string | null;
}
```

Replace:

```typescript
  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params });
```

with (unchanged body — `params` already includes `departmentId` now via the widened interface, Prisma's `data` accepts it directly):

```typescript
  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params });
```

(No further change needed inside `create` — only the interface widened.)

Replace:

```typescript
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description },
    });
```

with:

```typescript
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description, departmentId: params.departmentId },
    });
```

- [ ] **Step 5: Update the DTOs**

In `src/admin-rbac/dto/create-role.dto.ts`, add an optional `departmentId` field:

```typescript
  @IsOptional()
  @IsUUID()
  departmentId?: string;
```

(add the corresponding `IsOptional, IsUUID` names to the existing `class-validator` import line — read the file first to see its exact current import list and field set before editing.)

In `src/admin-rbac/dto/update-role.dto.ts`, add the same optional `departmentId?: string` field (read the file first — if it already extends `CreateRoleDto` via `PartialType` or similar, the field may already be inherited; only add it directly if the DTO is hand-written with its own fields, matching whichever pattern the file actually uses).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 7: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean — this also resolves Task 1's `DepartmentService.remove`'s `Role.departmentId` reference.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/admin-rbac/role.service.ts src/admin-rbac/role.service.spec.ts src/admin-rbac/dto/create-role.dto.ts src/admin-rbac/dto/update-role.dto.ts
git commit -m "feat: add optional, editable department to roles"
```

---

### Task 3: `AdminUser` → exactly one required role, with inherited department (atomic — schema + all consumers together)

**This task cannot be split across commits that each compile independently** — Prisma's generated types tie the schema shape to every consumer. Work through all the steps below, then commit once at the end.

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/admin-rbac/admin-role-assignment.service.ts`
- Modify: `src/admin-rbac/admin-role-assignment.service.spec.ts`
- Modify: `src/admin-rbac/admin-role-assignment.controller.ts`
- Modify: `src/admin-rbac/dto/assign-role.dto.ts` (rename/repurpose, see Step 8)
- Modify: `src/admin-rbac/role.service.ts`
- Modify: `src/admin-rbac/role.service.spec.ts`
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`
- Modify: `prisma/seed.ts`
- Modify: `test/seed.e2e-spec.ts`
- Modify: `test/admin-role-assignment.e2e-spec.ts`

**Interfaces:**
- Consumes: `Department`/`Role.departmentId` (Tasks 1-2).
- Produces: `AdminRoleAssignmentService.setRole(adminId: string, roleId: string): Promise<void>` (replaces `assignRole`/`removeRole`). `PATCH /admin/admins/:id/role` (replaces `POST .../roles` + `DELETE .../roles/:roleId`).

- [ ] **Step 1: Migrate the schema in three steps (nullable → backfill → required, then drop the join table)**

In `prisma/schema.prisma`, first add `roleId`/`departmentId` as **nullable** columns to `AdminUser`, and remove the `roles AdminUserRole[]` line:

```prisma
model AdminUser {
  id           String            @id @default(uuid())
  email        String            @unique
  passwordHash String
  fullName     String
  isActive     Boolean           @default(true)
  roleId       String?
  role         Role?             @relation(fields: [roleId], references: [id])
  departmentId String?
  department   Department?       @relation(fields: [departmentId], references: [id])
  sentInvites  AdminInvite[]
  uploadedDocumentBatches DocumentUploadBatch[]
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
  twoFactorMethod             TwoFactorMethod?
  twoFactorEnabled            Boolean          @default(false)
  twoFactorSecret             String?
  twoFactorPendingSecret      String?
  twoFactorPendingMethod      TwoFactorMethod?
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
}
```

Leave `AdminUserRole` and `Role`'s `admins AdminUserRole[]` line untouched for now — do not delete them in this step. Prisma requires a required column to be added in two phases on a non-empty table (nullable first, backfilled, then set `NOT NULL`), so this task's schema work is split into three sub-steps:

- **1a (this step)**: add `AdminUser.roleId String?` and `AdminUser.departmentId String?` as nullable columns only. `AdminUserRole` and `Role.admins` stay exactly as they are.

Run: `npx prisma migrate dev --name adminuser_add_nullable_role_department`
Expected: new migration created and applied, Prisma client regenerates with the two new nullable columns.

- **1b**: run the data-backfill script (Step 2 below) that populates `roleId`/`departmentId` for every existing `AdminUser` from their current `AdminUserRole` data.

- **1c**: once backfilled, alter `AdminUser.roleId` to required (drop the `?`), remove `roles AdminUserRole[]` from `AdminUser` (already absent — it was removed above), remove `admins AdminUserRole[]` from `Role`, and delete the `AdminUserRole` model entirely (this is Step 3 below).

- [ ] **Step 2: Write and run the data-backfill script**

Create a throwaway script at `prisma/backfill-admin-role.ts` (deleted at the end of this task, not part of the final commit — it's a one-time migration aid, not application code):

```typescript
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const admins = await prisma.adminUser.findMany({
    include: { roles: { include: { role: true }, orderBy: { roleId: 'asc' } } },
  });

  for (const admin of admins) {
    if (admin.roles.length === 0) {
      console.warn(`Admin ${admin.email} (${admin.id}) has no role assigned — skipping, needs manual review`);
      continue;
    }
    if (admin.roles.length > 1) {
      console.warn(
        `Admin ${admin.email} (${admin.id}) has ${admin.roles.length} roles — collapsing to the lowest roleId (${admin.roles[0].roleId}), review if this is wrong`,
      );
    }
    const chosen = admin.roles[0];
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { roleId: chosen.roleId, departmentId: chosen.role.departmentId },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
```

Run: `npx ts-node prisma/backfill-admin-role.ts`
Expected: every existing `AdminUser` row (in your local dev DB — this includes the bootstrap admin seeded earlier) now has `roleId` set; any warnings printed identify admins that need manual follow-up. On a fresh local DB with just the seeded bootstrap admin, expect one line of output confirming that admin now has `roleId` set to the SUPER_ADMIN role, no warnings.

Delete the script once it's run successfully: `rm prisma/backfill-admin-role.ts` (it must not be part of the final commit — this repo has no precedent for keeping one-off data-migration scripts in the tree, and it has no purpose once every environment's data is backfilled via the SQL migration below).

**Note on production/CI environments**: the schema migration in Step 1c requires `roleId` to be non-null on every row before it can be marked `NOT NULL`. Since this plan is developed and tested against a local dev DB, the equivalent backfill for any other environment (staging, CI's own test DB) needs the same logic — the cleanest way to guarantee that is to fold the backfill into the migration SQL itself rather than relying on a separately-run TS script. Do this: after running Step 1a's migration and this TS script locally to prove the logic, open the actual generated migration file from Step 1c (`prisma/migrations/<timestamp>_adminuser_role_required_drop_join_table/migration.sql`) **before** running it, and manually insert equivalent `UPDATE` SQL ahead of the `ALTER TABLE ... SET NOT NULL` line:

```sql
UPDATE "AdminUser" au
SET "roleId" = sub."roleId", "departmentId" = r."departmentId"
FROM (
  SELECT DISTINCT ON ("adminUserId") "adminUserId", "roleId"
  FROM "AdminUserRole"
  ORDER BY "adminUserId", "roleId" ASC
) sub
JOIN "Role" r ON r.id = sub."roleId"
WHERE au.id = sub."adminUserId";
```

(placed after the `ALTER TABLE "AdminUser" ADD COLUMN` lines from this same migration if Prisma batched Step 1c's nullable-add and NOT-NULL-set into one file, or as the very first statement if Step 1a already ran separately — check the actual generated file's statement order before inserting, since this determines exact placement.) This makes the migration self-contained and safe to run against any environment's data, not just your local machine where you happened to run the TS script by hand.

- [ ] **Step 3: Run the required-column migration**

In `prisma/schema.prisma`, change `AdminUser.roleId` from `String?` to `String` (drop the `?`), remove the `admins AdminUserRole[]` line from the `Role` model, and delete the entire `AdminUserRole` model block. `AdminUser` and `Role` should now read exactly:

```prisma
model AdminUser {
  id           String            @id @default(uuid())
  email        String            @unique
  passwordHash String
  fullName     String
  isActive     Boolean           @default(true)
  roleId       String
  role         Role              @relation(fields: [roleId], references: [id])
  departmentId String?
  department   Department?       @relation(fields: [departmentId], references: [id])
  sentInvites  AdminInvite[]
  uploadedDocumentBatches DocumentUploadBatch[]
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
  twoFactorMethod             TwoFactorMethod?
  twoFactorEnabled            Boolean          @default(false)
  twoFactorSecret             String?
  twoFactorPendingSecret      String?
  twoFactorPendingMethod      TwoFactorMethod?
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
}

model Role {
  id           String           @id @default(uuid())
  name         String           @unique
  description  String?
  departmentId String?
  department   Department?      @relation(fields: [departmentId], references: [id])
  permissions  RolePermission[]
  admins       AdminUser[]
  invites      AdminInvite[]
  createdAt    DateTime         @default(now())
}
```

Run `npx prisma migrate dev --name adminuser_role_required_drop_join_table` **but do not let it apply automatically without inspection** — Prisma will prompt/generate the migration file; open the generated
`prisma/migrations/<timestamp>_adminuser_role_required_drop_join_table/migration.sql`
before it's applied (or run `npx prisma migrate dev --create-only --name adminuser_role_required_drop_join_table` to generate without applying) and insert the backfill `UPDATE` SQL from Step 2 as the first statement in the file, before the `ALTER TABLE "AdminUser" ALTER COLUMN "roleId" SET NOT NULL` line and before the `DROP TABLE "AdminUserRole"` line. Then run `npx prisma migrate dev` again (no `--create-only`) to apply it.

Expected: migration applies cleanly (no NOT NULL constraint violation, since the backfill SQL ran first within the same migration file), Prisma client regenerates — `AdminUser.role` is now a required relation, `AdminUserRole` no longer exists as a model, `Role.admins` is now `AdminUser[]` (the reverse side of the direct relation) instead of `AdminUserRole[]`.

- [ ] **Step 4: Write the failing unit tests for `AdminRoleAssignmentService.setRole`**

Read `src/admin-rbac/admin-role-assignment.service.spec.ts` in full first. Replace the `assignRole`/`removeRole` mock shape and tests. Replace the `prisma` type declaration and `beforeEach`:

```typescript
  let prisma: {
    adminUser: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; count: jest.Mock };
    role: { findUnique: jest.Mock };
  };
  let sessionService: { revokeAllForPrincipal: jest.Mock };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
      role: { findUnique: jest.fn() },
    };
    sessionService = { revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined) };
    service = new AdminRoleAssignmentService(prisma as unknown as PrismaService, sessionService as unknown as SessionService);
  });
```

Replace:

```typescript
  it('listAdmins returns admins with roles included', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await service.listAdmins();
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ roles: expect.anything() }) }),
    );
  });
```

with:

```typescript
  it('listAdmins returns admins with role and department included', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await service.listAdmins();
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ role: true, department: true }) }),
    );
  });
```

Replace the entire block from `'assignRole throws NotFoundException for an unknown admin'` through `'removeRole is a no-op (not an error) if the admin never had SUPER_ADMIN'` (i.e. every `assignRole`/`removeRole` test) with:

```typescript
  describe('setRole', () => {
    it('throws NotFoundException for an unknown admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.setRole('missing-admin', 'role-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for an unknown role', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.setRole('admin-1', 'missing-role')).rejects.toThrow(NotFoundException);
    });

    it('sets the new roleId and copies the new role\'s departmentId', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: 'dept-1' });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { roleId: 'role-new', departmentId: 'dept-1' },
      });
    });

    it('copies a null departmentId when the new role has none', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: null });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { roleId: 'role-new', departmentId: null },
      });
    });

    it('allows moving an admin off SUPER_ADMIN when other admins still hold it', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'REVIEWER', departmentId: null });
      prisma.adminUser.count.mockResolvedValue(2);

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalled();
    });

    it('rejects moving the last SUPER_ADMIN holder to a different role', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'REVIEWER', departmentId: null });
      prisma.adminUser.count.mockResolvedValue(1);

      await expect(service.setRole('admin-1', 'role-new')).rejects.toThrow(ConflictException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('does not apply the last-holder guard when the admin is already SUPER_ADMIN and stays SUPER_ADMIN', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'super-admin-role', name: 'SUPER_ADMIN', departmentId: null });

      await service.setRole('admin-1', 'super-admin-role');

      expect(prisma.adminUser.count).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).toHaveBeenCalled();
    });

    it('does not apply the last-holder guard when the admin is not currently SUPER_ADMIN', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: null });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.count).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).toHaveBeenCalled();
    });
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: FAIL — `setRole` doesn't exist yet, `listAdmins`'s select shape hasn't changed yet.

- [ ] **Step 6: Rewrite `AdminRoleAssignmentService`**

Replace the full contents of `src/admin-rbac/admin-role-assignment.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { SessionPrincipalType } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

export interface ListAdminsFilters {
  isActive?: boolean;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AdminRoleAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async listAdmins(
    filters: ListAdminsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where = {
      isActive: filters.isActive,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { email: { contains: filters.q, mode: 'insensitive' as const } },
            { fullName: { contains: filters.q, mode: 'insensitive' as const } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.adminUser.findMany({
        where,
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          createdAt: true,
          role: true,
          department: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminUser.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async setRole(adminId: string, roleId: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: { role: true },
    });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    const newRole = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!newRole) {
      throw new NotFoundException('Role not found');
    }

    const movingAwayFromSuperAdmin = admin.role.name === SUPER_ADMIN_ROLE_NAME && newRole.id !== admin.role.id;
    if (movingAwayFromSuperAdmin) {
      const holderCount = await this.prisma.adminUser.count({ where: { roleId: admin.role.id } });
      if (holderCount <= 1) {
        throw new ConflictException('Cannot remove the last admin holding the SUPER_ADMIN role');
      }
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { roleId: newRole.id, departmentId: newRole.departmentId },
    });
  }

  async deactivate(callerId: string, id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (id === callerId) {
      throw new ConflictException('Cannot deactivate your own account');
    }
    if (!admin.isActive) {
      throw new ConflictException('Admin is already deactivated');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: false } });
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, id, 'admin_deactivated');
  }

  async reactivate(id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (admin.isActive) {
      throw new ConflictException('Admin is already active');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: true } });
  }
}
```

- [ ] **Step 7: Update `AdminRoleAssignmentController`**

Read `src/admin-rbac/admin-role-assignment.controller.ts` in full first. Replace:

```typescript
  @Post(':id/roles')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignRole(
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.assignRole(id, dto.roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.assigned',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId: dto.roleId },
    });
    return { assigned: true };
  }

  @Delete(':id/roles/:roleId')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.removeRole(id, roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.removed',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId },
    });
    return { removed: true };
  }
```

with:

```typescript
  @Patch(':id/role')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async setRole(
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.setRole(id, dto.roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.set',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId: dto.roleId },
    });
    return { updated: true };
  }
```

Add `Patch` to this controller's `@nestjs/common` import (remove `Delete` from it only if nothing else in the file still uses it — check first). `AssignRoleDto` stays imported and used as-is (its `{ roleId }` shape is unchanged).

- [ ] **Step 8: Update `RoleService.remove`'s guard**

In `src/admin-rbac/role.service.ts`, find:

```typescript
    const assignmentCount = await this.prisma.adminUserRole.count({ where: { roleId: id } });
```

Replace with:

```typescript
    const assignmentCount = await this.prisma.adminUser.count({ where: { roleId: id } });
```

- [ ] **Step 9: Update the corresponding `role.service.spec.ts` test**

In `src/admin-rbac/role.service.spec.ts`, replace the `prisma` mock's `adminUserRole: { count: jest.Mock }` declaration and instantiation with `adminUser: { count: jest.fn() }` (added to whatever `role`/`permission`/`rolePermission` mocks already exist there — do not remove those). Replace `prisma.adminUserRole.count.mockResolvedValue(...)` with `prisma.adminUser.count.mockResolvedValue(...)` in both `'remove rejects deleting a role assigned to any admin'` and `'remove deletes an unused, non-SUPER_ADMIN role'`.

- [ ] **Step 10: Update `AdminAuthService.getPermissionsForAdmin` and `acceptInvite`**

In `src/auth/admin/admin-auth.service.ts`, replace:

```typescript
  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        roles: {
          include: {
            role: { include: { permissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!admin) {
      return [];
    }

    return Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );
  }
```

with:

```typescript
  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });

    if (!admin) {
      return [];
    }

    return admin.role.permissions.map((rp) => rp.permission.key);
  }
```

Replace:

```typescript
  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roles: { create: { roleId: invite.roleId } },
      },
    });

    await this.adminInviteService.markAccepted(invite.id);

    return this.issueTokens(admin.id, meta);
  }
```

with:

```typescript
  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: invite.roleId } });

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roleId: role.id,
        departmentId: role.departmentId,
      },
    });

    await this.adminInviteService.markAccepted(invite.id);

    return this.issueTokens(admin.id, meta);
  }
```

- [ ] **Step 11: Update `admin-auth.service.spec.ts`**

Read the file in full first. Add `role: { findUniqueOrThrow: jest.Mock }` to the `prisma` mock's type declaration and instantiation. Replace:

```typescript
  it('getPermissionsForAdmin flattens and de-duplicates permission keys', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      roles: [
        { role: { permissions: [{ permission: { key: 'agents:read' } }] } },
        { role: { permissions: [{ permission: { key: 'agents:read' } }, { permission: { key: 'roles:manage' } }] } },
      ],
    });

    const permissions = await service.getPermissionsForAdmin('admin-1');

    expect(permissions.sort()).toEqual(['agents:read', 'roles:manage']);
  });
```

with:

```typescript
  it('getPermissionsForAdmin reads permission keys off the admin\'s single role', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: {
        permissions: [
          { permission: { key: 'agents:read' } },
          { permission: { key: 'roles:manage' } },
        ],
      },
    });

    const permissions = await service.getPermissionsForAdmin('admin-1');

    expect(permissions.sort()).toEqual(['agents:read', 'roles:manage']);
  });
```

Replace:

```typescript
  it('acceptInvite creates the AdminUser, assigns the invited role, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      roles: [{ role: { permissions: [] } }],
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new-admin@example.com',
        fullName: 'New Admin',
        roles: { create: { roleId: 'role-1' } },
      }),
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
```

with:

```typescript
  it('acceptInvite creates the AdminUser with the invited role and its department, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.role.findUniqueOrThrow.mockResolvedValue({ id: 'role-1', departmentId: 'dept-1' });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: { permissions: [] },
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: {
        email: 'new-admin@example.com',
        passwordHash: expect.any(String),
        fullName: 'New Admin',
        roleId: 'role-1',
        departmentId: 'dept-1',
      },
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
```

- [ ] **Step 12: Update `prisma/seed.ts`**

Replace:

```typescript
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
```

with:

```typescript
  await prisma.adminUser.upsert({
    where: { email: bootstrapEmail },
    update: {},
    create: {
      email: bootstrapEmail,
      passwordHash,
      fullName: bootstrapName,
      roleId: superAdminRole.id,
      departmentId: superAdminRole.departmentId,
    },
  });
```

- [ ] **Step 13: Update `test/seed.e2e-spec.ts`**

Replace:

```typescript
  it('creates the bootstrap admin with the SUPER_ADMIN role', async () => {
    const admin = await prisma.adminUser.findUnique({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
      include: { roles: { include: { role: true } } },
    });

    expect(admin).not.toBeNull();
    expect(admin!.roles.some((r) => r.role.name === 'SUPER_ADMIN')).toBe(true);
  });
```

with:

```typescript
  it('creates the bootstrap admin with the SUPER_ADMIN role', async () => {
    const admin = await prisma.adminUser.findUnique({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
      include: { role: true },
    });

    expect(admin).not.toBeNull();
    expect(admin!.role.name).toBe('SUPER_ADMIN');
  });
```

- [ ] **Step 14: Update `test/admin-role-assignment.e2e-spec.ts`**

Read the whole file first. Replace the `secondAdmin` creation:

```typescript
    const secondAdmin = await prisma.adminUser.create({
      data: { email: secondAdminEmail, passwordHash: secondAdminPasswordHash, fullName: 'E2E Deactivate Target' },
    });
```

with:

```typescript
    const secondAdmin = await prisma.adminUser.create({
      data: {
        email: secondAdminEmail,
        passwordHash: secondAdminPasswordHash,
        fullName: 'E2E Deactivate Target',
        roleId: testRoleId,
      },
    });
```

Replace `afterAll`:

```typescript
  afterAll(async () => {
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: bootstrapAdminId, roleId: testRoleId } });
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await prisma.adminUser.deleteMany({ where: { id: secondAdminId } });
    await app.close();
  });
```

with:

```typescript
  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: secondAdminId } });
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await app.close();
  });
```

Replace:

```typescript
  it('lists admins including the bootstrap admin with SUPER_ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const bootstrapEntry = res.body.data.find((a: { id: string }) => a.id === bootstrapAdminId);
    expect(bootstrapEntry.roles.some((r: { role: { name: string } }) => r.role.name === 'SUPER_ADMIN')).toBe(true);
  });

  it('assigns an additional role to the bootstrap admin', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${bootstrapAdminId}/roles`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
      .expect(200)
      .expect({ assigned: true });
  });

  it('removes the additional role from the bootstrap admin', () => {
    return request(app.getHttpServer())
      .delete(`/admin/admins/${bootstrapAdminId}/roles/${testRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ removed: true });
  });

  it('rejects removing SUPER_ADMIN from the bootstrap admin if it is the only holder (409)', async () => {
    const otherSuperAdmins = await prisma.adminUserRole.count({
      where: { roleId: superAdminRoleId, adminUserId: { not: bootstrapAdminId } },
    });
    // This test's assertion only holds if the bootstrap admin is genuinely
    // the only SUPER_ADMIN holder in this environment, which is true on a
    // freshly seeded database and expected to remain true in CI/test runs
    // that don't independently create other SUPER_ADMIN admins.
    if (otherSuperAdmins > 0) {
      return;
    }
    return request(app.getHttpServer())
      .delete(`/admin/admins/${bootstrapAdminId}/roles/${superAdminRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });
```

with:

```typescript
  it('lists admins including the bootstrap admin with SUPER_ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const bootstrapEntry = res.body.data.find((a: { id: string }) => a.id === bootstrapAdminId);
    expect(bootstrapEntry.role.name).toBe('SUPER_ADMIN');
  });

  it('changes the second admin\'s role via PATCH', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/admins/${secondAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: superAdminRoleId })
      .expect(200)
      .expect({ updated: true });

    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const entry = res.body.data.find((a: { id: string }) => a.id === secondAdminId);
    expect(entry.role.name).toBe('SUPER_ADMIN');

    // put it back so the last-holder test below still sees exactly one
    // extra SUPER_ADMIN holder if it needs to skip, not two.
    await request(app.getHttpServer())
      .patch(`/admin/admins/${secondAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
      .expect(200);
  });

  it('rejects moving the sole SUPER_ADMIN holder to a different role (409)', async () => {
    const otherSuperAdmins = await prisma.adminUser.count({
      where: { roleId: superAdminRoleId, id: { not: bootstrapAdminId } },
    });
    // This test's assertion only holds if the bootstrap admin is genuinely
    // the only SUPER_ADMIN holder in this environment, which is true on a
    // freshly seeded database and expected to remain true in CI/test runs
    // that don't independently create other SUPER_ADMIN admins.
    if (otherSuperAdmins > 0) {
      return;
    }
    return request(app.getHttpServer())
      .patch(`/admin/admins/${bootstrapAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
      .expect(409);
  });
```

- [ ] **Step 15: Run every affected unit test file**

Run: `npx jest src/admin-rbac src/auth/admin`
Expected: PASS — every unit suite across both directories.

- [ ] **Step 16: Run `tsc` to confirm no type errors anywhere**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 17: Run the two affected e2e files**

Run: `npx jest --config ./test/jest-e2e.json test/seed.e2e-spec.ts test/admin-role-assignment.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 18: Commit (single commit — see the note at the top of this task)**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts src/admin-rbac/ src/auth/admin/ test/seed.e2e-spec.ts test/admin-role-assignment.e2e-spec.ts
git commit -m "feat: restructure AdminUser to exactly one required role, inherit department"
```

---

### Task 4: e2e coverage for Department + inheritance, README, Postman, and the full test suite

**Files:**
- Create: `test/admin-departments.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-3.

- [ ] **Step 1: Write the new Department e2e test**

Create `test/admin-departments.e2e-spec.ts`. Read `test/admin-loan-terms.e2e-spec.ts` first for this codebase's exact admin-login `beforeAll` pattern (`POST /auth/admin/login` with `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`). Structure:

```typescript
import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin departments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const departmentName = `E2E-Department-${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.role.deleteMany({ where: { name: { startsWith: 'E2E-DEPT-ROLE-' } } });
    await prisma.department.deleteMany({ where: { name: departmentName } });
    await app.close();
  });

  it('creates, lists, updates, and deletes a department; blocks deleting one still assigned to a role', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/departments')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: departmentName, description: 'E2E test department' })
      .expect(201);
    const departmentId = createRes.body.id;

    const listRes = await request(app.getHttpServer())
      .get('/admin/departments')
      .query({ q: departmentName })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(listRes.body.data.some((d: { id: string }) => d.id === departmentId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ description: 'Updated description' })
      .expect(200)
      .expect((res) => expect(res.body.description).toBe('Updated description'));

    const roleRes = await request(app.getHttpServer())
      .post('/admin/roles')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: `E2E-DEPT-ROLE-${Date.now()}`, departmentId })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);

    await prisma.role.deleteMany({ where: { id: roleRes.body.id } });

    await request(app.getHttpServer())
      .delete(`/admin/departments/${departmentId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });
});
```

Before finalizing, confirm the exact `POST /admin/roles`/`POST /admin/departments` success status code by reading `src/admin-rbac/admin-roles.controller.ts`'s `create` method (NestJS defaults `@Post()` to `201` unless `@HttpCode` overrides it — confirm this controller doesn't override it, and confirm the same for the new `AdminDepartmentsController.create` from Task 1, which also has no `@HttpCode` override).

- [ ] **Step 2: Run the new e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/admin-departments.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 3: Update the README**

Document the new `Admin > Departments` endpoints (all five), note `Role` now has an optional `departmentId`, and document the restructured admin-role model: `AdminUser` now has exactly one required role, `PATCH /admin/admins/:id/role` replaces the old assign/remove-role endpoints, and `department` is automatically inherited from whichever role is set.

- [ ] **Step 4: Update Postman**

Per this repo's `CLAUDE.md`:
- New `Admin > Departments` folder: success + validation-error + not-found scenarios for all five endpoints, matching the existing `Admin > Roles`/`Admin > Permissions` folders' structure and saved-response-example conventions.
- In `Admin > Admins`: replace the old assign-role/remove-role requests with one `PATCH /admin/admins/:id/role` (success, 404 unknown role, 409 last-SUPER_ADMIN-holder scenarios, built from the real `AdminRoleAssignmentService.setRole`/`ConflictException` messages). Update `GET /admin/admins`'s saved examples to show `role`/`department` as direct nested objects instead of a `roles` array.
- Update `Admin > Roles`'s create/update request examples to include an optional `departmentId` field.
- Trace every `pm.test` script in `Admin > Admins`/`Admin > Roles` for anything reading the old `roles` array shape or chaining a variable off the removed assign/remove-role requests — this has been a real, recurring finding in every closing task so far this session.
- Use surgical text-based/`Edit`-tool edits only, never a full-document rewrite. Verify with a byte-level em-dash/naira-sign check against `HEAD`.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Commit**

```bash
git add test/admin-departments.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add department e2e coverage and docs"
```

- [ ] **Step 7: Run the full test suite**

This plan is its own complete phase — run the true full suite.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run it in isolation to confirm pre-existing environmental flakiness rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] `Department` has full CRUD, paginated list, gated by `departments:manage`.
- [ ] `Role.departmentId` is optional and editable via `PATCH /admin/roles/:id`.
- [ ] Every `AdminUser` has exactly one required role; `AdminUserRole` no longer exists.
- [ ] `PATCH /admin/admins/:id/role` sets an admin's role and inherits that role's department in one call.
- [ ] `GET /admin/admins` shows `role` and `department` as direct nested objects.
- [ ] Accepting an invite sets both the invited role and its department on the new admin.
- [ ] Full unit + e2e suite passes clean.
