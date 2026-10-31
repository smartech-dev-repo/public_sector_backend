-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentBatchStatus" ADD VALUE 'ANALYZING';
ALTER TYPE "DocumentBatchStatus" ADD VALUE 'AWAITING_CONFIRMATION';
ALTER TYPE "DocumentBatchStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "DocumentUploadBatch" ADD COLUMN     "analysis" JSONB,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "fileSizeBytes" INTEGER,
ADD COLUMN     "storedFileName" TEXT;

-- AlterTable
ALTER TABLE "IppisRecord" ADD COLUMN     "monthAPayment" DECIMAL(65,30),
ADD COLUMN     "monthBPayment" DECIMAL(65,30),
ADD COLUMN     "monthCPayment" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "ManagementFee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ManagementChargeType" NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "minAmount" DECIMAL(65,30),
    "maxAmount" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagementFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_LoanProductToManagementFee" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_LoanProductToManagementFee_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagementFee_name_key" ON "ManagementFee"("name");

-- CreateIndex
CREATE INDEX "_LoanProductToManagementFee_B_index" ON "_LoanProductToManagementFee"("B");

-- AddForeignKey
ALTER TABLE "_LoanProductToManagementFee" ADD CONSTRAINT "_LoanProductToManagementFee_A_fkey" FOREIGN KEY ("A") REFERENCES "LoanProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LoanProductToManagementFee" ADD CONSTRAINT "_LoanProductToManagementFee_B_fkey" FOREIGN KEY ("B") REFERENCES "ManagementFee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
