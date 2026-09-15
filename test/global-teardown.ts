import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// This project's DATABASE_URL points at a shared UAT instance, not a
// disposable local one — so this deliberately does NOT wipe these tables
// wholesale. It only removes rows created within this run's own window,
// to avoid clobbering anything else happening on that shared environment
// (e.g. a person manually clicking through a staging frontend).
const TEST_RUN_WINDOW_MS = 10 * 60 * 1000;

export default async function globalTeardown(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const cutoff = new Date(Date.now() - TEST_RUN_WINDOW_MS);

  const [sessions, otpCodes, auditLogs] = await Promise.all([
    prisma.session.deleteMany({ where: { createdAt: { gte: cutoff } } }),
    prisma.otpCode.deleteMany({ where: { createdAt: { gte: cutoff } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { gte: cutoff } } }),
  ]);

  console.log(
    `[global-teardown] cleared incidental test rows: ${sessions.count} sessions, ${otpCodes.count} otp codes, ${auditLogs.count} audit logs`,
  );

  await prisma.$disconnect();
}
