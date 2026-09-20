// Todo lo que define el trámite de ampliar el límite: qué se cobra, a qué
// cuenta se deposita y qué puede decir el cliente en el chat.
//
// El cliente NO escribe texto libre. Manda mensajes de un catálogo cerrado y
// el backend resuelve el texto: así el hilo es predecible, no hay nada que
// moderar, y nadie escribe un número de tarjeta en un chat que no es para
// eso. Soporte sí escribe libre — del otro lado estamos nosotros.

import { ACCESOS_POR_COMPRA } from "./acceso.js";

// Datos bancarios y precio. Van en el .env y no en el código para poder
// cambiarlos sin volver a desplegar, y para no dejarlos en el repositorio.
export function datosDePago() {
  return {
    banco: process.env.PAGO_BANCO || "(falta PAGO_BANCO en el .env)",
    clabe: process.env.PAGO_CLABE || "(falta PAGO_CLABE en el .env)",
    titular: process.env.PAGO_TITULAR || "(falta PAGO_TITULAR en el .env)",
    monto: process.env.PAGO_MONTO || "(falta PAGO_MONTO en el .env)",
    contacto: process.env.PAGO_CONTACTO || "",
    accesos: ACCESOS_POR_COMPRA,
  };
}

// El primer mensaje del hilo: qué cuesta, a dónde se deposita y qué sigue.
export function mensajeDeBienvenida() {
  const { banco, clabe, titular, monto, accesos } = datosDePago();
  return [
    `Para que otras ${accesos} personas de tu grupo puedan enviar alertas, el costo es ${monto}.`,
    "",
    `Banco: ${banco}`,
    `CLABE: ${clabe}`,
    `A nombre de: ${titular}`,
    "",
    'Cuando hayas hecho la transferencia, toca "Ya pagué" y te pedimos la captura.',
  ].join("\n");
}

// Lo único que el cliente puede mandar.
export const MENSAJES_CLIENTE = [
  { id: "YA_PAGUE", texto: "Ya pagué." },
  { id: "NO_ME_DEJA", texto: "No me deja hacer el pago." },
  { id: "CUANTO_TARDA", texto: "¿Cuánto tarda en activarse?" },
  { id: "CANCELAR", texto: "Quiero cancelar la solicitud." },
];

const PORID = new Map(MENSAJES_CLIENTE.map((m) => [m.id, m]));

export function mensajeDelCatalogo(id) {
  return PORID.get(id) ?? null;
}

// Respuesta automática a cada uno. Null = no se contesta solo (lo atiende
// una persona desde la lista de administradores).
export function respuestaAutomatica(id) {
  const { contacto } = datosDePago();

  switch (id) {
    case "YA_PAGUE":
      return [
        "Gracias. Mándanos la captura del comprobante para revisarlo.",
        "Solo se puede enviar una por solicitud, así que revisa antes que se vean el monto y la fecha.",
      ].join(" ");
    case "CUANTO_TARDA":
      return "Revisamos los comprobantes en horario de oficina. En cuanto confirmemos el depósito se activan tus accesos y te aparecen en el apartado de Códigos.";
    case "NO_ME_DEJA":
      return contacto
        ? `Escríbenos a ${contacto} y lo resolvemos contigo.`
        : "En un momento te atiende una persona del equipo.";
    default:
      return null;
  }
}

// Estados en los que el cliente todavía puede participar en el hilo.
export const ESTADOS_ABIERTOS = ["ABIERTA", "EN_REVISION"];

// Tipos de imagen que se aceptan como comprobante, y su extensión.
export const TIPOS_DE_COMPROBANTE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// 5 MB: una captura de celular pesa mucho menos, y el tope evita que alguien
// use el endpoint para subir cualquier cosa.
export const MAX_COMPROBANTE = 5 * 1024 * 1024;
