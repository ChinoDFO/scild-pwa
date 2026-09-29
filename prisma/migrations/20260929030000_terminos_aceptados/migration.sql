-- Cuándo aceptó la persona la versión vigente de los Términos y Condiciones
-- / Aviso de Privacidad. Null = todavía no los acepta (bloquea el uso).
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
