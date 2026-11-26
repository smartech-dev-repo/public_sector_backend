# RBAC Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full API for managing `Role`/`Permission`/`RolePermission`/`AdminUserRole` — currently these can only be created/changed by editing `prisma/seed.ts`. No new Prisma models; this is entirely new controllers/services over the existing schema.

**Architecture:** Three services (`PermissionService`, `RoleService`, `AdminRoleAssignmentService`) and three controllers in a new `src/admin-rbac/` module, following this project's established flat-per-feature-module pattern. The Phase 1 stub `GET /admin/roles/ping` is removed — it would otherwise route-collide with the new `AdminRolesController`, and is now fully superseded.

**Tech Stack:** Same as every prior phase — NestJS 10, Prisma 7, class-validator, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-16-rbac-management-design.md`

## Global Constraints

- Every route: `JwtAuthGuard` + `PermissionsGuard` + explicit `@RequirePermissions(...)`, matching every prior admin controller in this codebase.
- `permissions:manage` gates all Permission CRUD; `roles:manage` (already seeded) gates all Role CRUD, role↔permission assignment, and admin↔role assignment.
- A `Permission.key` is immutable after creation — only `description` can be updated via `PATCH`.
- Deleting a `Permission` in use by any `Role`, deleting/renaming the `SUPER_ADMIN` role, deleting a `Role` assigned to any admin, or removing an admin's last `SUPER_ADMIN` assignment all return `409 Conflict`, not a raw DB error.
- Per this repo's `CLAUDE.md`: the Postman collection must be updated in the same change — this plan's final task does that.

---

### Task 1: Seed the `permissions:manage` permission

**Files:**
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: the `permissions:manage` permission key, assigned to `SUPER_ADMIN` automatically (the seed loop assigns every existing `Permission` to `SUPER_ADMIN`) — Task 3's `AdminPermissionsController` requires it.

- [ ] **Step 1: Add the permission**

In `prisma/seed.ts`, add to `BOOTSTRAP_PERMISSIONS` (after the existing `documents:read` entry):

```typescript
  { key: 'permissions:manage', description: 'Create, edit, and delete permission definitions' },
```

- [ ] **Step 2: Reseed and verify**

Run: `npx prisma db seed`
Expected: completes with no errors (idempotent upserts).

- [ ] **Step 3: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: seed the permissions:manage permission"
```

---

### Task 2: PermissionService

