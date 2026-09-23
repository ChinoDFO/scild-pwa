-- El cupo deja de salir de los botones y pasa a ser del grupo.
--
-- Antes cada botón vinculado daba diez lugares y cada membresía apuntaba al
-- botón que pagaba el suyo (seatDeviceId). Eso ataba el tamaño del grupo a
-- cuántos aparatos había dentro, que son dos cosas sin relación: un coto con
-- un solo botón puede necesitar veinte vecinos enterados.
--
-- Ahora Group.maxMembers lo edita el administrador, arranca en 10 —lo mismo
-- que daba un botón, para que ningún grupo existente se quede corto— y tiene
-- tope de 50 en la aplicación.

-- DropForeignKey
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_seatDeviceId_fkey";

-- DropIndex
DROP INDEX "GroupMember_seatDeviceId_idx";

-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "maxMembers" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "GroupMember" DROP COLUMN "seatDeviceId";


-- Ningún grupo puede nacer con el cupo por debajo de la gente que ya tiene
-- dentro: a nadie se le saca por esta migración. Hoy ninguno pasa de 10, pero
-- la cuenta se hace igual por si esto se aplica más tarde en otra base.
UPDATE "Group" g
SET "maxMembers" = GREATEST(
  g."maxMembers",
  (SELECT COUNT(*) FROM "GroupMember" m WHERE m."groupId" = g.id)
);
