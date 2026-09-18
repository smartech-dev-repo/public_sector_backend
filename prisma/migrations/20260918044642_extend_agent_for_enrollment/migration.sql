/*
  Warnings:

  - Added the required column `address` to the `Agent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cvKey` to the `Agent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "address" TEXT NOT NULL,
ADD COLUMN     "cvKey" TEXT NOT NULL,
ADD COLUMN     "hasLoggedIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "supportingDocumentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
