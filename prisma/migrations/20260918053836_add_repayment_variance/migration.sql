-- CreateEnum
CREATE TYPE "VarianceStatus" AS ENUM ('MATCHED', 'UNDER_PAID', 'OVER_PAID', 'NO_DEDUCTION_FOUND');

-- CreateTable
CREATE TABLE "RepaymentVariance" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "expectedAmount" DECIMAL(65,30) NOT NULL,
    "actualAmount" DECIMAL(65,30) NOT NULL,
    "variance" DECIMAL(65,30) NOT NULL,
    "status" "VarianceStatus" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepaymentVariance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepaymentVariance_loanId_period_key" ON "RepaymentVariance"("loanId", "period");

-- AddForeignKey
ALTER TABLE "RepaymentVariance" ADD CONSTRAINT "RepaymentVariance_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
