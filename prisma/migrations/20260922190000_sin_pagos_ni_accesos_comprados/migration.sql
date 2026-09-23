-- Fuera el sistema de pagos y los accesos comprados.
--
-- Un botón da funciones completas a sus dos titulares y cupo para diez
-- personas en el grupo; el resto entra como invitado. Ya no hay forma de
-- comprar accesos completos ni, por lo tanto, comprobantes que revisar.
--
-- Todo va con IF EXISTS a propósito: en la base compartida esto ya se aplicó
-- a mano el 21 de septiembre (migración 20260921120000_sin_transferencias_ni_pagos,
-- que nunca llegó al repositorio), así que aquí no encuentra nada que tirar.
-- En una base nueva sí hace el trabajo.
DROP TABLE IF EXISTS "PaymentMessage";
DROP TABLE IF EXISTS "PaymentRequest";
DROP TABLE IF EXISTS "AccessGrant";

DROP TYPE IF EXISTS "PaymentStatus";
DROP TYPE IF EXISTS "PaymentAuthor";

ALTER TABLE "Device" DROP COLUMN IF EXISTS "extraAccesses";
