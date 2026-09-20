-- El comprobante de pago se guarda en la base y ya no en Firebase Storage:
-- el proyecto ya tiene Postgres, y habilitar Storage obliga a cambiar el
-- proyecto de Firebase al plan de pago por uso. Un comprobante de celular
-- pesa unos cientos de kilobytes y son unos pocos por cliente.
--
-- No hay datos que migrar: se hace antes de recibir el primer pago.
ALTER TABLE "PaymentRequest" DROP COLUMN "proofPath";
ALTER TABLE "PaymentRequest" ADD COLUMN "proofImage" BYTEA;
ALTER TABLE "PaymentRequest" ADD COLUMN "proofType" TEXT;
