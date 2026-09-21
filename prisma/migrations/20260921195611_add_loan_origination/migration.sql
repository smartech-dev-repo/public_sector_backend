/*
  Warnings:

  - Added the required column `interestRatePercent` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managementChargeAmount` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managementChargeApplication` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managementChargeType` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managementChargeValue` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenorMonths` to the `LoanRequest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ManagementChargeType" AS ENUM ('PERCENTAGE', 'FLAT');

-- CreateEnum
CREATE TYPE "ManagementChargeApplication" AS ENUM ('DEDUCT_FROM_DISBURSEMENT', 'ADD_TO_REPAYMENT');

-- CreateEnum
CREATE TYPE "ClientLoanStatus" AS ENUM ('ACTIVE', 'CLOSED', 'DEFAULT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LoanRequestStatus" ADD VALUE 'APPROVED';
ALTER TYPE "LoanRequestStatus" ADD VALUE 'DISBURSED';
ALTER TYPE "LoanRequestStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "LoanRequest" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "disbursedAt" TIMESTAMP(3),
ADD COLUMN     "interestRatePercent" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "managementChargeAmount" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "managementChargeApplication" "ManagementChargeApplication" NOT NULL,
ADD COLUMN     "managementChargeType" "ManagementChargeType" NOT NULL,
ADD COLUMN     "managementChargeValue" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "tenorMonths" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "LoanTermOption" (
    "id" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "tenorMonths" INTEGER NOT NULL,
    "interestRatePercent" DECIMAL(65,30) NOT NULL,
    "managementChargeType" "ManagementChargeType" NOT NULL,
    "managementChargeValue" DECIMAL(65,30) NOT NULL,
    "managementChargeApplication" "ManagementChargeApplication" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanTermOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientLoan" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "loanRequestId" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "principalAmount" DECIMAL(65,30) NOT NULL,
    "disbursedAmount" DECIMAL(65,30) NOT NULL,
    "principalBalance" DECIMAL(65,30) NOT NULL,
    "tenorMonths" INTEGER NOT NULL,
    "interestRatePercent" DECIMAL(65,30) NOT NULL,
    "managementChargeType" "ManagementChargeType" NOT NULL,
    "managementChargeValue" DECIMAL(65,30) NOT NULL,
    "managementChargeApplication" "ManagementChargeApplication" NOT NULL,
    "managementChargeAmount" DECIMAL(65,30) NOT NULL,
    "disbursementDate" TIMESTAMP(3) NOT NULL,
    "maturationDate" TIMESTAMP(3) NOT NULL,
    "status" "ClientLoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientLoan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanTermOption_agency_tenorMonths_key" ON "LoanTermOption"("agency", "tenorMonths");

-- CreateIndex
CREATE UNIQUE INDEX "ClientLoan_loanRequestId_key" ON "ClientLoan"("loanRequestId");

-- AddForeignKey
ALTER TABLE "ClientLoan" ADD CONSTRAINT "ClientLoan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLoan" ADD CONSTRAINT "ClientLoan_loanRequestId_fkey" FOREIGN KEY ("loanRequestId") REFERENCES "LoanRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
