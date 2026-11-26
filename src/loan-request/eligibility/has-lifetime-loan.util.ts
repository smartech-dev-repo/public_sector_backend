import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';

export async function hasLifetimeLoan(
  prisma: PrismaService,
  clientLoansService: ClientLoansService,
  clientId: string,
): Promise<boolean> {
  const clientLoan = await prisma.clientLoan.findFirst({
    where: { clientId },
    select: { id: true },
  });
  if (clientLoan) {
    return true;
  }
  return clientLoansService.hasAnyMatchedLoan(clientId);
}
