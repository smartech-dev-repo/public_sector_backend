-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "address" TEXT,
    "branch" TEXT,
    "gender" TEXT,
    "phone" TEXT,
    "ippisNumber" TEXT NOT NULL,
    "agency" TEXT,
    "loanAmount" DECIMAL(65,30) NOT NULL,
    "principalBalance" DECIMAL(65,30) NOT NULL,
    "disbursementDate" TIMESTAMP(3) NOT NULL,
    "maturationDate" TIMESTAMP(3) NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "moratoriumDays" INTEGER,
    "product" TEXT NOT NULL,
    "linkedAccountNumber" TEXT,
    "bvn" TEXT,
    "interestRatePercent" DECIMAL(65,30) NOT NULL,
    "accountOfficer" TEXT,
    "hasPreviouslyTakenLoan" BOOLEAN NOT NULL DEFAULT false,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Loan_customerId_key" ON "Loan"("customerId");

-- CreateIndex
CREATE INDEX "Loan_ippisNumber_idx" ON "Loan"("ippisNumber");
