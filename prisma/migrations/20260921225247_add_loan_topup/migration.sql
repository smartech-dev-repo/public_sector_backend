-- CreateEnum
CREATE TYPE "LoanRequestType" AS ENUM ('ORIGINATION', 'TOPUP');

-- AlterTable
ALTER TABLE "LoanRequest" ADD COLUMN     "topupTargetId" TEXT,
ADD COLUMN     "type" "LoanRequestType" NOT NULL DEFAULT 'ORIGINATION';

-- AddForeignKey
ALTER TABLE "LoanRequest" ADD CONSTRAINT "LoanRequest_topupTargetId_fkey" FOREIGN KEY ("topupTargetId") REFERENCES "ClientLoan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
