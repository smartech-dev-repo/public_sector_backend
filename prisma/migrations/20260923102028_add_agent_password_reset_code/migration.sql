-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "passwordResetCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetCodeHash" TEXT;
