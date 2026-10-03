// Relay de correo para el backend de SCILD: Google Apps Script.
//
// Por qué existe: Render (plan gratis) bloquea los puertos SMTP, así que el
// backend no puede hablar con Gmail directamente. En su lugar le pide a este
// script, por HTTPS, que mande el correo. Sale desde la cuenta de Gmail con la
// que se creó el script (buena entrega, nada de spam por mandar "de parte de").
//
// Cómo instalarlo (una sola vez), con la cuenta de Gmail que debe mandar:
//   1. script.google.com -> "Nuevo proyecto" -> borra lo que traiga y pega
//      todo este archivo.
//   2. Cambia TOKEN por un secreto largo (el mismo que irá en
//      CORREO_RELAY_TOKEN del backend). Se genera con:
//        node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
//   3. Implementar -> Nueva implementación -> engrane -> "Aplicación web":
//        Ejecutar como: Yo
//        Quién tiene acceso: Cualquier persona
//      -> Implementar -> Autorizar acceso (Google avisa que la app no está
//      verificada: "Avanzado" -> "Ir a ... (no seguro)" -> Permitir. Es tu
//      propio script).
//   4. Copia la "URL de la aplicación web" (termina en /exec): va en
//      CORREO_RELAY_URL del backend.
//
// Si cambias este código después, hay que publicar una versión nueva:
// Implementar -> Administrar implementaciones -> lápiz -> Versión: Nueva.
//
// Límite: ~100 destinatarios al día en una cuenta @gmail.com normal.

const TOKEN = "CAMBIA-ESTO-POR-UN-SECRETO-LARGO";

function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);

    if (datos.token !== TOKEN) {
      return responder({ ok: false, error: "no autorizado" });
    }
    if (!datos.para || !datos.asunto || !(datos.texto || datos.html)) {
      return responder({ ok: false, error: "faltan datos" });
    }

    MailApp.sendEmail({
      to: datos.para,
      subject: datos.asunto,
      body: datos.texto || "",
      htmlBody: datos.html || undefined,
      name: "SCILD",
    });
    return responder({ ok: true });
  } catch (err) {
    return responder({ ok: false, error: String(err) });
  }
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(
    ContentService.MimeType.JSON
  );
}
