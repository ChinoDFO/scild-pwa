-- Titulares de un botón: el código impreso en la caja se valida hasta DOS
-- veces, y quien lo valida obtiene las funciones completas de la app.
CREATE TABLE "DeviceHolder" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHolder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceHolder_deviceId_userId_key" ON "DeviceHolder"("deviceId", "userId");
CREATE INDEX "DeviceHolder_userId_idx" ON "DeviceHolder"("userId");

ALTER TABLE "DeviceHolder" ADD CONSTRAINT "DeviceHolder_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceHolder" ADD CONSTRAINT "DeviceHolder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Acceso completo que un titular reparte entre los invitados de su grupo,
-- con los lugares que compró (Device.extraAccesses).
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessGrant_deviceId_userId_key" ON "AccessGrant"("deviceId", "userId");
CREATE INDEX "AccessGrant_userId_idx" ON "AccessGrant"("userId");

ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_grantedById_fkey"
    FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lugares completos comprados. De fábrica un botón solo da funciones
-- completas a sus 2 titulares; cada compra suma 5 para repartir.
ALTER TABLE "Device" ADD COLUMN "extraAccesses" INTEGER NOT NULL DEFAULT 0;

-- De qué botón sale el lugar que ocupa cada miembro del grupo (10 por botón).
ALTER TABLE "GroupMember" ADD COLUMN "seatDeviceId" TEXT;
CREATE INDEX "GroupMember_seatDeviceId_idx" ON "GroupMember"("seatDeviceId");
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_seatDeviceId_fkey"
    FOREIGN KEY ("seatDeviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Quien ya tenía un botón vinculado se vuelve su primer titular: nadie
-- pierde el acceso que ya tenía al desplegar esto.
INSERT INTO "DeviceHolder" ("id", "deviceId", "userId", "createdAt")
SELECT gen_random_uuid()::text, d."id", d."ownerId", COALESCE(d."claimedAt", CURRENT_TIMESTAMP)
FROM "Device" d
WHERE d."ownerId" IS NOT NULL;

-- Y las membresías que ya existían ocupan el lugar del botón más antiguo de
-- su grupo, para que el conteo de cupos arranque cuadrado.
UPDATE "GroupMember" AS gm
SET "seatDeviceId" = (
    SELECT d."id" FROM "Device" d
    WHERE d."groupId" = gm."groupId"
    ORDER BY d."createdAt" ASC
    LIMIT 1
);
