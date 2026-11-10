-- CreateEnum
CREATE TYPE "RepaymentMatchStatus" AS ENUM ('MATCHED', 'NO_LOAN', 'REQUEST_NOT_DISBURSED', 'BEFORE_DISBURSEMENT', 'AFTER_MATURITY', 'AFTER_SETTLEMENT', 'NO_PERIOD');

-- CreateEnum
CREATE TYPE "RepaymentResolution" AS ENUM ('ASSIGNED', 'REFUNDED', 'DISMISSED');

-- AlterTable
ALTER TABLE "LoanRepaymentRecord" ADD COLUMN     "appliedPeriod" TEXT,
ADD COLUMN     "clientLoanId" TEXT,
ADD COLUMN     "loanId" TEXT,
ADD COLUMN     "matchStatus" "RepaymentMatchStatus" NOT NULL DEFAULT 'NO_LOAN',
ADD COLUMN     "refundWalletEntryId" TEXT,
ADD COLUMN     "resolution" "RepaymentResolution",
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;

-- CreateIndex
CREATE INDEX "LoanRepaymentRecord_matchStatus_resolution_idx" ON "LoanRepaymentRecord"("matchStatus", "resolution");

-- CreateIndex
CREATE INDEX "LoanRepaymentRecord_loanId_idx" ON "LoanRepaymentRecord"("loanId");

-- CreateIndex
CREATE INDEX "LoanRepaymentRecord_clientLoanId_idx" ON "LoanRepaymentRecord"("clientLoanId");

-- AddForeignKey
ALTER TABLE "LoanRepaymentRecord" ADD CONSTRAINT "LoanRepaymentRecord_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepaymentRecord" ADD CONSTRAINT "LoanRepaymentRecord_clientLoanId_fkey" FOREIGN KEY ("clientLoanId") REFERENCES "ClientLoan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepaymentRecord" ADD CONSTRAINT "LoanRepaymentRecord_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Assigning, refunding and dismissing deductions that match no loan. Refunds still need approvals:wallets.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'reconciliation:resolve', 'Assign, refund or dismiss payroll deductions that match no running loan')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r, "Permission" p
WHERE r."name" = 'SUPER_ADMIN' AND p."key" = 'reconciliation:resolve'
ON CONFLICT DO NOTHING;
