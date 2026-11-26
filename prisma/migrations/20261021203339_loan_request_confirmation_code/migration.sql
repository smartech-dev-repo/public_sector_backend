-- AlterTable
ALTER TABLE "LoanRequest" ADD COLUMN     "confirmationCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "confirmationCodeHash" TEXT;
