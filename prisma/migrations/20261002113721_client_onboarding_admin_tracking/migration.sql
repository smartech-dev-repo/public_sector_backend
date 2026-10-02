-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "ClientOnboarding" ADD COLUMN     "onboardedById" TEXT;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientOnboarding" ADD CONSTRAINT "ClientOnboarding_onboardedById_fkey" FOREIGN KEY ("onboardedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
