-- CreateEnum
CREATE TYPE "VarianceSource" AS ENUM ('PAYROLL_RECONCILIATION', 'WALLET_APPLICATION');

-- AlterTable
ALTER TABLE "ClientLoanRepaymentVariance" ADD COLUMN     "source" "VarianceSource" NOT NULL DEFAULT 'PAYROLL_RECONCILIATION';
