# Profile Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `GET /admin/me` into a real DB-backed profile (resolved role/department, profile-image management, name-only self-update), and add brand-new read-only `GET /agent/me` / `GET /client/me` endpoints.

**Architecture:** Admin's profile logic lives in the existing (currently service-less) `src/admin/` module. Agent and Client each get a small new sibling module following the exact shape already established by `src/agent-clients/`. All seven routes use only the relevant `<Type>OnlyGuard` — no permission gating, since these are always-about-the-caller's-own-record endpoints.

**Tech Stack:** NestJS, Prisma, class-validator DTOs, Jest unit tests, supertest e2e tests, the existing `FileStorageProvider` abstraction.

**Spec:** `docs/superpowers/specs/2026-10-15-profile-endpoints-design.md`

## Global Constraints

- Admin can only self-update `firstName`/`lastName` — email, role, and department are untouched by this feature (they already have dedicated, permission-gated endpoints elsewhere).
- Agent and Client profile endpoints are read-only — no update, no image, per the approved spec.
- None of the seven routes get an explicit `AuditLogService.record()` call — matches the existing change-password/2FA self-service precedent.
- `/admin/me` currently uses `JwtAuthGuard, PermissionsGuard` with no `@RequirePermissions` (a silent no-op) — every route in this plan uses `JwtAuthGuard, AdminOnlyGuard` instead, consistent with every other admin self-service route in `auth/admin/admin-auth.controller.ts`.

---

### Task 1: Schema — `AdminUser.profileImageKey`

**Files:**
- Modify: `prisma/schema.prisma` (`AdminUser` model)

**Interfaces:**
- Produces: `AdminUser.profileImageKey: string | null` — consumed by Task 2.

- [ ] **Step 1: Add the field**

In `prisma/schema.prisma`, in the `AdminUser` model, change:

```prisma
  uploadedDocumentBatches DocumentUploadBatch[]
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
```

to:

```prisma
  uploadedDocumentBatches DocumentUploadBatch[]
  profileImageKey String?
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
```

- [ ] **Step 2: Run the migration**

Run: `npx prisma migrate dev --name admin_profile_image_key`
Expected: non-destructive (nullable field), completes cleanly.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add AdminUser.profileImageKey"
```

---

### Task 2: Admin profile — rebuild `/admin/me`, add update + image management

**Files:**
- Create: `src/admin/admin.service.ts`
- Create: `src/admin/admin.service.spec.ts`
- Create: `src/admin/dto/update-admin-profile.dto.ts`
- Modify: `src/admin/admin.controller.ts`
- Modify: `src/admin/admin.module.ts`

**Interfaces:**
- Consumes: `AdminUser.profileImageKey` (Task 1), `FileStorageProvider` (existing, `src/file-storage/file-storage-provider.interface.ts`).
- Produces: `GET/PATCH admin/me`, `POST/DELETE admin/me/profile-image`.

- [ ] **Step 1: Write the DTO**

```typescript
// src/admin/dto/update-admin-profile.dto.ts
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateAdminProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;
}
```

- [ ] **Step 2: Write `AdminService`**

```typescript
// src/admin/admin.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';

export interface UpdateAdminProfileInput {
  firstName?: string;
  lastName?: string;
}

interface AdminWithRelations {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  isActive: boolean;
  profileImageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: { id: string; name: string; description: string | null };
  department: { id: string; name: string; description: string | null } | null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async getProfile(adminId: string) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      include: {
        role: { select: { id: true, name: true, description: true } },
        department: { select: { id: true, name: true, description: true } },
      },
    });
    return this.toProfileResponse(admin);
  }

  async updateProfile(adminId: string, input: UpdateAdminProfileInput) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const firstName = input.firstName ?? current.firstName;
    const lastName = input.lastName ?? current.lastName;
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { firstName, lastName, fullName: `${firstName} ${lastName}`.trim() },
    });
    return this.getProfile(adminId);
  }

  async uploadProfileImage(adminId: string, file: Express.Multer.File) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (current.profileImageKey) {
      await this.fileStorageProvider.deleteObject(current.profileImageKey);
    }
    const storageKey = `admin-profile/${adminId}/profile-image${extname(file.originalname)}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { profileImageKey: storageKey } });
    return this.getProfile(adminId);
  }

  async deleteProfileImage(adminId: string) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (current.profileImageKey) {
      await this.fileStorageProvider.deleteObject(current.profileImageKey);
      await this.prisma.adminUser.update({ where: { id: adminId }, data: { profileImageKey: null } });
    }
    return this.getProfile(adminId);
  }

  private async toProfileResponse(admin: AdminWithRelations) {
    const profileImageUrl = admin.profileImageKey
      ? await this.fileStorageProvider.getSignedDownloadUrl(admin.profileImageKey)
      : null;
    return {
      id: admin.id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      fullName: admin.fullName,
      isActive: admin.isActive,
      role: admin.role,
      department: admin.department,
      profileImageUrl,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    };
  }
}
```

