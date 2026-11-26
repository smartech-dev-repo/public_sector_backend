import { PrismaService } from '../../src/prisma/prisma.service';

/** Three equal monthly payments, so the salary table picks this amount. */
export const salaryPayments = (amount: number) => ({
  paymentThreeMonthsAgo: amount,
  paymentTwoMonthsAgo: amount,
  paymentLastMonth: amount,
});

/**
 * Loans are only allowed up to what the salary supports, which needs a repayment capacity.
 * Sets a default DTI when none is set and returns a function that puts it back.
 */
export async function ensureDefaultCapacity(prisma: PrismaService, dtiPercent = 50): Promise<() => Promise<void>> {
  const settings = (await prisma.loanSettings.findFirst()) ?? (await prisma.loanSettings.create({ data: {} }));
  if (settings.affordabilityMethod) return async () => {};
  await prisma.loanSettings.update({ where: { id: settings.id }, data: { affordabilityMethod: 'DTI', dtiPercent } });
  return async () => {
    await prisma.loanSettings.update({
      where: { id: settings.id },
      data: { affordabilityMethod: null, basePayAmount: null, dtiPercent: null },
    });
  };
}
