-- AlterTable
ALTER TABLE "ClientOnboarding" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "identityDateOfBirth" TIMESTAMP(3),
ADD COLUMN     "identityGender" TEXT,
ADD COLUMN     "identityPhoneNumber" TEXT,
ADD COLUMN     "lgaOfOrigin" TEXT,
ADD COLUMN     "lgaOfResidence" TEXT,
ADD COLUMN     "maritalStatus" TEXT,
ADD COLUMN     "stateOfOrigin" TEXT,
ADD COLUMN     "stateOfResidence" TEXT,
ADD COLUMN     "zipCode" TEXT;