- [ ] **Step 3: Write its spec**

```typescript
// src/admin/admin.service.spec.ts
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: { adminUser: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock; deleteObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  const baseAdmin = {
    id: 'admin-1',
    email: 'admin@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    isActive: true,
    profileImageKey: null as string | null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    role: { id: 'role-1', name: 'SUPER_ADMIN', description: 'Full access' },
    department: null,
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    fileStorageProvider = {
      putObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed-url.example/image.jpg'),
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('getProfile', () => {
    it('returns resolved role/department with a null profileImageUrl when no image is set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(baseAdmin);

      const result = await service.getProfile('admin-1');

      expect(result).toEqual({
        id: 'admin-1',
        email: 'admin@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        fullName: 'Jane Doe',
        isActive: true,
        role: baseAdmin.role,
        department: null,
        profileImageUrl: null,
        createdAt: baseAdmin.createdAt,
        updatedAt: baseAdmin.updatedAt,
      });
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('resolves a signed URL when a profileImageKey is set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        ...baseAdmin,
        profileImageKey: 'admin-profile/admin-1/profile-image.jpg',
      });

      const result = await service.getProfile('admin-1');

      expect(fileStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'admin-profile/admin-1/profile-image.jpg',
      );
      expect(result.profileImageUrl).toBe('https://signed-url.example/image.jpg');
    });
  });

  describe('updateProfile', () => {
    it('updates only the given field, keeping the other from the current row, and recomputes fullName', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce(baseAdmin)
        .mockResolvedValueOnce({ ...baseAdmin, firstName: 'Janet', fullName: 'Janet Doe' });
      prisma.adminUser.update.mockResolvedValue({});

      await service.updateProfile('admin-1', { firstName: 'Janet' });

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { firstName: 'Janet', lastName: 'Doe', fullName: 'Janet Doe' },
      });
    });
  });

  describe('uploadProfileImage', () => {
    it('deletes an existing image first, then stores and links the new one', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/old.jpg' })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.jpg' });
      prisma.adminUser.update.mockResolvedValue({});

      const file = { originalname: 'photo.jpg', buffer: Buffer.from('fake-image') } as Express.Multer.File;
      await service.uploadProfileImage('admin-1', file);

      expect(fileStorageProvider.deleteObject).toHaveBeenCalledWith('admin-profile/admin-1/old.jpg');
      expect(fileStorageProvider.putObject).toHaveBeenCalledWith(
        'admin-profile/admin-1/profile-image.jpg',
        file.buffer,
      );
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { profileImageKey: 'admin-profile/admin-1/profile-image.jpg' },
      });
    });

    it('does not attempt to delete anything when no prior image existed', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: null })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.png' });
      prisma.adminUser.update.mockResolvedValue({});

      const file = { originalname: 'photo.png', buffer: Buffer.from('fake-image') } as Express.Multer.File;
      await service.uploadProfileImage('admin-1', file);

      expect(fileStorageProvider.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('deleteProfileImage', () => {
    it('clears the key and deletes the stored object when one is set', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.jpg' })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: null });
      prisma.adminUser.update.mockResolvedValue({});

      await service.deleteProfileImage('admin-1');

      expect(fileStorageProvider.deleteObject).toHaveBeenCalledWith('admin-profile/admin-1/profile-image.jpg');
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { profileImageKey: null },
      });
    });

    it('no-ops cleanly when no image was ever set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(baseAdmin);

      await service.deleteProfileImage('admin-1');

      expect(fileStorageProvider.deleteObject).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/admin/admin.service.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Rebuild the controller**

Replace `src/admin/admin.controller.ts` in full with:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AdminService } from './admin.service';
import { UpdateAdminProfileDto } from './dto/update-admin-profile.dto';

@Controller('admin')
@UseInterceptors(AuditInterceptor)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async me(@Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.getProfile(req.user.sub);
    return { ...profile, permissions: req.user.permissions };
  }

  @Patch('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async updateMe(@Body() dto: UpdateAdminProfileDto, @Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.updateProfile(req.user.sub, dto);
    return { ...profile, permissions: req.user.permissions };
  }

  @Post('me/profile-image')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (
        _req: Express.Request,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG or PNG files are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadProfileImage(@UploadedFile() file: Express.Multer.File, @Req() req: { user: JwtPayload }) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const profile = await this.adminService.uploadProfileImage(req.user.sub, file);
    return { ...profile, permissions: req.user.permissions };
  }

  @Delete('me/profile-image')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async deleteProfileImage(@Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.deleteProfileImage(req.user.sub);
    return { ...profile, permissions: req.user.permissions };
  }
}
```