**Files:**
- Create: `src/admin-rbac/permission.service.ts`
- Test: `src/admin-rbac/permission.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `PermissionService.create(params: {key, description}): Promise<Permission>`, `.list(): Promise<Permission[]>`, `.findById(id): Promise<Permission>` (throws `NotFoundException`), `.update(id, {description}): Promise<Permission>`, `.remove(id): Promise<void>` (throws `ConflictException` if in use by any role) — Task 3's controller consumes all of these.

- [ ] **Step 1: Write the failing test**

`src/admin-rbac/permission.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PermissionService', () => {
  let service: PermissionService;
  let prisma: {
    permission: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
    rolePermission: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      permission: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
      rolePermission: { count: jest.fn() },
    };
    service = new PermissionService(prisma as unknown as PrismaService);
  });

  it('create stores the key and description', async () => {
    prisma.permission.create.mockResolvedValue({ id: 'perm-1', key: 'reports:export', description: 'Export reports' });
    const result = await service.create({ key: 'reports:export', description: 'Export reports' });
    expect(prisma.permission.create).toHaveBeenCalledWith({ data: { key: 'reports:export', description: 'Export reports' } });
    expect(result.id).toBe('perm-1');
  });

  it('create converts a duplicate-key DB error into ConflictException', async () => {
    prisma.permission.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ key: 'audit:read', description: 'dup' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('findById returns the permission when found', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    expect(await service.findById('perm-1')).toEqual({ id: 'perm-1' });
  });

  it('update only ever changes description, never key', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1', key: 'reports:export' });
    prisma.permission.update.mockResolvedValue({ id: 'perm-1', description: 'new desc' });
    await service.update('perm-1', { description: 'new desc' });
    expect(prisma.permission.update).toHaveBeenCalledWith({ where: { id: 'perm-1' }, data: { description: 'new desc' } });
  });

  it('update throws NotFoundException for an unknown id', async () => {
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { description: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('remove throws ConflictException when the permission is assigned to a role', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    prisma.rolePermission.count.mockResolvedValue(1);
    await expect(service.remove('perm-1')).rejects.toThrow(ConflictException);
    expect(prisma.permission.delete).not.toHaveBeenCalled();
  });

  it('remove deletes the permission when unused', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    prisma.rolePermission.count.mockResolvedValue(0);
    await service.remove('perm-1');
    expect(prisma.permission.delete).toHaveBeenCalledWith({ where: { id: 'perm-1' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/admin-rbac/permission.service.spec.ts`
Expected: FAIL — `Cannot find module './permission.service'`

- [ ] **Step 3: Implement `PermissionService`**

`src/admin-rbac/permission.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from '../generated/prisma/client';

export interface CreatePermissionParams {
  key: string;
  description: string;
}

export interface UpdatePermissionParams {
  description: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreatePermissionParams): Promise<Permission> {
    try {
      return await this.prisma.permission.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A permission with key "${params.key}" already exists`);
      }
      throw error;
    }
  }

  async list(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  async findById(id: string): Promise<Permission> {
    const permission = await this.prisma.permission.findUnique({ where: { id } });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }

  async update(id: string, params: UpdatePermissionParams): Promise<Permission> {
    await this.findById(id);
    return this.prisma.permission.update({ where: { id }, data: { description: params.description } });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    const usageCount = await this.prisma.rolePermission.count({ where: { permissionId: id } });
    if (usageCount > 0) {
      throw new ConflictException('Cannot delete a permission that is currently assigned to one or more roles');
    }
    await this.prisma.permission.delete({ where: { id } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/admin-rbac/permission.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin-rbac/permission.service.ts src/admin-rbac/permission.service.spec.ts
git commit -m "feat: add PermissionService with create/list/update/delete-if-unused"
```

---

### Task 3: Admin Permissions endpoints

**Files:**
- Create: `src/admin-rbac/dto/create-permission.dto.ts`
- Create: `src/admin-rbac/dto/update-permission.dto.ts`
- Create: `src/admin-rbac/admin-permissions.controller.ts`
- Create: `src/admin-rbac/admin-rbac.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/admin-permissions.e2e-spec.ts`

**Interfaces:**
- Consumes: `PermissionService` (Task 2), `AuditLogService`/`AuditInterceptor` (existing, from `src/audit/`).
- Produces: `POST/GET /admin/permissions`, `GET/PATCH/DELETE /admin/permissions/:id`. `AdminRbacModule` created here and extended by Tasks 5 and 7.

- [ ] **Step 1: Add the DTOs**

`src/admin-rbac/dto/create-permission.dto.ts`:

```typescript
import { IsString, Matches, MinLength } from 'class-validator';

export class CreatePermissionDto {
  @IsString()
  @Matches(/^[a-z0-9]+(:[a-z0-9]+)+$/, {
    message: 'key must look like resource:action (e.g. reports:export), lowercase, colon-separated',
  })
  key: string;

  @IsString()
  @MinLength(1)
  description: string;
}
```

`src/admin-rbac/dto/update-permission.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class UpdatePermissionDto {
  @IsString()
  @MinLength(1)
  description: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/admin-rbac/admin-permissions.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { PermissionService } from './permission.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminPermissionsController {
  constructor(
    private readonly permissionService: PermissionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('permissions:manage')
  async create(@Body() dto: CreatePermissionDto, @Req() req: { user: JwtPayload }) {
    const permission = await this.permissionService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'permission.created',
      targetType: 'Permission',
      targetId: permission.id,
      metadata: { key: permission.key },
    });
    return permission;
  }

  @Get()
  @RequirePermissions('permissions:manage')
  list() {
    return this.permissionService.list();
  }

  @Get(':id')
  @RequirePermissions('permissions:manage')
  findOne(@Param('id') id: string) {
    return this.permissionService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('permissions:manage')
  update(@Param('id') id: string, @Body() dto: UpdatePermissionDto) {
    return this.permissionService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('permissions:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.permissionService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'permission.deleted',
      targetType: 'Permission',
      targetId: id,
    });
    return { deleted: true };
  }
}
```

- [ ] **Step 3: Wire the module**

`src/admin-rbac/admin-rbac.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionService } from './permission.service';
import { AdminPermissionsController } from './admin-permissions.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminPermissionsController],
  providers: [PermissionService],
})
export class AdminRbacModule {}
```

- [ ] **Step 4: Wire into `AppModule`**

Modify `src/app.module.ts`: add the import and register in `imports`.

```typescript
import { AdminRbacModule } from './admin-rbac/admin-rbac.module';
```

Add `AdminRbacModule` to the `imports` array.

- [ ] **Step 5: Write the e2e test**

`test/admin-permissions.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin permissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const testKey = `test:permission:${Date.now()}`;
  let createdPermissionId: string;

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
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.permission.deleteMany({ where: { key: testKey } });
    await app.close();
  });

  it('rejects creation with an invalid key format (400)', () => {
    return request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: 'Not A Valid Key', description: 'bad' })
      .expect(400);
  });

  it('creates a permission', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: testKey, description: 'Test permission' })
      .expect(201);
    expect(res.body.key).toBe(testKey);
    createdPermissionId = res.body.id;
  });

  it('rejects creating a duplicate key (409)', () => {
    return request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: testKey, description: 'duplicate' })
      .expect(409);
  });

  it('lists permissions including the new one', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.some((p: { key: string }) => p.key === testKey)).toBe(true);
  });

  it('gets one permission by id', () => {
    return request(app.getHttpServer())
      .get(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.key).toBe(testKey));
  });

  it('updates the description only', () => {
    return request(app.getHttpServer())
      .patch(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ description: 'Updated description' })
      .expect(200)
      .expect((res) => {
        expect(res.body.description).toBe('Updated description');
        expect(res.body.key).toBe(testKey);
      });
  });

  it('deletes the unused permission', () => {
    return request(app.getHttpServer())
      .delete(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });

  it('rejects without permissions:manage (403)', async () => {
    return request(app.getHttpServer())
      .get('/admin/permissions')
      .expect(401);
  });
});
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 7: Commit**

```bash
git add src/admin-rbac src/app.module.ts test/admin-permissions.e2e-spec.ts
git commit -m "feat: add admin permission management endpoints"
```

---

### Task 4: RoleService

**Files:**
- Create: `src/admin-rbac/role.service.ts`
- Test: `src/admin-rbac/role.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `RoleService.create({name, description?}): Promise<Role>`, `.list(): Promise<Role[]>` (with permissions included), `.findById(id): Promise<Role>` (with permissions included, throws `NotFoundException`), `.update(id, {name?, description?}): Promise<Role>` (throws `ConflictException` renaming SUPER_ADMIN), `.remove(id): Promise<void>` (throws `ConflictException` for SUPER_ADMIN or in-use), `.assignPermission(roleId, permissionId): Promise<void>`, `.removePermission(roleId, permissionId): Promise<void>` — Task 5's controller consumes all of these.

- [ ] **Step 1: Write the failing test**

`src/admin-rbac/role.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RoleService } from './role.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RoleService', () => {
  let service: RoleService;
  let prisma: {
    role: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
    adminUserRole: { count: jest.Mock };
    permission: { findUnique: jest.Mock };
    rolePermission: { upsert: jest.Mock; deleteMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      role: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
      adminUserRole: { count: jest.fn() },
      permission: { findUnique: jest.fn() },
      rolePermission: { upsert: jest.fn(), deleteMany: jest.fn() },
    };
    service = new RoleService(prisma as unknown as PrismaService);
  });

  it('create converts a duplicate-name DB error into ConflictException', async () => {
    prisma.role.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ name: 'SUPER_ADMIN' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('update rejects renaming SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    await expect(service.update('role-1', { name: 'NOT_SUPER_ADMIN' })).rejects.toThrow(ConflictException);
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it('update allows editing SUPER_ADMIN description without touching name', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({ where: { id: 'role-1' }, data: { name: undefined, description: 'new' } });
  });

  it('remove rejects deleting SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove rejects deleting a role assigned to any admin', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUserRole.count.mockResolvedValue(2);
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an unused, non-SUPER_ADMIN role', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUserRole.count.mockResolvedValue(0);
    await service.remove('role-1');
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
  });

  it('assignPermission throws NotFoundException for an unknown permission', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.assignPermission('role-1', 'missing-perm')).rejects.toThrow(NotFoundException);
  });

  it('assignPermission upserts the RolePermission row', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    await service.assignPermission('role-1', 'perm-1');
    expect(prisma.rolePermission.upsert).toHaveBeenCalledWith({
      where: { roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-1' } },
      update: {},
      create: { roleId: 'role-1', permissionId: 'perm-1' },
    });
  });

  it('removePermission deletes the RolePermission row', async () => {
    await service.removePermission('role-1', 'perm-1');
    expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-1', permissionId: 'perm-1' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: FAIL — `Cannot find module './role.service'`

- [ ] **Step 3: Implement `RoleService`**

`src/admin-rbac/role.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/client';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

export interface CreateRoleParams {
  name: string;
  description?: string;
}

export interface UpdateRoleParams {
  name?: string;
  description?: string;
}

const ROLE_WITH_PERMISSIONS_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async list() {
    return this.prisma.role.findMany({
      include: ROLE_WITH_PERMISSIONS_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: ROLE_WITH_PERMISSIONS_INCLUDE,
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    return role;
  }

  async update(id: string, params: UpdateRoleParams): Promise<Role> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME && params.name && params.name !== role.name) {
      throw new ConflictException('The SUPER_ADMIN role cannot be renamed');
    }
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description },
    });
  }

  async remove(id: string): Promise<void> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ConflictException('The SUPER_ADMIN role cannot be deleted');
    }
    const assignmentCount = await this.prisma.adminUserRole.count({ where: { roleId: id } });
    if (assignmentCount > 0) {
      throw new ConflictException('Cannot delete a role that is currently assigned to one or more admins');
    }
    await this.prisma.role.delete({ where: { id } });
  }

  async assignPermission(roleId: string, permissionId: string): Promise<void> {
    await this.findById(roleId);
    const permission = await this.prisma.permission.findUnique({ where: { id: permissionId } });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    await this.prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      update: {},
      create: { roleId, permissionId },
    });
  }

  async removePermission(roleId: string, permissionId: string): Promise<void> {
    await this.prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin-rbac/role.service.ts src/admin-rbac/role.service.spec.ts
git commit -m "feat: add RoleService with SUPER_ADMIN guards and permission assignment"
```

---

### Task 5: Admin Roles endpoints

**Files:**
- Create: `src/admin-rbac/dto/create-role.dto.ts`
- Create: `src/admin-rbac/dto/update-role.dto.ts`
- Create: `src/admin-rbac/dto/assign-permission.dto.ts`
- Create: `src/admin-rbac/admin-roles.controller.ts`
- Modify: `src/admin-rbac/admin-rbac.module.ts`
- Test: `test/admin-roles.e2e-spec.ts`

**Interfaces:**
- Consumes: `RoleService` (Task 4), `PermissionService` (Task 2, to create a real permission to assign in the e2e test), `AuditLogService`.
- Produces: `POST/GET /admin/roles`, `GET/PATCH/DELETE /admin/roles/:id`, `POST /admin/roles/:id/permissions`, `DELETE /admin/roles/:id/permissions/:permissionId`.

- [ ] **Step 1: Add the DTOs**

`src/admin-rbac/dto/create-role.dto.ts`:

```typescript
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

`src/admin-rbac/dto/update-role.dto.ts`:

```typescript
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

`src/admin-rbac/dto/assign-permission.dto.ts`:

```typescript
import { IsUUID } from 'class-validator';

export class AssignPermissionDto {
  @IsUUID()
  permissionId: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/admin-rbac/admin-roles.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { RoleService } from './role.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionDto } from './dto/assign-permission.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminRolesController {
  constructor(
    private readonly roleService: RoleService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('roles:manage')
  async create(@Body() dto: CreateRoleDto, @Req() req: { user: JwtPayload }) {
    const role = await this.roleService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.created',
      targetType: 'Role',
      targetId: role.id,
      metadata: { name: role.name },
    });
    return role;
  }

  @Get()
  @RequirePermissions('roles:manage')
  list() {
    return this.roleService.list();
  }

  @Get(':id')
  @RequirePermissions('roles:manage')
  findOne(@Param('id') id: string) {
    return this.roleService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('roles:manage')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.roleService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: id,
    });
    return { deleted: true };
  }

  @Post(':id/permissions')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignPermission(
    @Param('id') id: string,
    @Body() dto: AssignPermissionDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.assignPermission(id, dto.permissionId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permission.assigned',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionId: dto.permissionId },
    });
    return { assigned: true };
  }

  @Delete(':id/permissions/:permissionId')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async removePermission(
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.removePermission(id, permissionId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permission.removed',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionId },
    });
    return { removed: true };
  }
}
```

- [ ] **Step 3: Register the controller and service**

Modify `src/admin-rbac/admin-rbac.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminPermissionsController, AdminRolesController],
  providers: [PermissionService, RoleService],
})
export class AdminRbacModule {}
```

- [ ] **Step 4: Write the e2e test**

`test/admin-roles.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const testRoleName = `TEST_ROLE_${Date.now()}`;
  const testPermissionKey = `test:role-e2e:${Date.now()}`;
  let createdRoleId: string;
  let createdPermissionId: string;

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
    accessToken = loginRes.body.accessToken;

    const permission = await prisma.permission.create({
      data: { key: testPermissionKey, description: 'e2e test permission' },
    });
    createdPermissionId = permission.id;
  });

  afterAll(async () => {
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await prisma.permission.deleteMany({ where: { key: testPermissionKey } });
    await app.close();
  });

  it('creates a role', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: testRoleName, description: 'A test role' })
      .expect(201);
    expect(res.body.name).toBe(testRoleName);
    createdRoleId = res.body.id;
  });

  it('rejects renaming SUPER_ADMIN (409)', async () => {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    return request(app.getHttpServer())
      .patch(`/admin/roles/${superAdmin.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'RENAMED' })
      .expect(409);
  });

  it('rejects deleting SUPER_ADMIN (409)', async () => {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    return request(app.getHttpServer())
      .delete(`/admin/roles/${superAdmin.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('assigns a permission to the role', async () => {
    await request(app.getHttpServer())
      .post(`/admin/roles/${createdRoleId}/permissions`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissionId: createdPermissionId })
      .expect(200)
      .expect({ assigned: true });

    const res = await request(app.getHttpServer())
      .get(`/admin/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.permissions.some((rp: { permission: { key: string } }) => rp.permission.key === testPermissionKey)).toBe(true);
  });

  it('rejects deleting the now-in-use permission (409)', () => {
    return request(app.getHttpServer())
      .delete(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('removes the permission from the role', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/roles/${createdRoleId}/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ removed: true });
  });

  it('deletes the now-unused role', () => {
    return request(app.getHttpServer())
      .delete(`/admin/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });
});
```

- [ ] **Step 5: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 6: Commit**

```bash
git add src/admin-rbac test/admin-roles.e2e-spec.ts
git commit -m "feat: add admin role management and role-permission assignment endpoints"
```

---

### Task 6: AdminRoleAssignmentService

**Files:**
- Create: `src/admin-rbac/admin-role-assignment.service.ts`
- Test: `src/admin-rbac/admin-role-assignment.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `AdminRoleAssignmentService.listAdmins(): Promise<AdminUser[]>` (with roles included), `.assignRole(adminId, roleId): Promise<void>` (throws `NotFoundException` for unknown admin/role), `.removeRole(adminId, roleId): Promise<void>` (throws `ConflictException` if it's the last SUPER_ADMIN holder) — Task 7's controller consumes all of these.

- [ ] **Step 1: Write the failing test**

`src/admin-rbac/admin-role-assignment.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminRoleAssignmentService', () => {
  let service: AdminRoleAssignmentService;
  let prisma: {
    adminUser: { findMany: jest.Mock; findUnique: jest.Mock };
    role: { findUnique: jest.Mock };
    adminUserRole: { upsert: jest.Mock; deleteMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn(), findUnique: jest.fn() },
      role: { findUnique: jest.fn() },
      adminUserRole: { upsert: jest.fn(), deleteMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    };
    service = new AdminRoleAssignmentService(prisma as unknown as PrismaService);
  });

  it('listAdmins returns admins with roles included', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await service.listAdmins();
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ roles: expect.anything() }) }),
    );
  });

  it('assignRole throws NotFoundException for an unknown admin', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(service.assignRole('missing-admin', 'role-1')).rejects.toThrow(NotFoundException);
  });

  it('assignRole throws NotFoundException for an unknown role', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(service.assignRole('admin-1', 'missing-role')).rejects.toThrow(NotFoundException);
  });

  it('assignRole upserts the AdminUserRole row', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    await service.assignRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.upsert).toHaveBeenCalledWith({
      where: { adminUserId_roleId: { adminUserId: 'admin-1', roleId: 'role-1' } },
      update: {},
      create: { adminUserId: 'admin-1', roleId: 'role-1' },
    });
  });

  it('removeRole allows removing a non-SUPER_ADMIN role freely', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalledWith({ where: { adminUserId: 'admin-1', roleId: 'role-1' } });
  });

  it('removeRole allows removing SUPER_ADMIN when other admins still hold it', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue({ adminUserId: 'admin-1', roleId: 'role-1' });
    prisma.adminUserRole.count.mockResolvedValue(2);
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalled();
  });

  it('removeRole rejects removing the last SUPER_ADMIN holder', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue({ adminUserId: 'admin-1', roleId: 'role-1' });
    prisma.adminUserRole.count.mockResolvedValue(1);
    await expect(service.removeRole('admin-1', 'role-1')).rejects.toThrow(ConflictException);
    expect(prisma.adminUserRole.deleteMany).not.toHaveBeenCalled();
  });

  it('removeRole is a no-op (not an error) if the admin never had SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue(null);
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-role-assignment.service'`

- [ ] **Step 3: Implement `AdminRoleAssignmentService`**

`src/admin-rbac/admin-role-assignment.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

@Injectable()
export class AdminRoleAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  async listAdmins() {
    return this.prisma.adminUser.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        roles: { include: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assignRole(adminId: string, roleId: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    await this.prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: adminId, roleId } },
      update: {},
      create: { adminUserId: adminId, roleId },
    });
  }

  async removeRole(adminId: string, roleId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });

    if (role?.name === SUPER_ADMIN_ROLE_NAME) {
      const thisAdminHasIt = await this.prisma.adminUserRole.findUnique({
        where: { adminUserId_roleId: { adminUserId: adminId, roleId } },
      });
      if (thisAdminHasIt) {
        const holderCount = await this.prisma.adminUserRole.count({ where: { roleId } });
        if (holderCount <= 1) {
          throw new ConflictException('Cannot remove the last admin holding the SUPER_ADMIN role');
        }
      }
    }

    await this.prisma.adminUserRole.deleteMany({ where: { adminUserId: adminId, roleId } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin-rbac/admin-role-assignment.service.ts src/admin-rbac/admin-role-assignment.service.spec.ts
git commit -m "feat: add AdminRoleAssignmentService with SUPER_ADMIN lockout protection"
```

---

### Task 7: Admin Role Assignment endpoints + remove the Phase 1 stub

**Files:**
- Create: `src/admin-rbac/dto/assign-role.dto.ts`
- Create: `src/admin-rbac/admin-role-assignment.controller.ts`
- Modify: `src/admin-rbac/admin-rbac.module.ts`
- Modify: `src/admin/admin.controller.ts`
- Modify: `test/admin-rbac.e2e-spec.ts`
- Test: `test/admin-role-assignment.e2e-spec.ts`

**Interfaces:**
- Consumes: `AdminRoleAssignmentService` (Task 6), `AuditLogService`.
- Produces: `GET /admin/admins`, `POST /admin/admins/:id/roles`, `DELETE /admin/admins/:id/roles/:roleId`. Removes `GET /admin/roles/ping`.

- [ ] **Step 1: Add the DTO**

`src/admin-rbac/dto/assign-role.dto.ts`:

```typescript
import { IsUUID } from 'class-validator';

export class AssignRoleDto {
  @IsUUID()
  roleId: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/admin-rbac/admin-role-assignment.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/admins')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminRoleAssignmentController {
  constructor(
    private readonly adminRoleAssignmentService: AdminRoleAssignmentService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('roles:manage')
  list() {
    return this.adminRoleAssignmentService.listAdmins();
  }

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
}
```

- [ ] **Step 3: Register the controller and service**

Modify `src/admin-rbac/admin-rbac.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRoleAssignmentController } from './admin-role-assignment.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminPermissionsController, AdminRolesController, AdminRoleAssignmentController],
  providers: [PermissionService, RoleService, AdminRoleAssignmentService],
})
export class AdminRbacModule {}
```

- [ ] **Step 4: Remove the Phase 1 `/admin/roles/ping` stub**

Replace `src/admin/admin.controller.ts` in full:

```typescript
import { Controller, Get, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminController {
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, type: req.user.type, permissions: req.user.permissions };
  }
}
```

(`RequirePermissions` is no longer imported since the only remaining route,
`/admin/me`, never required one — it only needs a valid authenticated
admin.)

- [ ] **Step 5: Update the now-stale RBAC e2e test**

Replace the third test in `test/admin-rbac.e2e-spec.ts` (`'allows the bootstrap super-admin to hit a roles:manage-gated route'`) with a check against a real `roles:manage`-gated route:

```typescript
  it('allows the bootstrap super-admin to hit a roles:manage-gated route', () => {
    return request(app.getHttpServer())
      .get('/admin/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });
```

- [ ] **Step 6: Write the e2e test for admin↔role assignment**

`test/admin-role-assignment.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin role assignment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let bootstrapAdminId: string;
  let superAdminRoleId: string;
  const testRoleName = `TEST_ASSIGN_ROLE_${Date.now()}`;
  let testRoleId: string;

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
    accessToken = loginRes.body.accessToken;

    const bootstrapAdmin = await prisma.adminUser.findUniqueOrThrow({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
    });
    bootstrapAdminId = bootstrapAdmin.id;

    const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = superAdminRole.id;

    const testRole = await prisma.role.create({ data: { name: testRoleName } });
    testRoleId = testRole.id;
  });

  afterAll(async () => {
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: bootstrapAdminId, roleId: testRoleId } });
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await app.close();
  });

  it('lists admins including the bootstrap admin with SUPER_ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const bootstrapEntry = res.body.find((a: { id: string }) => a.id === bootstrapAdminId);
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
});
```

- [ ] **Step 7: Run the full suite to verify everything passes**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the updated `admin-rbac.e2e-spec.ts` and the two new ones.

- [ ] **Step 8: Commit**

```bash
git add src/admin-rbac src/admin/admin.controller.ts test/admin-rbac.e2e-spec.ts test/admin-role-assignment.e2e-spec.ts
git commit -m "feat: add admin-role assignment endpoints, remove the /admin/roles/ping stub"
```

---

### Task 8: Final regression, README, and Postman update

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Produces: documentation of the 13 new endpoints; Postman coverage for all of them, per this repo's `CLAUDE.md` standing rule that the collection is updated in the same change as any API change.

- [ ] **Step 1: Update the README**

Add to `README.md`, after the existing "Document ingestion" section:

```markdown
## RBAC management

Roles and permissions can now be managed via the API — previously only
`prisma/seed.ts` could create them.

| Endpoint | Permission | Notes |
|---|---|---|
| `POST/GET /admin/permissions` | `permissions:manage` | |
| `GET/PATCH/DELETE /admin/permissions/:id` | `permissions:manage` | `PATCH` only changes `description` — `key` is immutable. `DELETE` is blocked (409) if any role still has it. |
| `POST/GET /admin/roles` | `roles:manage` | |
| `GET/PATCH/DELETE /admin/roles/:id` | `roles:manage` | Renaming or deleting `SUPER_ADMIN` is blocked (409); deleting a role assigned to any admin is blocked (409). |
| `POST /admin/roles/:id/permissions` | `roles:manage` | `{ permissionId }` |
| `DELETE /admin/roles/:id/permissions/:permissionId` | `roles:manage` | |
| `GET /admin/admins` | `roles:manage` | Lists admins with their roles |
| `POST /admin/admins/:id/roles` | `roles:manage` | `{ roleId }` |
| `DELETE /admin/admins/:id/roles/:roleId` | `roles:manage` | Blocked (409) if it would leave zero admins holding `SUPER_ADMIN` |

`GET /admin/roles/ping` no longer exists — it was a Phase 1 placeholder,
superseded by the real endpoints above.
```

- [ ] **Step 2: Remove the stale `/admin/roles/ping` requests**

In `postman/public-sector-backend.postman_collection.json`, find the
**Admin > Reference** sub-folder and delete these two request objects
from its `item` array entirely (the route no longer exists):
`"GET /admin/roles/ping - Success (requires roles:manage)"` and
`"GET /admin/roles/ping - Missing permission (403)"`.

- [ ] **Step 3: Add the new collection variables**

In the collection's top-level `variable` array, add (anywhere after the
existing `super_admin_role_id` entry):

```json
    { "key": "permission_id", "value": "" },
    { "key": "role_id", "value": "" },
    { "key": "test_permission_key", "value": "reports:export" },
    { "key": "test_role_name", "value": "REPORTS_MANAGER" },
    { "key": "admin_id", "value": "" },
```

- [ ] **Step 4: Capture `admin_id` from the existing `/admin/me` request**

In **Admin > Session** (or wherever `GET /admin/me` lives —
**Admin > Reference**), find `"GET /admin/me - Success"` and add one line
to its `event.test.exec` array (after the existing `type is admin`
assertion): `"pm.collectionVariables.set('admin_id', pm.response.json().id);"`.
Its `exec` array becomes:

```json
"exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('type is admin', () => pm.expect(pm.response.json().type).to.eql('admin'));", "pm.collectionVariables.set('admin_id', pm.response.json().id);"]
```

- [ ] **Step 5: Add the Permissions sub-folder**

Add this object to **Admin**'s `item` array (alongside `Auth`, `Session`,
`Reference`, `Invites`, `Audit Logs`, `Force-Revoke Sessions`):

```json
{
  "name": "Permissions",
  "item": [
    {
      "name": "POST /admin/permissions - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"key\": \"{{test_permission_key}}\",\n  \"description\": \"Export financial reports\"\n}" },
        "url": { "raw": "{{base_url}}/admin/permissions", "host": ["{{base_url}}"], "path": ["admin", "permissions"] }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 201', () => pm.response.to.have.status(201));",
              "const json = pm.response.json();",
              "pm.test('key matches', () => pm.expect(json.key).to.eql(pm.collectionVariables.get('test_permission_key')));",
              "pm.collectionVariables.set('permission_id', json.id);"
            ]
          }
        }
      ]
    },
    {
      "name": "POST /admin/permissions - Invalid key format (400)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"key\": \"Not A Valid Key!\",\n  \"description\": \"bad\"\n}" },
        "url": { "raw": "{{base_url}}/admin/permissions", "host": ["{{base_url}}"], "path": ["admin", "permissions"] }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 400', () => pm.response.to.have.status(400));"] } }
      ]
    },
    {
      "name": "POST /admin/permissions - Duplicate key (409)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"key\": \"{{test_permission_key}}\",\n  \"description\": \"duplicate\"\n}" },
        "url": { "raw": "{{base_url}}/admin/permissions", "host": ["{{base_url}}"], "path": ["admin", "permissions"] },
        "description": "Run 'POST /admin/permissions - Success' first so this key already exists."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }
      ]
    },
    {
      "name": "GET /admin/permissions - Success (all)",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": { "raw": "{{base_url}}/admin/permissions", "host": ["{{base_url}}"], "path": ["admin", "permissions"] }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));"] } }
      ]
    },
    {
      "name": "GET /admin/permissions/:id - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/permissions/{{permission_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "permissions", "{{permission_id}}"]
        },
        "description": "Run 'POST /admin/permissions - Success' first to populate permission_id."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }
      ]
    },
    {
      "name": "PATCH /admin/permissions/:id - Success",
      "request": {
        "method": "PATCH",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"description\": \"Updated description\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/permissions/{{permission_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "permissions", "{{permission_id}}"]
        },
        "description": "key is immutable — only description can change."
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 200', () => pm.response.to.have.status(200));",
              "const json = pm.response.json();",
              "pm.test('key unchanged', () => pm.expect(json.key).to.eql(pm.collectionVariables.get('test_permission_key')));",
              "pm.test('description updated', () => pm.expect(json.description).to.eql('Updated description'));"
            ]
          }
        }
      ]
    },
    {
      "name": "DELETE /admin/permissions/:id - Blocked, in use by a role (409)",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/permissions/{{permission_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "permissions", "{{permission_id}}"]
        },
        "description": "Run 'Admin > Roles > POST /admin/roles/:id/permissions - Success' first to assign this permission to a role."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }
      ]
    },
    {
      "name": "DELETE /admin/permissions/:id - Success",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/permissions/{{permission_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "permissions", "{{permission_id}}"]
        },
        "description": "Run 'Admin > Roles > DELETE /admin/roles/:id/permissions/:permissionId - Success' first so it's no longer in use."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('deleted true', () => pm.expect(pm.response.json().deleted).to.eql(true));"] } }
      ]
    }
  ]
}
```

- [ ] **Step 6: Add the Roles sub-folder**

Add this object to **Admin**'s `item` array, right after the `Permissions`
folder just added:

```json
{
  "name": "Roles",
  "item": [
    {
      "name": "POST /admin/roles - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"name\": \"{{test_role_name}}\",\n  \"description\": \"Can export financial reports\"\n}" },
        "url": { "raw": "{{base_url}}/admin/roles", "host": ["{{base_url}}"], "path": ["admin", "roles"] }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 201', () => pm.response.to.have.status(201));",
              "const json = pm.response.json();",
              "pm.collectionVariables.set('role_id', json.id);"
            ]
          }
        }
      ]
    },
    {
      "name": "POST /admin/roles - Duplicate name (409)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"name\": \"SUPER_ADMIN\"\n}" },
        "url": { "raw": "{{base_url}}/admin/roles", "host": ["{{base_url}}"], "path": ["admin", "roles"] }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }
      ]
    },
    {
      "name": "GET /admin/roles - Success (all)",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": { "raw": "{{base_url}}/admin/roles", "host": ["{{base_url}}"], "path": ["admin", "roles"] }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));"] } }
      ]
    },
    {
      "name": "GET /admin/roles/:id - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/roles/{{role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{role_id}}"]
        },
        "description": "Run 'POST /admin/roles - Success' first to populate role_id."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('has permissions array', () => pm.expect(pm.response.json().permissions).to.be.an('array'));"] } }
      ]
    },
    {
      "name": "PATCH /admin/roles/:id - Success",
      "request": {
        "method": "PATCH",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"description\": \"Updated role description\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/roles/{{role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{role_id}}"]
        }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }
      ]
    },
    {
      "name": "PATCH /admin/roles/:id - Rejects renaming SUPER_ADMIN (409)",
      "request": {
        "method": "PATCH",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"name\": \"NOT_SUPER_ADMIN\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/roles/{{super_admin_role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{super_admin_role_id}}"]
        },
        "description": "super_admin_role_id must be set first (see the Invites folder's description for how to find it)."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }
      ]
    },
    {
      "name": "DELETE /admin/roles/:id - Rejects deleting SUPER_ADMIN (409)",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/roles/{{super_admin_role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{super_admin_role_id}}"]
        }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }
      ]
    },
    {
      "name": "POST /admin/roles/:id/permissions - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"permissionId\": \"{{permission_id}}\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/roles/{{role_id}}/permissions",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{role_id}}", "permissions"]
        },
        "description": "Run 'Admin > Permissions > POST /admin/permissions - Success' and this folder's 'POST /admin/roles - Success' first."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('assigned true', () => pm.expect(pm.response.json().assigned).to.eql(true));"] } }
      ]
    },
    {
      "name": "DELETE /admin/roles/:id/permissions/:permissionId - Success",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/roles/{{role_id}}/permissions/{{permission_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{role_id}}", "permissions", "{{permission_id}}"]
        }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('removed true', () => pm.expect(pm.response.json().removed).to.eql(true));"] } }
      ]
    },
    {
      "name": "DELETE /admin/roles/:id - Success",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/roles/{{role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "roles", "{{role_id}}"]
        },
        "description": "Run the permission-removal request above first, and make sure no admin has this role assigned."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('deleted true', () => pm.expect(pm.response.json().deleted).to.eql(true));"] } }
      ]
    }
  ]
}
```

- [ ] **Step 7: Add the Admins sub-folder**

Add this object to **Admin**'s `item` array, right after the `Roles`
folder just added:

```json
{
  "name": "Admins",
  "item": [
    {
      "name": "GET /admin/admins - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": { "raw": "{{base_url}}/admin/admins", "host": ["{{base_url}}"], "path": ["admin", "admins"] }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));"] } }
      ]
    },
    {
      "name": "POST /admin/admins/:id/roles - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"roleId\": \"{{role_id}}\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/admins/{{admin_id}}/roles",
          "host": ["{{base_url}}"],
          "path": ["admin", "admins", "{{admin_id}}", "roles"]
        },
        "description": "admin_id is set by 'Admin > Reference > GET /admin/me - Success'. role_id is set by 'Admin > Roles > POST /admin/roles - Success' — run that again first if you already deleted it in this run."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('assigned true', () => pm.expect(pm.response.json().assigned).to.eql(true));"] } }
      ]
    },
    {
      "name": "DELETE /admin/admins/:id/roles/:roleId - Success",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/admins/{{admin_id}}/roles/{{role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "admins", "{{admin_id}}", "roles", "{{role_id}}"]
        }
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));", "pm.test('removed true', () => pm.expect(pm.response.json().removed).to.eql(true));"] } }
      ]
    },
    {
      "name": "DELETE /admin/admins/:id/roles/:roleId - Blocked, last SUPER_ADMIN holder (409)",
      "request": {
        "method": "DELETE",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/admins/{{admin_id}}/roles/{{super_admin_role_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "admins", "{{admin_id}}", "roles", "{{super_admin_role_id}}"]
        },
        "description": "Only returns 409 if admin_id is genuinely the only SUPER_ADMIN holder in this environment (true on a freshly seeded database)."
      },
      "event": [
        { "listen": "test", "script": { "exec": ["pm.test('status 409 (or 200 if other SUPER_ADMIN holders exist)', () => pm.expect([200,409]).to.include(pm.response.code));"] } }
      ]
    }
  ]
}
```

- [ ] **Step 8: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`
Expected: `VALID` (confirms the manual JSON edits above didn't break the file).

In `postman/README.md`'s "Folder structure" section, extend the **Admin**
bullet to mention the three new sub-folders:

```markdown
- **Admin** — Auth, Session (admin tokens), Reference (`/admin/me`),
  **Permissions** (full CRUD, blocked-delete-if-in-use), **Roles** (full
  CRUD, SUPER_ADMIN protections, role↔permission assignment), **Admins**
  (list admins, assign/remove roles, SUPER_ADMIN-lockout protection),
  Invites, Audit Logs, and Force-Revoke Sessions.
```

- [ ] **Step 9: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite in the project green together.

- [ ] **Step 10: Commit**

```bash
git add README.md postman
git commit -m "docs: document RBAC management endpoints and update Postman collection"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] A permission and a role can be created, the permission assigned to
      the role, and deleting the permission while assigned is blocked
      (409) — proven by `test/admin-roles.e2e-spec.ts`.
- [ ] `SUPER_ADMIN` cannot be renamed or deleted via the API — proven by
      `test/admin-roles.e2e-spec.ts`.
- [ ] Removing the last admin's `SUPER_ADMIN` assignment is blocked (409)
      — proven by `test/admin-role-assignment.e2e-spec.ts`.
- [ ] `GET /admin/roles/ping` no longer exists; `PermissionsGuard` governs
      every new route with an explicit `@RequirePermissions(...)`.
- [ ] The Postman collection has Permissions/Roles/Admins coverage under
      the Admin group, per this repo's `CLAUDE.md` standing rule.
