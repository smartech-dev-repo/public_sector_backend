-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('IPPIS_BROADSHEET', 'REPAYMENT_SCHEDULE', 'DISBURSED_LOANS');

-- CreateEnum
CREATE TYPE "DocumentBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "DocumentUploadBatch" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "period" TEXT,
    "status" "DocumentBatchStatus" NOT NULL DEFAULT 'PENDING',
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "rowsCreated" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "errorMessage" TEXT,
    "snapshotExportId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentUploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSnapshotExport" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "sqlStorageKey" TEXT NOT NULL,
    "csvStorageKey" TEXT NOT NULL,
    "sqlUrl" TEXT NOT NULL,
    "csvUrl" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSnapshotExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentUploadBatch_snapshotExportId_key" ON "DocumentUploadBatch"("snapshotExportId");

-- AddForeignKey
ALTER TABLE "DocumentUploadBatch" ADD CONSTRAINT "DocumentUploadBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentUploadBatch" ADD CONSTRAINT "DocumentUploadBatch_snapshotExportId_fkey" FOREIGN KEY ("snapshotExportId") REFERENCES "DataSnapshotExport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
