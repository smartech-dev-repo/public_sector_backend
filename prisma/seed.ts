import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from '../src/common/password-hash.util';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const BOOTSTRAP_PERMISSIONS: Array<{ key: string; description: string }> = [
  { key: 'admins:create', description: 'Create admin users' },
  { key: 'roles:manage', description: 'Create/edit roles and permissions' },
  { key: 'agents:read', description: 'View agent enrollment submissions' },
  { key: 'agents:review', description: 'Approve or reject agent submissions' },
  { key: 'clients:review', description: 'Review clients flagged for manual review' },
  { key: 'ippis:upload', description: 'Upload/refresh IPPIS master data' },
  { key: 'agents:sessions:revoke', description: "Force-revoke an agent's active sessions" },
  { key: 'clients:sessions:revoke', description: "Force-revoke a client's active sessions" },
  { key: 'audit:read', description: 'View audit log entries' },
  { key: 'loans:upload', description: 'Upload disbursed loans reports' },
  { key: 'repayments:upload', description: 'Upload IPPIS repayment schedule reports' },
  { key: 'documents:read', description: 'View document upload batches and snapshot exports' },
  { key: 'permissions:manage', description: 'Create, edit, and delete permission definitions' },
  { key: 'reconciliation:read', description: 'View loan repayment reconciliation variances' },
  { key: 'wallets:read', description: "View a client's wallet balance and entries" },
  { key: 'wallets:manage', description: "Credit or debit a client's wallet" },
  { key: 'loan-terms:manage', description: "Create/edit the agency-scoped loan terms catalog" },
  { key: 'loan-requests:review', description: 'Approve, reject, or disburse client loan requests' },
  { key: 'client-loans:read', description: "View client loans and disbursement reports" },
  { key: 'clients:read', description: "View a client's loan requests, loans, and activity history" },
  { key: 'departments:manage', description: 'Create, edit, and delete department definitions' },
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

  const passwordHash = await hashPassword(bootstrapPassword);

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
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
