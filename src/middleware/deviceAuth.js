import bcrypt from "bcryptjs";
import prisma from "../prisma.js";

// El ESP32 nunca debe poder actuar solo con su deviceCode (es público, va
// impreso en el equipo). Aquí se exige también el deviceSecret y se compara
// contra el hash guardado — nunca se guarda ni se compara el secreto en claro.
export async function deviceAuth(req, res, next) {
  const deviceCode = req.get("x-device-code");
  const deviceSecret = req.get("x-device-secret");

  if (!deviceCode || !deviceSecret) {
    return res.status(401).json({ error: "Credenciales de dispositivo faltantes" });
  }

  let device = await prisma.device.findUnique({ where: { deviceCode } });

  // Mismo mensaje de error si el deviceCode no existe o si el secreto no
  // coincide, para no revelar cuáles códigos de dispositivo son válidos.
  //
  // En el REGISTRO del servidor sí se distingue, porque es lo primero que se
  // necesita saber cuando un aparato en campo no logra reportarse: un código
  // que no existe suele ser un error de captura, y un secreto que no coincide
  // es otra cosa (unidad reflasheada, secreto viejo, o alguien probando). El
  // secreto nunca se escribe, solo su longitud.
  if (!device || !(await bcrypt.compare(deviceSecret, device.secretHash))) {
    console.warn(
      `Dispositivo rechazado en ${req.method} ${req.originalUrl}: ` +
        `deviceCode="${deviceCode}" (${device ? "existe, el secreto no coincide" : "no existe"}), ` +
        `secreto de ${deviceSecret.length} caracteres`
    );
    return res.status(401).json({ error: "Dispositivo no autorizado" });
  }

  // Candado contra flashear el mismo credenciales.h en dos chips distintos
  // por error (lo que pasó con BTN-002: un ESP32 de prueba mandó alertas
  // reales porque traía encima el código+secreto de un botón que ya existía).
  // El firmware manda su MAC en el cuerpo; la primera vez que se ve este
  // deviceCode se queda pinchado a esa MAC, y de ahí en adelante cualquier
  // request con el código+secreto correctos pero OTRA MAC se rechaza: es un
  // aparato físico distinto, no el mismo botón.
  //
  // Firmware viejo que todavía no manda macAddress no se ve afectado: sin
  // ese dato no hay nada que comparar, así que pasa igual que antes.
  const macEntrante = typeof req.body?.macAddress === "string" ? req.body.macAddress.trim() : "";
  if (macEntrante) {
    if (!device.macAddress) {
      device = await prisma.device.update({
        where: { id: device.id },
        data: { macAddress: macEntrante },
      });
    } else if (device.macAddress !== macEntrante) {
      console.warn(
        `Dispositivo rechazado en ${req.method} ${req.originalUrl}: ` +
          `deviceCode="${deviceCode}" tiene MAC distinta a la ya registrada ` +
          `(esperada ${device.macAddress}, llegó ${macEntrante}) — posible credencial duplicada en otro aparato`
      );
      await prisma.auditLog.create({
        data: {
          action: "DEVICE_MAC_MISMATCH",
          entity: "Device",
          entityId: device.id,
          metadata: { esperada: device.macAddress, recibida: macEntrante, ruta: req.originalUrl },
        },
      });
      return res.status(401).json({ error: "Dispositivo no autorizado" });
    }
  }

  req.device = device;
  next();
}
