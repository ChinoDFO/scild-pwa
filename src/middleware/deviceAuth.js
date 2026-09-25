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

  const device = await prisma.device.findUnique({ where: { deviceCode } });

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

  req.device = device;
  next();
}
