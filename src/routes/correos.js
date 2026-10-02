import { Router } from "express";
import { obtenerDbPedidos } from "../firebasePedidos.js";
import { enviarCorreo, correoAdmin } from "../correo.js";
import {
  correoNuevoPedido,
  correoPedidoConfirmado,
  correoPedidoCancelado,
} from "../plantillasCorreo.js";

const router = Router();

const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VENTANA_NUEVO_MS = 15 * 60 * 1000;

function fallo(status, mensaje) {
  const err = new Error(mensaje);
  err.status = status;
  return err;
}

// Cada tipo sabe validar que el pedido REALMENTE está en el estado que el
// correo anuncia, a quién va y cómo se arma. El cliente solo manda el código
// del pedido: ni destinatario ni contenido vienen de la petición, así que
// este endpoint no sirve para mandar correos a terceros.
const TIPOS = {
  nuevo: {
    bandera: "correoNuevoEnviado",
    validar(pedido) {
      const creado = pedido.creadoEn?.toDate?.();
      if (!creado || Date.now() - creado.getTime() > VENTANA_NUEVO_MS) {
        throw fallo(409, "Ese pedido ya no es reciente");
      }
    },
    destinatario: () => correoAdmin,
    armar: (pedido) => correoNuevoPedido(pedido),
  },
  confirmado: {
    bandera: "correoConfirmadoEnviado",
    validar(pedido) {
      if (pedido.estado !== "confirmado" || !pedido.cancelableHasta?.toDate) {
        throw fallo(409, "El pedido no está confirmado");
      }
    },
    destinatario: (pedido) => pedido.correo,
    armar: (pedido) => correoPedidoConfirmado(pedido, pedido.cancelableHasta.toDate()),
  },
  cancelado: {
    bandera: "correoCanceladoEnviado",
    validar(pedido) {
      if (pedido.estado !== "cancelado") {
        throw fallo(409, "El pedido no está cancelado");
      }
    },
    destinatario: (pedido) => pedido.correo,
    armar: (pedido) => correoPedidoCancelado(pedido),
  },
};

router.post("/pedido", async (req, res) => {
  const { pedidoId, tipo } = req.body ?? {};

  if (typeof pedidoId !== "string" || !ID_VALIDO.test(pedidoId.trim())) {
    return res.status(400).json({ error: "Código de pedido inválido" });
  }
  const definicion = Object.hasOwn(TIPOS, tipo) ? TIPOS[tipo] : null;
  if (!definicion) {
    return res.status(400).json({ error: "Tipo de correo inválido" });
  }

  const referencia = obtenerDbPedidos().collection("Pedidos").doc(pedidoId.trim());

  // Se "reserva" el envío dentro de una transacción antes de mandarlo: si
  // llegan dos peticiones a la vez (doble clic, reintento), solo una pasa.
  const pedido = await referencia.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(referencia);
    if (!snap.exists) throw fallo(404, "Pedido no encontrado");

    const datos = snap.data();
    if (datos[definicion.bandera]) throw fallo(409, "Ese correo ya se envió");
    definicion.validar(datos);

    const para = definicion.destinatario(datos);
    if (typeof para !== "string" || !CORREO_VALIDO.test(para)) {
      throw fallo(422, "El pedido no tiene un correo válido");
    }

    tx.update(referencia, { [definicion.bandera]: true });
    return datos;
  });

  const para = definicion.destinatario(pedido);
  try {
    const resultado = await enviarCorreo({ para, ...definicion.armar(pedido) });
    res.json({ ok: true, simulado: resultado.simulado });
  } catch (err) {
    // No salió: se libera la reserva para que se pueda reintentar.
    await referencia.update({ [definicion.bandera]: false }).catch(() => {});
    console.error(`No se pudo enviar el correo "${tipo}" del pedido ${pedidoId}:`, err);
    throw fallo(502, "No se pudo enviar el correo");
  }
});

export default router;
