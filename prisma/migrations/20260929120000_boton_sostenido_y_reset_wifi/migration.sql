-- Alguien pidió desde la app que el botón olvide su red Wi-Fi principal y
-- vuelva a abrir su portal. Se entrega en el siguiente heartbeat/status y se
-- limpia ahí mismo: es un mandado de una sola vez, no un ajuste persistente.
ALTER TABLE "Device" ADD COLUMN "wifiResetRequestedAt" TIMESTAMP(3);

-- Último "sigue presionado" mandado mientras la alerta seguía ACTIVE. Null
-- hasta el primero, que se manda a los 15 min de createdAt.
ALTER TABLE "Alert" ADD COLUMN "lastReminderAt" TIMESTAMP(3);
