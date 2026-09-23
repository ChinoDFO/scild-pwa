-- Se quita el sistema de transferir accesos y el de ampliar el límite.
--
-- La regla del producto queda en una sola: un botón se vincula a DOS personas
-- y nadie más puede disparar alertas con él. Ya no hay accesos que un titular
-- reparta (AccessGrant), ni compra que los sume (PaymentRequest y su chat),
-- ni la columna que los contaba (Device.extraAccesses).
--
-- Se borran los datos de esas tablas. Al aplicarla solo tenían filas de
-- prueba: 1 solicitud con 5 mensajes y ninguna transferencia.

-- DropForeignKey
ALTER TABLE "AccessGrant" DROP CONSTRAINT "AccessGrant_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "AccessGrant" DROP CONSTRAINT "AccessGrant_grantedById_fkey";

-- DropForeignKey
ALTER TABLE "AccessGrant" DROP CONSTRAINT "AccessGrant_userId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentMessage" DROP CONSTRAINT "PaymentMessage_requestId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentMessage" DROP CONSTRAINT "PaymentMessage_userId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentRequest" DROP CONSTRAINT "PaymentRequest_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentRequest" DROP CONSTRAINT "PaymentRequest_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "PaymentRequest" DROP CONSTRAINT "PaymentRequest_userId_fkey";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "extraAccesses";

-- DropTable
DROP TABLE "AccessGrant";

-- DropTable
DROP TABLE "PaymentMessage";

-- DropTable
DROP TABLE "PaymentRequest";

-- DropEnum
DROP TYPE "PaymentAuthor";

-- DropEnum
DROP TYPE "PaymentStatus";

