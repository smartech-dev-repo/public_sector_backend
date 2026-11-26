-- CreateTable
CREATE TABLE "LoanRepaymentRecord" (
    "id" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "period" TEXT,
    "elementName" TEXT NOT NULL,
    "elementDetail" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRepaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanRepaymentRecord_agency_staffId_period_elementName_key" ON "LoanRepaymentRecord"("agency", "staffId", "period", "elementName");
