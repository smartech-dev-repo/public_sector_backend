-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "passwordResetTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetTokenHash" TEXT;
