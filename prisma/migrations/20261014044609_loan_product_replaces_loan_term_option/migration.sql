/*
  Warnings:

  - You are about to drop the `LoanTermOption` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "LoanTermOption";

-- CreateTable
CREATE TABLE "LoanProduct" (
    "id" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "sectors" TEXT[],
    "minimumAmount" DECIMAL(65,30) NOT NULL,
    "maximumAmount" DECIMAL(65,30) NOT NULL,
    "minimumTenorMonths" INTEGER NOT NULL,
    "maximumTenorMonths" INTEGER NOT NULL,
    "interestTiers" JSONB NOT NULL,
    "managementChargeType" "ManagementChargeType" NOT NULL,
    "managementChargeValue" DECIMAL(65,30) NOT NULL,
    "managementChargeApplication" "ManagementChargeApplication" NOT NULL,
    "minimumServiceMonthsLeft" INTEGER,
    "maximumMonthsInService" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanSettings" (
    "id" TEXT NOT NULL,
    "retirementAgeYears" INTEGER NOT NULL DEFAULT 60,
    "maxServiceYears" INTEGER NOT NULL DEFAULT 35,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_productCode_key" ON "LoanProduct"("productCode");
