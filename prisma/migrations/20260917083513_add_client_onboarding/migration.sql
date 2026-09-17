-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('PHONE_VERIFIED', 'IPPIS_LINKED', 'IDENTITY_SUBMITTED', 'FACE_MATCH_PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "ClientOnboarding" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ippisRecordId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "bvn" TEXT,
    "nin" TEXT,
    "bvnSelfie" TEXT,
    "ninSelfie" TEXT,
    "liveSelfieKey" TEXT,
    "identityVerified" BOOLEAN,
    "faceMatchBvnScore" DOUBLE PRECISION,
    "faceMatchNinScore" DOUBLE PRECISION,
    "faceMatchPassed" BOOLEAN,
    "step" "OnboardingStep" NOT NULL DEFAULT 'PHONE_VERIFIED',
    "failureReasons" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientOnboarding_clientId_key" ON "ClientOnboarding"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientOnboarding_ippisRecordId_key" ON "ClientOnboarding"("ippisRecordId");

-- AddForeignKey
ALTER TABLE "ClientOnboarding" ADD CONSTRAINT "ClientOnboarding_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientOnboarding" ADD CONSTRAINT "ClientOnboarding_ippisRecordId_fkey" FOREIGN KEY ("ippisRecordId") REFERENCES "IppisRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
