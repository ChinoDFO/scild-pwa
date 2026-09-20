import prisma from "./prisma.js";

// Limpieza periódica de datos que ya no hacen falta.
//
// Por ahora solo una cosa: las capturas de los comprobantes de pago. Un
// comprobante trae el nombre, el banco y el monto de una persona, y una vez
// que el trámite se cerró no hay razón para seguirlo guardando. Se suelta la
// imagen pero se conserva la solicitud: el historial de quién pidió qué,
// cuándo y en qué acabó sigue completo, y con él la bitácora de por qué un
// botón tiene los accesos que tiene.

// Cuánto se conserva una captura después de mandarla.
const MESES_DE_CAPTURAS = 3;

// Cada cuánto se revisa. Diario es de sobra para un plazo de tres meses, y
// deja el borrado repartido en vez de hacer un barrido enorme de golpe.
const CADA_MS = 24 * 60 * 60 * 1000;

// Al arrancar no se corre de inmediato: si el servidor se reinicia seguido
// (un despliegue, `node --watch` en desarrollo) no tiene caso repetir el
// barrido en cada arranque.
const PRIMERA_VEZ_MS = 5 * 60 * 1000;

// Trámites terminados. Una solicitud que sigue abierta conserva su captura
// aunque tenga meses: todavía le falta que alguien la revise.
const ESTADOS_CERRADOS = ["APROBADA", "RECHAZADA", "CANCELADA"];

export function fechaDeCorte(ahora = new Date()) {
  const corte = new Date(ahora);
  corte.setMonth(corte.getMonth() - MESES_DE_CAPTURAS);
  return corte;
}

// Suelta las imágenes que ya cumplieron su plazo. Devuelve cuántas.
//
// Es idempotente y se puede correr las veces que sea: el filtro exige que
// todavía haya imagen, así que una segunda pasada no encuentra nada. Por eso
// tampoco importa si dos instancias del backend lo corren a la vez.
export async function limpiarComprobantesViejos() {
  const corte = fechaDeCorte();

  const { count } = await prisma.paymentRequest.updateMany({
    where: {
      status: { in: ESTADOS_CERRADOS },
      proofImage: { not: null },
      proofAt: { lt: corte },
    },
    data: { proofImage: null, proofType: null },
  });

  if (count > 0) {
    // Queda constancia de que se borraron y de cuándo: si mañana alguien
    // pregunta por qué una solicitud aprobada ya no tiene su captura, la
    // respuesta está aquí y no en la memoria de nadie.
    await prisma.auditLog.create({
      data: {
        action: "PAYMENT_PROOFS_PURGED",
        entity: "PaymentRequest",
        metadata: { capturas: count, anterioresA: corte.toISOString(), meses: MESES_DE_CAPTURAS },
      },
    });
    console.log(`Limpieza: se soltaron ${count} capturas de pago anteriores a ${corte.toISOString()}`);
  }

  return count;
}

// Arranca la limpieza periódica. La llama server.js.
//
// Es un temporizador dentro del proceso y no un cron del sistema a propósito:
// no hay nada que configurar al desplegar y funciona igual en la compu de
// quien desarrolla. Si un día el backend corre en varias instancias, que lo
// hagan todas no es problema — la limpieza es idempotente.
export function iniciarLimpiezaPeriodica() {
  const correr = () => {
    limpiarComprobantesViejos().catch((e) =>
      // Que falle la limpieza no debe tumbar el backend: se reintenta al día
      // siguiente y mientras tanto lo único que pasa es que unas imágenes
      // siguen guardadas de más.
      console.error("Falló la limpieza de comprobantes:", e)
    );
  };

  setTimeout(() => {
    correr();
    // unref: el temporizador no debe ser la razón de que el proceso siga
    // vivo. El servidor HTTP ya se encarga de eso.
    setInterval(correr, CADA_MS).unref();
  }, PRIMERA_VEZ_MS).unref();
}
