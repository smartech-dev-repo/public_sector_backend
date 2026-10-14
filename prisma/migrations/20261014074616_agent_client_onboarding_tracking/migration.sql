-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "canOnboardClients" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ClientOnboarding" ADD COLUMN     "onboardedByAgentId" TEXT;

-- AddForeignKey
ALTER TABLE "ClientOnboarding" ADD CONSTRAINT "ClientOnboarding_onboardedByAgentId_fkey" FOREIGN KEY ("onboardedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
