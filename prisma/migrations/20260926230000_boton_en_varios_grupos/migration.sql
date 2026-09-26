-- Un botón puede avisarle a varios grupos (hasta tres).
--
-- Hasta ahora Device.groupId guardaba UN grupo. Se pasa a una tabla
-- intermedia, DeviceGroup, y se conservan los vínculos que ya existen: cada
-- botón que tenía grupo queda con exactamente ese vínculo.
--
-- El límite de tres se aplica en la aplicación (src/acceso.js), no en la base:
-- "máximo N filas por deviceId" no existe en SQL sin un trigger, igual que el
-- tope de titulares por botón.

-- CreateTable
CREATE TABLE "DeviceGroup" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceGroup_groupId_idx" ON "DeviceGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceGroup_deviceId_groupId_key" ON "DeviceGroup"("deviceId", "groupId");

-- AddForeignKey
ALTER TABLE "DeviceGroup" ADD CONSTRAINT "DeviceGroup_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceGroup" ADD CONSTRAINT "DeviceGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Conservar lo que ya había: cada botón con grupo pasa a tener ese vínculo.
-- La fecha del vínculo es la de cuando se reclamó el botón (o, si no la hay,
-- la de su última modificación): es lo que decide cuál grupo es el principal.
INSERT INTO "DeviceGroup" ("id", "deviceId", "groupId", "createdAt")
SELECT gen_random_uuid()::text, "id", "groupId", COALESCE("claimedAt", "updatedAt")
FROM "Device"
WHERE "groupId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_groupId_fkey";

-- DropIndex
DROP INDEX "Device_groupId_idx";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "groupId";
