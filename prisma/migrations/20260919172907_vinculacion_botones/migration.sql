-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_groupId_fkey";

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "claimCode" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "ownerId" TEXT,
ALTER COLUMN "groupId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Device_claimCode_key" ON "Device"("claimCode");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Los botones que ya estaban dados de alta con grupo quedan marcados como
-- vinculados desde que se crearon (antes no existía el concepto).
UPDATE "Device" SET "claimedAt" = "createdAt" WHERE "groupId" IS NOT NULL;
