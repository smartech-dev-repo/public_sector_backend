-- CreateEnum
CREATE TYPE "AffordabilityMethod" AS ENUM ('BASE_PAY', 'DTI');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "affordabilityMethod" "AffordabilityMethod",
ADD COLUMN     "basePayAmount" DECIMAL(65,30),
ADD COLUMN     "dtiPercent" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledByLoanRequestId" TEXT;

-- AlterTable
ALTER TABLE "LoanRequest" ADD COLUMN     "affordability" JSONB,
ADD COLUMN     "topupImportedLoanId" TEXT,
ADD COLUMN     "topupOutstandingBalance" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "LoanSettings" ADD COLUMN     "affordabilityMethod" "AffordabilityMethod",
ADD COLUMN     "basePayAmount" DECIMAL(65,30),
ADD COLUMN     "dtiPercent" DECIMAL(65,30),
ADD COLUMN     "salaryPatternOutcomes" JSONB;

-- AlterTable
ALTER TABLE "Sector" ADD COLUMN     "affordabilityMethod" "AffordabilityMethod",
ADD COLUMN     "basePayAmount" DECIMAL(65,30),
ADD COLUMN     "dtiPercent" DECIMAL(65,30);

