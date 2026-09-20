-- Solicitudes de ampliación de límite: el cliente paga por transferencia y
-- un administrador de la plataforma confirma el depósito a mano.
CREATE TYPE "PaymentStatus" AS ENUM ('ABIERTA', 'EN_REVISION', 'APROBADA', 'RECHAZADA', 'CANCELADA');
CREATE TYPE "PaymentAuthor" AS ENUM ('CLIENTE', 'SOPORTE');

-- Administrador de la plataforma (nosotros), no de un grupo. Se prende a
-- mano en la base: no hay forma de dárselo a sí mismo desde la app.
ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'ABIERTA',
    "proofPath" TEXT,
    "proofAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentRequest_status_createdAt_idx" ON "PaymentRequest"("status", "createdAt");
CREATE INDEX "PaymentRequest_userId_idx" ON "PaymentRequest"("userId");

ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El chat de cada solicitud. El cliente manda mensajes de un catálogo
-- cerrado; el texto lo resuelve el backend.
CREATE TABLE "PaymentMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "from" "PaymentAuthor" NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentMessage_requestId_createdAt_idx" ON "PaymentMessage"("requestId", "createdAt");

ALTER TABLE "PaymentMessage" ADD CONSTRAINT "PaymentMessage_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentMessage" ADD CONSTRAINT "PaymentMessage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
