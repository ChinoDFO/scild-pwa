import prisma from "./prisma.js";
import { normalizarClaimCode } from "./claimCode.js";

// Qué puede hacer cada cuenta en la app.
//
// El permiso vive en la CUENTA, no en el grupo: si estás vinculado a un
// botón, puedes disparar alertas en cualquier grupo donde te metan. Es lo que
// hace funcionar el caso comunitario — en un coto con varios botones, cada
// quien avisa de lo suyo y todos se enteran — sin que un vecino tenga que
// habilitar a otro a mano.
//
// Una cuenta es COMPLETA si es titular de un botón, o sea si validó el código
// impreso en su caja. No hay otra forma: el permiso no se presta, no se
// regala y no se compra. Cualquier otra es INVITADA: lee y escribe en el chat
// de los grupos donde la metan, pero no dispara alertas de ningún tipo.

// Un botón es de la casa, no de una persona: lo comparten los dos que viven
// ahí. Por eso el código de la caja se puede validar dos veces.
export const TITULARES_POR_BOTON = 2;

// Cada botón da cupo para diez personas en el grupo donde está vinculado.
export const LUGARES_POR_BOTON = 10;

// Error con código HTTP, para que las rutas no tengan que traducir mensajes.
export class ErrorDeAcceso extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

// El acceso de una cuenta, resuelto de una sola vez. Se consulta seguido
// (cada alerta, cada detalle de grupo), así que son dos consultas y ya.
export async function accesoDeCuenta(userId) {
  const titularidades = await prisma.deviceHolder.findMany({
    where: { userId },
    select: { deviceId: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    // Lo único que hay que preguntar para dejar disparar una alerta.
    completo: titularidades.length > 0,
    esTitular: titularidades.length > 0,
    // Botones de los que es titular: de ahí salen sus cupos.
    botones: titularidades.map((t) => t.deviceId),
  };
}

// Igual que accesoDeCuenta pero para varias personas de un jalón (la lista de
// miembros de un grupo), sin una consulta por cabeza.
export async function cuentasCompletas(userIds) {
  if (userIds.length === 0) return new Set();

  const titulares = await prisma.deviceHolder.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  });

  return new Set(titulares.map((t) => t.userId));
}

// Vincula una cuenta a un botón con el código impreso en su caja. Es lo que
// se pide al crear la cuenta y lo que ofrece el apartado de Códigos.
//
// El tope de dos titulares se cuida DESPUÉS de insertar, dentro de la misma
// transacción: contar antes deja pasar dos códigos que llegan al mismo
// tiempo, y "máximo dos filas por botón" no es algo que Postgres pueda
// garantizar con un índice.
// `siYaEraTitular` decide qué pasa cuando la cuenta YA es titular del botón:
//
//   "error"  — lo que quiere el apartado de Códigos: ahí la acción ES vincular
//              el botón a la cuenta, así que repetirlo no tiene sentido.
//   "seguir" — lo que quiere vincular el botón a un GRUPO: ahí ser titular no
//              es un problema, es el requisito. Antes reventaba aquí y nunca
//              llegaba a tocar el grupo, que es lo único que se pedía.
export async function volverseTitular({ userId, claimCode, siYaEraTitular = "error" }) {
  const codigo = normalizarClaimCode(claimCode);
  if (!codigo) {
    throw new ErrorDeAcceso(400, "El código de vinculación no es válido");
  }

  const device = await prisma.device.findUnique({ where: { claimCode: codigo } });
  // Mismo mensaje exista o no: quien no tiene la caja no debería poder
  // averiguar si un código es real.
  if (!device) {
    throw new ErrorDeAcceso(404, "No encontramos ese código. Revísalo tal como viene en la caja.");
  }

  const yaEra = await prisma.deviceHolder.findUnique({
    where: { deviceId_userId: { deviceId: device.id, userId } },
  });
  if (yaEra) {
    if (siYaEraTitular === "error") {
      throw new ErrorDeAcceso(409, "Ese botón ya está vinculado a tu cuenta");
    }
    // No se vuelve a insertar ni se toca claimedAt/ownerId: ya es suyo.
    const titulares = await prisma.deviceHolder.count({ where: { deviceId: device.id } });
    return { device, titulares, yaEra: true };
  }

  return prisma.$transaction(async (tx) => {
    await tx.deviceHolder.create({ data: { deviceId: device.id, userId } });

    const titulares = await tx.deviceHolder.count({ where: { deviceId: device.id } });
    if (titulares > TITULARES_POR_BOTON) {
      // Revienta la transacción: el insert de arriba se deshace.
      throw new ErrorDeAcceso(
        409,
        "Ese código ya se usó dos veces. Cada botón se comparte entre dos personas."
      );
    }

    // El primero en llegar queda como dueño del aparato (es quien puede
    // desvincularlo del grupo). claimedAt marca que el botón ya está en uso.
    if (titulares === 1) {
      await tx.device.update({
        where: { id: device.id },
        data: { ownerId: userId, claimedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        userId,
        action: "DEVICE_HOLDER_ADDED",
        entity: "Device",
        entityId: device.id,
        metadata: { deviceCode: device.deviceCode, titular: titulares },
      },
    });

    return { device, titulares };
  });
}
