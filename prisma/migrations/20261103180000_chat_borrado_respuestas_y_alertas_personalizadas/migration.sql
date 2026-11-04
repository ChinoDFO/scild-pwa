-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "mensajesTemporalesSegundos" INTEGER,
ADD COLUMN     "tiposFavoritos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "replyToId" TEXT;

-- CreateTable
CREATE TABLE "TipoAlertaPersonalizado" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipoAlertaPersonalizado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TipoAlertaPersonalizado_groupId_idx" ON "TipoAlertaPersonalizado"("groupId");

-- CreateIndex
CREATE INDEX "Message_replyToId_idx" ON "Message"("replyToId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipoAlertaPersonalizado" ADD CONSTRAINT "TipoAlertaPersonalizado_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