(Previously this file only had a `me()` method that echoed the JWT payload with `JwtAuthGuard, PermissionsGuard` — this fully replaces it, including the guard fix described in Global Constraints.)

- [ ] **Step 6: Update the module**

Replace `src/admin/admin.module.ts` in full with:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuditModule, FileStorageModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
```

- [ ] **Step 7: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/admin
git commit -m "feat(admin): rebuild /admin/me with resolved role/department, add self-update and profile-image management"
```

---

### Task 3: Agent profile (read-only)

**Files:**
- Create: `src/agent-profile/agent-profile.service.ts`
- Create: `src/agent-profile/agent-profile.service.spec.ts`
- Create: `src/agent-profile/agent-profile.controller.ts`
- Create: `src/agent-profile/agent-profile.module.ts`

**Interfaces:**
- Produces: `GET agent/me`.

- [ ] **Step 1: Write the service**

```typescript
// src/agent-profile/agent-profile.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(agentId: string) {
    const agent = await this.prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
    });
    return {
      id: agent.id,
      email: agent.email,
      phone: agent.phone,
      fullName: agent.fullName,
      address: agent.address,
      status: agent.status,
      canOnboardClients: agent.canOnboardClients,
      mustChangePassword: agent.mustChangePassword,
      hasLoggedIn: agent.hasLoggedIn,
      reviewedByAdmin: agent.reviewedByAdmin,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/agent-profile/agent-profile.service.spec.ts
import { AgentProfileService } from './agent-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AgentProfileService', () => {
  let service: AgentProfileService;
  let prisma: { agent: { findUniqueOrThrow: jest.Mock } };

  beforeEach(() => {
    prisma = { agent: { findUniqueOrThrow: jest.fn() } };
    service = new AgentProfileService(prisma as unknown as PrismaService);
  });

  it('returns the whitelisted profile fields including the resolved reviewer, excluding passwordHash', async () => {
    prisma.agent.findUniqueOrThrow.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      phone: '+2348000000000',
      fullName: 'Agent Smith',
      address: '1 Example Street',
      status: 'APPROVED',
      canOnboardClients: true,
      mustChangePassword: false,
      hasLoggedIn: true,
      reviewedByAdmin: { id: 'admin-1', fullName: 'Super Admin', email: 'admin@example.com' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      passwordHash: 'should-not-leak',
    });

    const result = await service.getProfile('agent-1');

    expect(result).toEqual({
      id: 'agent-1',
      email: 'agent@example.com',
      phone: '+2348000000000',
      fullName: 'Agent Smith',
      address: '1 Example Street',
      status: 'APPROVED',
      canOnboardClients: true,
      mustChangePassword: false,
      hasLoggedIn: true,
      reviewedByAdmin: { id: 'admin-1', fullName: 'Super Admin', email: 'admin@example.com' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(result).not.toHaveProperty('passwordHash');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/agent-profile/agent-profile.service.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Write the controller**

```typescript
// src/agent-profile/agent-profile.controller.ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AgentProfileService } from './agent-profile.service';

