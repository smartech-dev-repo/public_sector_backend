-- CreateEnum
CREATE TYPE "ClientDocumentType" AS ENUM ('NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE');

-- AlterEnum
ALTER TYPE "OnboardingStep" ADD VALUE 'DOCUMENTS_SUBMITTED';

-- CreateTable
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL,
    "clientOnboardingId" TEXT NOT NULL,
    "documentType" "ClientDocumentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientDocument_clientOnboardingId_documentType_key" ON "ClientDocument"("clientOnboardingId", "documentType");

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_clientOnboardingId_fkey" FOREIGN KEY ("clientOnboardingId") REFERENCES "ClientOnboarding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
