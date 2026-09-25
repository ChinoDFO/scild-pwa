-- Telemetría que el ESP32 manda en cada heartbeat.
--
-- Hasta ahora el botón solo reportaba batería y firmware, y la pantalla del
-- aparato en la app enseñaba "Sin datos" en cuatro de sus seis casillas. Con
-- esto se llenan: red activa, IP, señal (RSSI) y fallos de internet.
--
-- Se guarda el ÚLTIMO valor aquí porque es lo que se consulta —"¿cómo está
-- este botón ahorita?"—; el histórico crudo sigue cayendo en DeviceEvent.
--
-- internetFailures arranca en 0 y no en NULL: "nunca ha reportado" y "no ha
-- fallado" se ven igual en la pantalla, y 0 evita tener que cuidar el nulo en
-- cada suma.

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "ssid" TEXT,
ADD COLUMN     "rssi" INTEGER,
ADD COLUMN     "internetFailures" INTEGER NOT NULL DEFAULT 0;
