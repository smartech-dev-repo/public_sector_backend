-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "changePasswordCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "changePasswordCodeHash" TEXT,
ADD COLUMN     "changePasswordPendingHash" TEXT;
