import prisma from "./prisma.js";
import { TIPOS_DE_COMPROBANTE } from "./pagos.js";

// Las capturas de los pagos se guardan en la misma base de datos, en
// PaymentRequest.proofImage.
//
// Por qué aquí y no en un servicio de archivos: el proyecto ya tiene
// Postgres, y habilitar Firebase Storage obliga a mover el proyecto al plan
// de pago por uso. Un comprobante de celular pesa unos cientos de kilobytes
// y son unos pocos por cliente, así que no hay nada que optimizar todavía —
// si algún día son miles, esto se cambia por un bucket sin tocar el resto:
// la imagen entra y sale solo por estas funciones.
//
// La imagen NUNCA se manda en el JSON de las listas. El panel la pide aparte,
// con su sesión, a GET /api/admin/solicitudes/:id/comprobante: así no viaja
// en cada consulta ni queda en una URL que cualquiera pueda abrir. Un
// comprobante trae nombre, banco y monto de una persona.

export function extensionDe(contentType) {
  return TIPOS_DE_COMPROBANTE[contentType] ?? null;
}

// Guarda la captura de una solicitud y la deja lista para revisión.
export async function guardarComprobante({ requestId, contenido, contentType }) {
  if (!extensionDe(contentType)) {
    throw new Error(`Tipo de imagen no soportado: ${contentType}`);
  }

  await prisma.paymentRequest.update({
    where: { id: requestId },
    data: {
      proofImage: contenido,
      proofType: contentType,
      proofAt: new Date(),
      status: "EN_REVISION",
    },
  });
}

// Lee la captura para servírsela a un administrador. Es la ÚNICA consulta
// que trae los bytes: en cualquier otra se usa proofType para saber si hay
// comprobante sin cargar la imagen.
export async function leerComprobante(requestId) {
  const solicitud = await prisma.paymentRequest.findUnique({
    where: { id: requestId },
    select: { proofImage: true, proofType: true },
  });

  if (!solicitud?.proofImage || !solicitud.proofType) return null;

  // Buffer y no lo que venga: desde Prisma 6 un campo Bytes se lee como
  // Uint8Array, y res.send() de Express solo trata como binario a un Buffer
  // — con cualquier otro objeto lo serializaría a JSON y en vez de la imagen
  // llegaría {"0":137,"1":80,...}.
  return {
    contenido: Buffer.from(solicitud.proofImage),
    contentType: solicitud.proofType,
  };
}

// Suelta la imagen pero conserva la solicitud: sirve para dejar de guardar
// datos bancarios de alguien cuyo pago ya se resolvió, sin perder el
// historial de quién pidió qué y cuándo.
export async function borrarComprobante(requestId) {
  await prisma.paymentRequest.update({
    where: { id: requestId },
    data: { proofImage: null, proofType: null },
  });
}
