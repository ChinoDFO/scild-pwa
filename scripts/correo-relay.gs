// Relay de correo para el backend de SCILD: Google Apps Script.
//
// Por qué existe: Render (plan gratis) bloquea los puertos SMTP, así que el
// backend no puede hablar con Gmail directamente. En su lugar le pide a este
// script, por HTTPS, que mande el correo. Sale desde la cuenta de Gmail con la
// que se creó el script (buena entrega, nada de spam por mandar "de parte de").
//
// IMPORTANTE: este archivo se pega COMPLETO en el editor de Apps Script. Las
// variables CORREO_RELAY_URL y CORREO_RELAY_TOKEN NO van aquí: solo van en el
// .env del backend (y en Render). Aquí solo se cambia la línea de TOKEN.
//
// Cómo instalarlo (una sola vez), con la cuenta de Gmail que debe mandar:
//   1. script.google.com -> "Nuevo proyecto" -> borra TODO lo que traiga
//      (incluida "function myFunction") y pega todo este archivo.
//   2. Cambia TOKEN por un secreto largo, el mismo que irá en
//      CORREO_RELAY_TOKEN del backend. Se genera con:
//        node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
//      Usa un secreto nuevo que no hayas pegado en ningún chat ni correo.
//   3. Guarda (disquete) y, arriba, elige la función "autorizar" -> Ejecutar.
//      Google pide permisos: "Revisar permisos" -> tu cuenta -> "Avanzado" ->
//      "Ir a ... (no seguro)" -> Permitir. Es tu propio script. Debe terminar
//      sin error.
//   4. Implementar -> Nueva implementación -> engrane -> "Aplicación web":
//        Ejecutar como:        Yo
//        Quién tiene acceso:   Cualquier persona     <-- la que más se falla
//      -> Implementar. Copia la "URL de la aplicación web" (termina en /exec):
//      va en CORREO_RELAY_URL del backend.
//   5. Comprueba el acceso: abre esa URL /exec en una ventana de incógnito.
//      Debe decir "Relay de SCILD activo". Si te pide iniciar sesión,
//      "Quién tiene acceso" no está en "Cualquier persona".
//
// Si cambias este código después, hay que publicar una versión nueva:
// Implementar -> Administrar implementaciones -> lápiz -> Versión: Nueva
// versión -> Implementar. Si no, sigue corriendo el código anterior.
//
// Límite: ~100 destinatarios al día en una cuenta @gmail.com normal.

const TOKEN = "CAMBIA-ESTO-POR-UN-SECRETO-LARGO";

// Solo sirve para comprobar el acceso desde el navegador (paso 5). No revela
// nada ni manda nada.
function doGet() {
  return ContentService.createTextOutput("Relay de SCILD activo");
}

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

// Se ejecuta una vez a mano (paso 3) para que Google pida el permiso de mandar
// correos. No manda ninguno.
function autorizar() {
  Logger.log("Correos que aún se pueden mandar hoy: " + MailApp.getRemainingDailyQuota());
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(
    ContentService.MimeType.JSON
  );
}
