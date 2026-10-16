-- CreateEnum
CREATE TYPE "AgentApplicationStatus" AS ENUM ('EMAIL_PENDING', 'EMAIL_VERIFIED', 'SUBMITTED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "city" TEXT,
ADD COLUMN     "coverLetter" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "identityDocumentKey" TEXT,
ADD COLUMN     "localGovernment" TEXT,
ADD COLUMN     "nin" TEXT,
ADD COLUMN     "ninVerified" BOOLEAN,
ADD COLUMN     "ninVerifiedName" TEXT,
ADD COLUMN     "passportPhotoKey" TEXT,
ADD COLUMN     "state" TEXT;

-- CreateTable
CREATE TABLE "AgentApplication" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "AgentApplicationStatus" NOT NULL DEFAULT 'EMAIL_PENDING',
    "emailCodeHash" TEXT,
    "emailCodeExpiresAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "fullName" TEXT,
    "phone" TEXT,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "localGovernment" TEXT,
    "nin" TEXT,
    "ninVerified" BOOLEAN,
    "ninVerifiedName" TEXT,
    "coverLetter" TEXT,
    "cvKey" TEXT,
    "passportPhotoKey" TEXT,
    "identityDocumentKey" TEXT,
    "submittedAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentApplication_email_key" ON "AgentApplication"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApplication_submittedAgentId_key" ON "AgentApplication"("submittedAgentId");

-- AddForeignKey
ALTER TABLE "AgentApplication" ADD CONSTRAINT "AgentApplication_submittedAgentId_fkey" FOREIGN KEY ("submittedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
