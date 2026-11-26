-- CreateEnum
CREATE TYPE "WalletEntryDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "direction" "WalletEntryDirection" NOT NULL,
    "description" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletEntry_clientId_idx" ON "WalletEntry"("clientId");

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
