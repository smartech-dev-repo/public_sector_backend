-- CreateTable
CREATE TABLE "ClientLoanRepaymentVariance" (
    "id" TEXT NOT NULL,
    "clientLoanId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "expectedAmount" DECIMAL(65,30) NOT NULL,
    "actualAmount" DECIMAL(65,30) NOT NULL,
    "variance" DECIMAL(65,30) NOT NULL,
    "status" "VarianceStatus" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientLoanRepaymentVariance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientLoanRepaymentVariance_clientLoanId_period_key" ON "ClientLoanRepaymentVariance"("clientLoanId", "period");

-- AddForeignKey
ALTER TABLE "ClientLoanRepaymentVariance" ADD CONSTRAINT "ClientLoanRepaymentVariance_clientLoanId_fkey" FOREIGN KEY ("clientLoanId") REFERENCES "ClientLoan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
