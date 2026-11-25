-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "address" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- Copia la dirección que cada botón heredaba de su grupo más antiguo (el
-- "principal"), antes de que Group pierda esas columnas. Un botón puede
-- estar vinculado a varios grupos; se usa el más antiguo, igual que ya
-- hacía configuracionParaElBoton() en el código de la app.
WITH principal AS (
  SELECT DISTINCT ON ("deviceId")
    "deviceId",
    "groupId"
  FROM "DeviceGroup"
  ORDER BY "deviceId", "createdAt" ASC
)
UPDATE "Device" d
SET
  "address" = g."address",
  "latitude" = g."latitude",
  "longitude" = g."longitude"
FROM principal p
JOIN "Group" g ON g."id" = p."groupId"
WHERE d."id" = p."deviceId";

-- AlterTable
ALTER TABLE "Group" DROP COLUMN "address",
DROP COLUMN "latitude",
DROP COLUMN "longitude";
