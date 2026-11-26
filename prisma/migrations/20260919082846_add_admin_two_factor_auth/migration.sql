-- CreateEnum
CREATE TYPE "TwoFactorMethod" AS ENUM ('TOTP', 'EMAIL');

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "twoFactorEmailCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "twoFactorEmailCodeHash" TEXT,
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorMethod" "TwoFactorMethod",
ADD COLUMN     "twoFactorPendingMethod" "TwoFactorMethod",
ADD COLUMN     "twoFactorPendingSecret" TEXT,
ADD COLUMN     "twoFactorSecret" TEXT;
