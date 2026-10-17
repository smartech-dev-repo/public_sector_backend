import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// This project's DATABASE_URL points at a shared UAT instance, not a
// disposable local one — so this deliberately does NOT wipe these tables
// wholesale. It only removes rows created within this run's own window,
// to avoid clobbering anything else happening on that shared environment
// (e.g. a person manually clicking through a staging frontend).
const TEST_RUN_WINDOW_MS = 10 * 60 * 1000;

// Individual specs' own `afterAll` cleanup only runs if the Jest process
// exits normally. A suite that times out hard, or a run that gets killed/
// interrupted partway (a shell command timeout, a manual Ctrl+C, a crashed
// worker), skips every `afterAll` that hadn't fired yet and leaves its rows
// behind forever — this is how orphaned E2E rows have accumulated in this
// shared DB in the past. Every row this suite creates carries one of two
// unambiguous, code-wide markers (never used by real production/staging
// data): an `@example.com` email, or an `E2E`-prefixed `staffId`/
// `productCode`. This second sweep catches anything matching either marker
// regardless of which spec created it or whether that spec's own cleanup
// ran, as a backstop — it is not a substitute for each spec cleaning up
// after itself, since a hard-killed process skips this too, but it runs
// every time the suite exits normally, independent of any individual
// spec's own (possibly buggy or skipped) `afterAll`.
const EXAMPLE_EMAIL_MARKER = '@example.com';
const E2E_PREFIX_MARKER = 'E2E';

export default async function globalTeardown(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const cutoff = new Date(Date.now() - TEST_RUN_WINDOW_MS);
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;

  const [sessionsByWindow, otpCodes, auditLogs] = await Promise.all([
    prisma.session.deleteMany({ where: { createdAt: { gte: cutoff } } }),
    prisma.otpCode.deleteMany({ where: { createdAt: { gte: cutoff } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { gte: cutoff } } }),
  ]);

  console.log(
    `[global-teardown] cleared incidental test rows: ${sessionsByWindow.count} sessions, ${otpCodes.count} otp codes, ${auditLogs.count} audit logs`,
  );

  const counts = await sweepMarkedTestData(prisma, bootstrapAdminEmail);
  console.log(`[global-teardown] swept marked E2E leftovers: ${JSON.stringify(counts)}`);

  await prisma.$disconnect();
}

async function sweepMarkedTestData(
  prisma: PrismaClient,
  bootstrapAdminEmail: string | undefined,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  const safeDeleteMany = async (label: string, fn: () => Promise<{ count: number }>) => {
    try {
      const result = await fn();
      counts[label] = result.count;
    } catch (error) {
      counts[label] = -1;
      console.error(`[global-teardown] failed to sweep ${label}:`, error);
    }
  };

  const ippisRecords = await prisma.ippisRecord.findMany({
    where: { staffId: { startsWith: E2E_PREFIX_MARKER } },
    select: { id: true, staffId: true },
  });
  const ippisRecordIds = ippisRecords.map((r) => r.id);
  const e2eStaffIds = ippisRecords.map((r) => r.staffId);

  const markedClients = await prisma.client.findMany({
    where: {
      OR: [
        { email: { contains: EXAMPLE_EMAIL_MARKER } },
        { onboarding: { ippisRecordId: { in: ippisRecordIds } } },
      ],
    },
    select: { id: true },
  });
  const clientIds = markedClients.map((c) => c.id);

  const markedClientLoans = await prisma.clientLoan.findMany({
    where: { staffId: { in: e2eStaffIds } },
    select: { id: true },
  });
  const clientLoanIds = markedClientLoans.map((l) => l.id);

  const markedAgents = await prisma.agent.findMany({
    where: { email: { contains: EXAMPLE_EMAIL_MARKER } },
    select: { id: true },
  });
  const agentIds = markedAgents.map((a) => a.id);

  const markedAdminUsers = await prisma.adminUser.findMany({
    where: {
      email: { contains: EXAMPLE_EMAIL_MARKER, not: bootstrapAdminEmail },
    },
    select: { id: true },
  });
  const adminUserIds = markedAdminUsers.map((a) => a.id);

  await safeDeleteMany('clientLoanRepaymentVariances', () =>
    prisma.clientLoanRepaymentVariance.deleteMany({ where: { clientLoanId: { in: clientLoanIds } } }),
  );
  await safeDeleteMany('clientLoans', () => prisma.clientLoan.deleteMany({ where: { id: { in: clientLoanIds } } }));
  await safeDeleteMany('loanRequests', () => prisma.loanRequest.deleteMany({ where: { clientId: { in: clientIds } } }));
  await safeDeleteMany('walletEntries', () => prisma.walletEntry.deleteMany({ where: { clientId: { in: clientIds } } }));
  await safeDeleteMany('agentApplications', () =>
    prisma.agentApplication.deleteMany({ where: { email: { contains: EXAMPLE_EMAIL_MARKER } } }),
  );
  await safeDeleteMany('clientOnboardings', () =>
    prisma.clientOnboarding.deleteMany({ where: { clientId: { in: clientIds } } }),
  );
  await safeDeleteMany('sessionsByPrincipal', () =>
    prisma.session.deleteMany({ where: { principalId: { in: [...agentIds, ...clientIds, ...adminUserIds] } } }),
  );
  await safeDeleteMany('agents', () => prisma.agent.deleteMany({ where: { id: { in: agentIds } } }));
  await safeDeleteMany('clients', () => prisma.client.deleteMany({ where: { id: { in: clientIds } } }));
  await safeDeleteMany('ippisRecords', () => prisma.ippisRecord.deleteMany({ where: { id: { in: ippisRecordIds } } }));
  await safeDeleteMany('loanProducts', () =>
    prisma.loanProduct.deleteMany({ where: { productCode: { startsWith: E2E_PREFIX_MARKER } } }),
  );
  await safeDeleteMany('adminInvites', () =>
    prisma.adminInvite.deleteMany({ where: { email: { contains: EXAMPLE_EMAIL_MARKER } } }),
  );
  await safeDeleteMany('adminUsers', () => prisma.adminUser.deleteMany({ where: { id: { in: adminUserIds } } }));

  return counts;
}
