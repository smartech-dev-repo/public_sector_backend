-- CreateEnum
CREATE TYPE "WalletEntrySource" AS ENUM ('MANUAL', 'LOAN_OVERPAYMENT', 'DEDUCTION_REFUND', 'LOAN_REPAYMENT');

-- AlterTable
ALTER TABLE "WalletEntry" ADD COLUMN "source" "WalletEntrySource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "reference" TEXT;

-- Backfill existing entries from the descriptions the system writes.
UPDATE "WalletEntry" SET "source" = 'LOAN_OVERPAYMENT' WHERE "actorType" = 'SYSTEM' AND "direction" = 'CREDIT' AND "description" LIKE 'Loan overpayment excess%';

UPDATE "WalletEntry" w SET "source" = 'DEDUCTION_REFUND', "reference" = r."id"
FROM "LoanRepaymentRecord" r
WHERE r."refundWalletEntryId" = w."id";

UPDATE "WalletEntry" SET "source" = 'DEDUCTION_REFUND' WHERE "source" = 'MANUAL' AND "direction" = 'CREDIT' AND "description" LIKE 'Refund of payroll deduction%';

UPDATE "WalletEntry" SET "source" = 'LOAN_REPAYMENT', "reference" = substring("description" from '^Applied toward loan #(.+)$')
WHERE "direction" = 'DEBIT' AND "description" LIKE 'Applied toward loan #%';

-- CreateIndex
CREATE INDEX "WalletEntry_createdAt_idx" ON "WalletEntry"("createdAt");

-- CreateIndex
CREATE INDEX "WalletEntry_source_idx" ON "WalletEntry"("source");
