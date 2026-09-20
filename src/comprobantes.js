import { firebaseStorage } from "./firebaseAdmin.js";
import { TIPOS_DE_COMPROBANTE } from "./pagos.js";

// Las capturas de los pagos viven en Firebase Storage, no en Postgres ni en
// el disco del servidor: son archivos de medio mega que no tienen por qué
// pasar por la base, y el disco de la mayoría de los hosts es efímero (un
// redespliegue se los llevaría).
//
// El bucket NO es público. La PWA manda la imagen al backend y el backend la
// sube con la cuenta de servicio; los administradores la ven con un enlace
// firmado que caduca solo. Así un comprobante (que trae nombre, banco y
// monto de una persona) nunca queda accesible con solo adivinar la URL.

const CARPETA = "comprobantes";

// Cuánto dura el enlace que se le da al administrador para ver la captura.
const VIGENCIA_ENLACE_MS = 15 * 60 * 1000;

export function extensionDe(contentType) {
  return TIPOS_DE_COMPROBANTE[contentType] ?? null;
}

// Sube la captura y devuelve la ruta con la que se vuelve a encontrar.
export async function guardarComprobante({ requestId, contenido, contentType }) {
  const extension = extensionDe(contentType);
  if (!extension) {
    throw new Error(`Tipo de imagen no soportado: ${contentType}`);
  }

  // Una sola ruta por solicitud: no hay versiones ni historial que revisar,
  // y el modelo ya impide mandar una segunda captura.
  const ruta = `${CARPETA}/${requestId}.${extension}`;

  await firebaseStorage.bucket().file(ruta).save(contenido, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "private, max-age=0" },
  });

  return ruta;
}

// Enlace temporal para que un administrador vea la captura.
export async function enlaceDeComprobante(ruta) {
  if (!ruta) return null;

  try {
    const [url] = await firebaseStorage
      .bucket()
      .file(ruta)
      .getSignedUrl({ action: "read", expires: Date.now() + VIGENCIA_ENLACE_MS });
    return url;
  } catch (e) {
    // Que falle un enlace no debe tumbar toda la lista de solicitudes: el
    // administrador ve la fila, sin la imagen, y el error queda en el log.
    console.error(`No se pudo firmar el enlace del comprobante ${ruta}:`, e);
    return null;
  }
}

// Al borrar una solicitud aprobada o rechazada hace tiempo no queremos dejar
// comprobantes ahí para siempre. Best-effort: si falla, no pasa nada.
export async function borrarComprobante(ruta) {
  if (!ruta) return;
  try {
    await firebaseStorage.bucket().file(ruta).delete({ ignoreNotFound: true });
  } catch (e) {
    console.error(`No se pudo borrar el comprobante ${ruta}:`, e);
  }
}
