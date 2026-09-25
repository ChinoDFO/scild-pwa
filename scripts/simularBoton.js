// Simula un botón físico (ESP32) contra el backend, sin hardware.
//
// Hace exactamente lo que hace el firmware v8: manda heartbeats con su
// telemetría, aplica la configuración que le contesta el servidor y, si se le
// pide, dispara una alerta. Sirve para probar la cadena completa —botonazo →
// alerta en el grupo → push → pantalla de monitoreo— antes de tener el
// aparato en la mano, y para reproducir un problema de campo desde la compu.
//
// Uso:
//   npm run boton:simular -- --code BTN-PRUEBA-01 --secret <deviceSecret>
//   npm run boton:simular -- --code ... --secret ... --panic
//   npm run boton:simular -- --code ... --secret ... --cada 30
//
// Opciones:
//   --url     backend (por defecto http://localhost:3000)
//   --panic   dispara una alerta y sale
//   --cada N  se queda mandando heartbeat cada N segundos (como el aparato)
//   --rssi N  señal WiFi que reporta (por defecto -58)
//   --red     nombre de la red que reporta (por defecto "Simulador")

const args = process.argv.slice(2);

function opcion(nombre, porDefecto = null) {
  const i = args.indexOf(`--${nombre}`);
  if (i === -1) return porDefecto;
  const siguiente = args[i + 1];
  return siguiente && !siguiente.startsWith("--") ? siguiente : true;
}

const URL_BASE = opcion("url", "http://localhost:3000");
const deviceCode = opcion("code");
const deviceSecret = opcion("secret");
const rssi = Number(opcion("rssi", -58));
const redActiva = opcion("red", "Simulador");
const cada = opcion("cada");

if (!deviceCode || !deviceSecret) {
  console.error("Falta --code o --secret. Los trae PRUEBAS.md, o el script que creó el botón.");
  process.exit(1);
}

// El aparato guarda la versión de configuración que ya aplicó; mientras no
// cambie, el servidor contesta config:null.
let configVersion = 0;
let fallosInternet = 0;

async function llamar(ruta, cuerpo) {
  const respuesta = await fetch(`${URL_BASE}${ruta}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-code": deviceCode,
      "x-device-secret": deviceSecret,
    },
    body: JSON.stringify(cuerpo),
  });

  const datos = await respuesta.json().catch(() => null);
  return { status: respuesta.status, datos };
}

async function heartbeat() {
  const { status, datos } = await llamar("/api/devices/heartbeat", {
    firmwareVersion: "v8-sim",
    redActiva,
    ip: "192.168.1.77",
    rssi,
    fallosInternet,
    configVersion,
  });

  if (status !== 200) {
    console.error(`✗ Heartbeat HTTP ${status}:`, datos?.error ?? datos);
    if (status === 401) console.error("  El servidor no reconoce este botón. Revisa code/secret.");
    return;
  }

  console.log(`✓ Heartbeat (rssi ${rssi} dBm, red "${redActiva}")`);

  if (datos.config) {
    configVersion = datos.config.version;
    console.log("  ↓ Configuración nueva desde la app:");
    console.log(`    nombre     : ${datos.config.nombre}`);
    console.log(`    dirección  : ${datos.config.direccion || "(sin dirección)"}`);
    console.log(`    heartbeat  : ${datos.config.heartbeatSegundos}s`);
    console.log(`    cooldown   : ${datos.config.cooldownSegundos}s`);
    console.log(
      `    red respaldo: ${datos.config.ssidRespaldo || "(ninguna)"}` +
        (datos.config.passRespaldo ? " (con contraseña)" : "")
    );
  }
}

async function panic() {
  const { status, datos } = await llamar("/api/devices/panic", { firmwareVersion: "v8-sim" });

  if (status === 201) {
    console.log(`🚨 Alerta creada. id=${datos.alertId} (${datos.createdAt})`);
    return;
  }
  if (status === 200 && datos.repetida) {
    console.log(`↻ El servidor la tomó como reintento de ${datos.alertId}: no duplicó la alerta.`);
    return;
  }
  if (status === 409) {
    console.error("✗ Este botón no está vinculado a ningún grupo: no hay a quién avisarle.");
    return;
  }
  console.error(`✗ Alerta HTTP ${status}:`, datos?.error ?? datos);
}

if (opcion("panic")) {
  await panic();
} else if (cada) {
  const segundos = Number(cada);
  console.log(`Botón ${deviceCode} simulado contra ${URL_BASE}. Heartbeat cada ${segundos}s (Ctrl+C para parar).`);
  await heartbeat();
  setInterval(heartbeat, segundos * 1000);
} else {
  await heartbeat();
}
