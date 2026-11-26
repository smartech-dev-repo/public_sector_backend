-- CreateTable
CREATE TABLE "IppisRecord" (
    "id" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "employeeStatus" TEXT,
    "hireDate" TIMESTAMP(3),
    "dateOfBirth" TIMESTAMP(3),
    "maritalStatus" TEXT,
    "gender" TEXT,
    "jobTitle" TEXT,
    "department" TEXT,
    "subOrganization" TEXT,
    "grade" TEXT,
    "step" TEXT,
    "salary" DECIMAL(65,30),
    "phone" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "pfaName" TEXT,
    "pinNumber" TEXT,
    "dateTerminated" TIMESTAMP(3),
    "bvn" TEXT,
    "legacyId" TEXT,
    "rawFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IppisRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IppisRecord_agency_staffId_key" ON "IppisRecord"("agency", "staffId");