@Controller('agent')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentProfileController {
  constructor(private readonly agentProfileService: AgentProfileService) {}

  @Get('me')
  getProfile(@Req() req: { user: JwtPayload }) {
    return this.agentProfileService.getProfile(req.user.sub);
  }
}
```

- [ ] **Step 5: Write the module**

```typescript
// src/agent-profile/agent-profile.module.ts
import { Module } from '@nestjs/common';
import { AgentProfileController } from './agent-profile.controller';
import { AgentProfileService } from './agent-profile.service';

@Module({
  controllers: [AgentProfileController],
  providers: [AgentProfileService],
})
export class AgentProfileModule {}
```

- [ ] **Step 6: Commit**

```bash
git add src/agent-profile
git commit -m "feat(agent-profile): add read-only GET agent/me"
```

---

### Task 4: Client profile (read-only)

**Files:**
- Create: `src/client-profile/client-profile.service.ts`
- Create: `src/client-profile/client-profile.service.spec.ts`
- Create: `src/client-profile/client-profile.controller.ts`
- Create: `src/client-profile/client-profile.module.ts`

**Interfaces:**
- Produces: `GET client/me`.

- [ ] **Step 1: Write the service**

```typescript
// src/client-profile/client-profile.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ClientProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    return {
      id: client.id,
      phone: client.phone,
      email: client.email,
      status: client.status,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/client-profile/client-profile.service.spec.ts
