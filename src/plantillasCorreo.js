// Textos de los tres correos de la tienda. Los datos del pedido los escribió
// el cliente, así que todo lo que va al HTML se escapa.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (valor) => String(valor ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

function formatearFecha(fecha) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Mexico_City",
  }).format(fecha);
}

function envolver(titulo, filas, pie) {
  const lista = filas
    .map(([etiqueta, valor]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(etiqueta)}</td><td style="padding:4px 0"><strong>${esc(valor)}</strong></td></tr>`)
    .join("");
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111">
<h2 style="margin:0 0 16px">${esc(titulo)}</h2>
<table style="border-collapse:collapse;font-size:15px">${lista}</table>
${pie ? `<p style="margin-top:20px;color:#444;font-size:14px">${esc(pie)}</p>` : ""}
<p style="margin-top:24px;color:#999;font-size:12px">SCILD</p>
</div>`;
}

function textoPlano(titulo, filas, pie) {
  return [titulo, "", ...filas.map(([e, v]) => `${e}: ${v}`), ...(pie ? ["", pie] : [])].join("\n");
}

export function correoNuevoPedido(pedido) {
  const titulo = `Nuevo pedido #${pedido.numeroPedido}`;
  const filas = [
    ["Versión", pedido.versionNombre],
    ["Nombre", pedido.nombre],
    ["Correo", pedido.correo],
    ["Teléfono", pedido.telefono],
    ["Domicilio", pedido.domicilio],
    ["Indicaciones", pedido.indicaciones || "(sin indicaciones)"],
    ["Código de entrega", pedido.codigoEntrega],
  ];
  return { asunto: titulo, texto: textoPlano(titulo, filas), html: envolver(titulo, filas) };
}

export function correoPedidoConfirmado(pedido, cancelableHasta) {
  const titulo = `Tu pedido #${pedido.numeroPedido} fue confirmado`;
  const filas = [
    ["Versión", pedido.versionNombre],
    ["Cancelable hasta", formatearFecha(cancelableHasta)],
  ];
  const pie = `Hola ${pedido.nombre}, ya confirmamos tu pedido. Si necesitas cancelarlo, puedes hacerlo desde nuestra página (sección "Cancelar pedido") antes de la fecha indicada.`;
  return { asunto: titulo, texto: textoPlano(titulo, filas, pie), html: envolver(titulo, filas, pie) };
}

export function correoPedidoCancelado(pedido) {
  const titulo = `Tu pedido #${pedido.numeroPedido} fue cancelado`;
  const pie = `Hola ${pedido.nombre}, tu pedido quedó cancelado. Si fue un error, puedes hacer uno nuevo desde nuestra página cuando quieras.`;
  return { asunto: titulo, texto: textoPlano(titulo, [], pie), html: envolver(titulo, [], pie) };
}
