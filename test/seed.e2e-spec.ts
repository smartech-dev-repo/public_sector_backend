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
