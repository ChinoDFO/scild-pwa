// Manda un correo de prueba con la configuración de correo actual del .env,
// para comprobarla sin hacer un pedido de verdad:
//   npm run correo:probar -- tu@correo.com
import { enviarCorreo, modoCorreo } from "../src/correo.js";

const para = process.argv[2];
if (!para) {
  console.error("Uso: npm run correo:probar -- tu@correo.com");
  process.exit(1);
}

console.log(`Modo de correo: ${modoCorreo}`);

try {
  const resultado = await enviarCorreo({
    para,
    asunto: "Prueba de correo de SCILD",
    texto: "Si lees esto, el backend ya puede mandar correos.",
    html: "<p>Si lees esto, el backend ya puede mandar correos.</p>",
  });
  console.log(
    resultado.simulado
      ? "No se envió nada (modo simulado: falta configurar el correo en el .env)."
      : `Enviado a ${para}. Revisa la bandeja (y spam).`
  );
} catch (err) {
  console.error("Falló el envío:", err.message);
  // exitCode y no process.exit(): en Windows salir de golpe con una petición
  // cerrándose imprime un "Assertion failed" de libuv que asusta sin ser nada.
  process.exitCode = 1;
}