import { ClientProfileService } from './client-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClientProfileService', () => {
  let service: ClientProfileService;
  let prisma: { client: { findUniqueOrThrow: jest.Mock } };

  beforeEach(() => {
    prisma = { client: { findUniqueOrThrow: jest.fn() } };
    service = new ClientProfileService(prisma as unknown as PrismaService);
  });

  it('returns the whitelisted profile fields, excluding createdById', async () => {
    prisma.client.findUniqueOrThrow.mockResolvedValue({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'VERIFIED',
      createdById: 'admin-1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });

    const result = await service.getProfile('client-1');

    expect(result).toEqual({
      id: 'client-1',
      phone: '+2348000000000',
      email: 'client@example.com',
      status: 'VERIFIED',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(result).not.toHaveProperty('createdById');
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/client-profile/client-profile.service.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Write the controller**

```typescript
// src/client-profile/client-profile.controller.ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientProfileService } from './client-profile.service';

@Controller('client')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientProfileController {
  constructor(private readonly clientProfileService: ClientProfileService) {}

  @Get('me')
  getProfile(@Req() req: { user: JwtPayload }) {
    return this.clientProfileService.getProfile(req.user.sub);
  }
}
```

- [ ] **Step 5: Write the module**

```typescript
// src/client-profile/client-profile.module.ts
import { Module } from '@nestjs/common';
import { ClientProfileController } from './client-profile.controller';
import { ClientProfileService } from './client-profile.service';

@Module({
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}
```

- [ ] **Step 6: Commit**

```bash
git add src/client-profile
git commit -m "feat(client-profile): add read-only GET client/me"
```

---

### Task 5: Wire the new modules into `AppModule`

**Files:**
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `AgentProfileModule` (Task 3), `ClientProfileModule` (Task 4). `AdminModule` is already registered in `app.module.ts` — Task 2's changes are internal to it, no app.module.ts change needed for Admin.

- [ ] **Step 1: Add the imports**

In `src/app.module.ts`, add:

```typescript
import { AgentProfileModule } from './agent-profile/agent-profile.module';
import { ClientProfileModule } from './client-profile/client-profile.module';
```

and add both to the `imports` array (anywhere alongside the other feature modules, e.g. right after `AgentClientsModule`):

```typescript
    AgentClientsModule,
    AgentProfileModule,
    ClientProfileModule,
```

- [ ] **Step 2: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app.module.ts
git commit -m "feat: wire AgentProfileModule and ClientProfileModule into AppModule"
```

---

### Task 6: e2e tests

**Files:**
- Create: `test/admin-profile.e2e-spec.ts`
- Create: `test/agent-profile.e2e-spec.ts`
- Create: `test/client-profile.e2e-spec.ts`

**Interfaces:**
- Consumes: `/admin/me*` (Task 2), `/agent/me` (Task 3), `/client/me` (Task 4) — requires the full app wired (Task 5).

- [ ] **Step 1: Write `test/admin-profile.e2e-spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let adminId: string;
  let originalFirstName: string;
  let originalLastName: string;

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
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    const meRes = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`);
    adminId = meRes.body.id;
    originalFirstName = meRes.body.firstName;
    originalLastName = meRes.body.lastName;
  });

  afterAll(async () => {
    // Restore the shared bootstrap admin's name and clear any uploaded
    // profile image -- this fixture is persistent/shared, not a throwaway
    // row this test created, so it must be left exactly as it was found.
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        firstName: originalFirstName,
        lastName: originalLastName,
        fullName: `${originalFirstName} ${originalLastName}`.trim(),
        profileImageKey: null,
      },
    });
    await app.close();
  });

  it('returns the resolved profile with role, department, and a null profileImageUrl by default', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.id).toBe(adminId);
    expect(res.body.role).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
    expect(res.body.profileImageUrl).toBeNull();
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/admin/me').expect(401);
  });

  it('updates firstName and recomputes fullName', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ firstName: 'E2E-Updated' })
      .expect(200);
    expect(res.body.firstName).toBe('E2E-Updated');
    expect(res.body.fullName).toBe(`E2E-Updated ${originalLastName}`.trim());
  });

  it('uploads a profile image, reflects it on GET, then deletes it', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', Buffer.from('fake-image-data'), { filename: 'avatar.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(typeof uploadRes.body.profileImageUrl).toBe('string');
    expect(uploadRes.body.profileImageUrl.length).toBeGreaterThan(0);

    const meRes = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(meRes.body.profileImageUrl).toBe(uploadRes.body.profileImageUrl);

    const deleteRes = await request(app.getHttpServer())
      .delete('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(deleteRes.body.profileImageUrl).toBeNull();
  });

  it('rejects a non-image file upload', async () => {
    await request(app.getHttpServer())
      .post('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', Buffer.from('fake-pdf-data'), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(400);
  });
});
```

- [ ] **Step 2: Write `test/agent-profile.e2e-spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let agentId: string;
  let accessToken: string;
  const createdClientIds: string[] = [];
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);

    const agent = await prisma.agent.create({
      data: {
        email: `e2e-agent-profile-${Date.now()}@example.com`,
        phone: '+2348012340099',
        fullName: 'E2E Profile Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/profile.pdf',
      },
    });
    agentId = agent.id;
    createdAgentIds.push(agentId);
    accessToken = tokenService.signAccessToken({ sub: agentId, type: 'agent' });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("returns the agent's own profile fields, excluding passwordHash", async () => {
    const res = await request(app.getHttpServer())
      .get('/agent/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.id).toBe(agentId);
    expect(res.body.fullName).toBe('E2E Profile Agent');
    expect(res.body.status).toBe('APPROVED');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('rejects a client token', async () => {
    const client = await prisma.client.create({ data: { phone: `+2348099${Date.now().toString().slice(-6)}` } });
    createdClientIds.push(client.id);
    const clientToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    await request(app.getHttpServer())
      .get('/agent/me')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(403);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/agent/me').expect(401);
  });
});
```

- [ ] **Step 3: Write `test/client-profile.e2e-spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234899${Date.now().toString().slice(-7)}`;
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("returns the client's own profile fields", async () => {
    const res = await request(app.getHttpServer())
      .get('/client/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.id).toBe(clientId);
    expect(res.body.phone).toBe(phone);
    expect(res.body.status).toBe('VERIFIED');
  });

  it('rejects an agent token', async () => {
    const agent = await prisma.agent.create({
      data: {
        email: `e2e-agent-vs-client-${Date.now()}@example.com`,
        phone: '+2348012340098',
        fullName: 'E2E Vs Client Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/vs-client.pdf',
      },
    });
    createdAgentIds.push(agent.id);
    const agentToken = tokenService.signAccessToken({ sub: agent.id, type: 'agent' });

    await request(app.getHttpServer())
      .get('/client/me')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/client/me').expect(401);
  });
});
```

- [ ] **Step 4: Run all three to verify they pass**

Run: `npx jest --config ./test/jest-e2e.json admin-profile agent-profile client-profile`
Expected: PASS (10 tests). Per established project practice, re-run any failing file in isolation before treating it as a regression — this is a shared UAT database with known DB-contention flakiness under concurrent load.

- [ ] **Step 5: Commit**

```bash
git add test/admin-profile.e2e-spec.ts test/agent-profile.e2e-spec.ts test/client-profile.e2e-spec.ts
git commit -m "test(e2e): add profile endpoint coverage for Admin, Agent, and Client"
```

---

### Task 7: Postman collection update

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all six new/changed routes from Tasks 2-4.

Write a one-off Node script to a scratch location outside the repo, run it once, then delete it — same safe, repeatable pattern used for the Loan Product and Agent Client Onboarding plans' own Postman tasks.

- [ ] **Step 1: Write and run the migration script**

The script should:

1. Load the collection JSON.
2. Under **Admin**, add a new "Profile" folder with:
   - `GET /admin/me - Success` — example response matching `AdminService.getProfile`'s shape plus `permissions` (use a plausible `role`/`department` pair and `profileImageUrl: null`).
   - `GET /admin/me - Unauthenticated (401)`.
   - `PATCH /admin/me - Success` — body `{ "firstName": "Jane" }`, response with updated `firstName`/`fullName`.
   - `PATCH /admin/me - Validation error (400)` — body `{ "firstName": "" }`, response matching class-validator's `MinLength` message.
   - `POST /admin/me/profile-image - Success (201)` — multipart form-data request (file field `file`), response with a non-null `profileImageUrl`.
   - `POST /admin/me/profile-image - Invalid file type (400)` — response `{ statusCode: 400, message: "Only JPEG or PNG files are allowed", error: "Bad Request" }`.
   - `DELETE /admin/me/profile-image - Success (200)` — response with `profileImageUrl: null`.
3. Under **Agent**, add a new "Profile" folder with:
   - `GET /agent/me - Success` — example matching `AgentProfileService.getProfile`'s shape.
   - `GET /agent/me - Missing permission (403)` (use a client or admin token example, matching this collection's existing cross-principal 403 convention).
4. Under **Client**, add a new "Profile" folder with:
   - `GET /client/me - Success` — example matching `ClientProfileService.getProfile`'s shape.
   - `GET /client/me - Missing permission (403)`.

Before writing the example bodies, read the actual code from Tasks 2-4 (`AdminService`, `AgentProfileService`, `ClientProfileService`, the two DTOs) to get field names/shapes exactly right rather than guessing — same discipline as every prior Postman task this session.

- [ ] **Step 2: Validate the result**

Run:
```bash
python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo "valid JSON"
```

- [ ] **Step 3: Delete the one-off script, confirm it isn't tracked**

Run: `git status` — the script must not appear.

- [ ] **Step 4: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): add Admin/Agent/Client profile endpoint coverage"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Re-run any failing spec in isolation before treating it as a regression (known pre-existing DB-contention flakiness under full-suite concurrent load, confirmed unrelated to code correctness multiple times this session).

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint "{src,apps,libs,test}/**/*.ts"` (note: **without** `--fix` — the `npm run lint` script includes `--fix` and will reformat far more of the codebase than this feature touches) — expect no new errors beyond the established pre-existing `@typescript-eslint/no-unused-vars` baseline.

- [ ] **Step 4: Confirm the app boots live and the bootstrap admin's profile is clean**

Run `npm run start:dev` against a reachable database, confirm clean startup and that `GET admin/me`, `GET agent/me`, `GET client/me` resolve in the startup log, then stop it. Separately, confirm the shared bootstrap admin's `firstName`/`lastName`/`profileImageKey` are back to their original values after the e2e run (Task 6's `afterAll` restores them, but verify directly against the DB as a sanity check, since this is a shared, persistent fixture other sessions also rely on).

- [ ] **Step 5: Confirm no stray debug artifacts remain**

Run: `git status --short` — expect clean.
