/*
 * =====================================================
 *   SCILD — BOTÓN DE PÁNICO (ESP32)
 *   v8 — habla con scild-backend en vez de ntfy/Firebase
 * =====================================================
 *
 * QUÉ CAMBIA RESPECTO A v7
 *
 *   v7 mandaba la alerta a ntfy.sh y su estado a Firebase Realtime
 *   Database. Eran dos servicios ajenos a la app: quien recibía el
 *   aviso no era el grupo de la app sino quien estuviera suscrito al
 *   canal de ntfy, y el monitoreo vivía en un dashboard aparte.
 *
 *   v8 habla con UN solo servidor, el de la app:
 *     - POST /api/devices/panic      → crea la alerta en el GRUPO al
 *       que está vinculado este botón. La app manda el push, prende la
 *       sirena y la pinta en el chat. El aparato ya no decide a quién
 *       avisarle: eso se decide en la app, al vincular el botón.
 *     - POST /api/devices/heartbeat  → reporta que sigue vivo y CÓMO
 *       está (red, IP, señal, fallos). Es lo que llena la pantalla de
 *       monitoreo del botón.
 *
 *   Y el heartbeat trae vuelta: el servidor contesta con la
 *   CONFIGURACIÓN que se guardó desde la app (nombre, cooldown, cada
 *   cuánto reportarse, red de respaldo). Por eso ya no hace falta ir
 *   hasta el aparato y abrir su portal para cambiar un ajuste.
 *
 * LO QUE NO CAMBIA
 *
 *   El portal de WiFiManager sigue existiendo y sigue siendo la PRIMERA
 *   configuración: mientras el botón no tenga internet no puede recibir
 *   nada del servidor, así que la red principal se captura ahí. Lo que
 *   se le quitó al portal es todo lo demás, que ahora se manda desde la
 *   app.
 *
 * IDENTIDAD DEL APARATO
 *
 *   El backend no conoce al botón por su MAC sino por el par
 *   deviceCode + deviceSecret (el mismo esquema que ya usa la API). El
 *   código va impreso en la caja; el secreto se graba de fábrica y no
 *   se vuelve a mostrar. Se pueden dejar en las constantes de abajo al
 *   flashear cada unidad, o capturarlos una vez en el portal: quedan
 *   guardados en Preferences.
 *
 * Librerías (Library Manager):
 *   - WiFiManager  by tzapu
 *   - HTTPClient   (incluida con el core de ESP32)
 *
 * Placa: ESP32 Dev Module
 *
 * PINES:
 *   GPIO13 → Botón de emergencia (otro extremo a GND)
 *   GPIO14 → LED VERDE (con resistencia 220Ω a GND)
 *   GPIO12 → LED ROJO  (con resistencia 220Ω a GND)
 * =====================================================
 */

#include <WiFiManager.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <time.h>

// ─────────────────────────────────────────────
//  SERVIDOR
// ─────────────────────────────────────────────
// La misma URL que usa la app (VITE_API_URL), sin la barra final.
const char* API_URL = "http://192.168.20.111:3000";

// Identidad de fábrica de ESTA unidad. Vive en `credenciales.h`, un archivo
// de esta misma carpeta que git NO sube: el secreto del botón no debe
// terminar en GitHub. Para preparar un botón nuevo se copia
// `credenciales.ejemplo.h` como `credenciales.h` y se llena.
//
// Si el archivo no está, esto compila igual y el botón queda sin credenciales
// de fábrica: las pide en su portal la primera vez que enciende. Así quien
// clone el proyecto no se topa con un error de compilación.
#if __has_include("credenciales.h")
#include "credenciales.h"
#endif

#ifndef SCILD_DEVICE_CODE
#define SCILD_DEVICE_CODE ""
#endif
#ifndef SCILD_DEVICE_SECRET
#define SCILD_DEVICE_SECRET ""
#endif

const char* DEVICE_CODE_FABRICA = SCILD_DEVICE_CODE;
const char* DEVICE_SECRET_FABRICA = SCILD_DEVICE_SECRET;

const char* FIRMWARE_VERSION = "v8";

// ─────────────────────────────────────────────
//  PINES
// ─────────────────────────────────────────────
const int PIN_BOTON = 13;
const int PIN_LED_VERDE = 14;
const int PIN_LED_ROJO = 12;

// ─────────────────────────────────────────────
//  ESTADO
// ─────────────────────────────────────────────
Preferences preferences;
WiFiMulti wifiMulti;

String deviceCode = "";
String deviceSecret = "";

// Ajustes que manda la app. Estos son los de arranque; se reemplazan con
// lo que conteste el servidor en el primer heartbeat.
String NOMBRE_NEGOCIO = "Negocio";
String DIRECCION = "Dirección";
unsigned long COOLDOWN = 10000;             // ms entre alertas
unsigned long INTERVALO_HEARTBEAT = 3000; // ms entre avisos de vida
long configVersion = 0;                     // versión aplicada, la da el servidor

unsigned long ultimaAlerta = 0;

unsigned long ultimoChequeoWifi = 0;
const unsigned long INTERVALO_WIFI = 3000;

bool botonPresionadoAntes = false;

unsigned long inicioSinWifi = 0;
const unsigned long TIEMPO_MAX_SIN_WIFI = 120000;

unsigned long ultimoChequeoInternet = 0;
const unsigned long INTERVALO_INTERNET = 30000;
bool internetDisponible = false;
int fallosInternet = 0;
const int MAX_FALLOS_INTERNET = 3;

unsigned long ultimoHeartbeat = 0;

String ssid1, pass1, ssid2, pass2;

// ─────────────────────────────────────────────
//  HTML DEL PORTAL PERSONALIZADO
// ─────────────────────────────────────────────
const char* PORTAL_CSS = R"(
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f0f2f5;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: white;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.10);
    padding: 32px 28px;
    width: 100%;
    max-width: 400px;
  }
  .header { text-align: center; margin-bottom: 28px; }
  .icon { font-size: 48px; margin-bottom: 10px; }
  .header h1 { font-size: 1.3rem; font-weight: 700; color: #1a1a1a; margin-bottom: 4px; }
  .header p { font-size: 0.85rem; color: #666; }
  .divider { border: none; border-top: 1px solid #eee; margin: 20px 0; }
  .section-label {
    font-size: 0.7rem; font-weight: 700; color: #c0392b;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 12px;
  }
  input[type="text"], input[type="password"] {
    width: 100%; padding: 12px 14px;
    border: 1.5px solid #e0e0e0; border-radius: 10px;
    font-size: 0.95rem; color: #1a1a1a; background: #fafafa;
    margin-bottom: 12px; outline: none; transition: border-color 0.2s;
  }
  input:focus { border-color: #c0392b; background: white; }
  input::placeholder { color: #bbb; }
  .btn {
    width: 100%; padding: 14px; background: #c0392b; color: white;
    border: none; border-radius: 10px; font-size: 1rem; font-weight: 600;
    cursor: pointer; margin-top: 8px; transition: background 0.2s;
  }
  .btn:active { background: #922b21; }
  .note {
    background: #fff8e1; border-left: 3px solid #f0c040;
    border-radius: 6px; padding: 10px 14px;
    font-size: 0.8rem; color: #555; margin-top: 20px; line-height: 1.5;
  }
  .footer { text-align: center; font-size: 0.75rem; color: #bbb; margin-top: 20px; }
</style>
)";

// ─────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== SCILD — BOTÓN DE PÁNICO v8 ===");

  pinMode(PIN_BOTON, INPUT_PULLUP);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_ROJO, OUTPUT);

  setLEDs(false);

  // ── Reset si el botón está presionado al encender ──
  Serial.println("Mantén presionado el botón para reconfigurar...");
  delay(3000);
  if (digitalRead(PIN_BOTON) == LOW) {
    Serial.println("¡Reset activado!");
    for (int i = 0; i < 6; i++) {
      digitalWrite(PIN_LED_ROJO, i % 2 == 0 ? HIGH : LOW);
      digitalWrite(PIN_LED_VERDE, i % 2 == 0 ? LOW : HIGH);
      delay(200);
    }
    WiFiManager wm;
    wm.resetSettings();
    preferences.begin("negocio", false);
    preferences.clear();
    preferences.end();
    Serial.println("Configuración borrada. Reiniciando...");
    delay(1000);
    ESP.restart();
  }

  cargarConfiguracion();

  // Intentar conectar directo con wifiMulti (ambas redes) antes de recurrir
  // al portal: si solo pasó que el router tardó en levantar tras un apagón,
  // abrir el portal nos dejaría sin poder mandar alertas.
  configurarWifiMulti();

  bool conectadoDirecto = false;
  if (ssid1.length() > 0) {
    Serial.println("Intentando conexión directa (wifiMulti)...");
    unsigned long inicioIntento = millis();
    while (wifiMulti.run(5000) != WL_CONNECTED && (millis() - inicioIntento) < 20000) {
      delay(500);
    }
    conectadoDirecto = (WiFi.status() == WL_CONNECTED);
  }

  if (!conectadoDirecto) {
    conectarWiFi();
    cargarConfiguracion();
    configurarWifiMulti();
  } else {
    Serial.print("✓ Conectado directo a: ");
    Serial.println(WiFi.SSID());
  }

  // ── Sincronizar hora por internet (NTP) ──
  Serial.println("Sincronizando hora...");
  configTime(-6 * 3600, 0, "pool.ntp.org", "time.google.com");  // UTC-6 = hora de México

  time_t ahoraCheck = 0;
  unsigned long inicioNTP = millis();
  const unsigned long TIMEOUT_NTP = 15000;

  while (ahoraCheck < 1577836800 && (millis() - inicioNTP) < TIMEOUT_NTP) {
    delay(300);
    time(&ahoraCheck);
  }

  if (ahoraCheck >= 1577836800) {
    Serial.println("✓ Hora sincronizada correctamente.");
  } else {
    Serial.println("⚠ No se pudo sincronizar la hora vía NTP.");
  }

  if (deviceCode.length() == 0 || deviceSecret.length() == 0) {
    Serial.println("✗ Este botón no tiene credenciales (deviceCode/deviceSecret).");
    Serial.println("  Grábalas en las constantes del sketch o captúralas en el portal.");
  }

  internetDisponible = hayInternet();
  setLEDs(internetDisponible);

  Serial.println("✓ Sistema listo.");
  Serial.print("  Servidor  : ");
  Serial.println(API_URL);
  // Solo el número de serie. El secreto no se imprime: el puerto serie se
  // comparte en capturas de pantalla y en reportes de fallas.
  Serial.print("  Botón     : ");
  Serial.println(deviceCode.length() > 0 ? deviceCode : "(sin credenciales)");
  Serial.print("  Secreto   : ");
  Serial.println(deviceSecret.length() > 0 ? "(guardado)" : "(falta)");
  Serial.print("  Negocio   : ");
  Serial.println(NOMBRE_NEGOCIO);
  Serial.print("  Dirección : ");
  Serial.println(DIRECCION);
  Serial.print("  Red 1     : ");
  Serial.println(ssid1);
  Serial.print("  Red 2     : ");
  Serial.println(ssid2.length() > 0 ? ssid2 : "(no configurada)");

  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED_VERDE, LOW);
    delay(150);
    digitalWrite(PIN_LED_VERDE, HIGH);
    delay(150);
  }

  // Primer heartbeat: reporta que arrancó y baja la configuración que la
  // app haya guardado mientras estuvo apagado.
  enviarHeartbeat();
}

// ─────────────────────────────────────────────
//  LOOP PRINCIPAL
// ─────────────────────────────────────────────
void loop() {
  unsigned long ahora = millis();

  // ── Revisar conexión WiFi cada 3 segundos ──
  if (ahora - ultimoChequeoWifi >= INTERVALO_WIFI) {
    ultimoChequeoWifi = ahora;

    if (WiFi.status() != WL_CONNECTED) {
      internetDisponible = false;
      setLEDs(false);

      if (inicioSinWifi == 0) {
        inicioSinWifi = ahora;
        Serial.println("⚠ WiFi perdido. Buscando red (primaria o de respaldo)...");
      }

      if (ahora - inicioSinWifi >= TIEMPO_MAX_SIN_WIFI) {
        Serial.println("⏱ Sin WiFi 2 min. Reiniciando...");
        delay(500);
        ESP.restart();
      }

      if (wifiMulti.run(5000) == WL_CONNECTED) {
        Serial.print("✓ Reconectado a: ");
        Serial.println(WiFi.SSID());
        inicioSinWifi = 0;
        fallosInternet = 0;
        internetDisponible = hayInternet();
        setLEDs(internetDisponible);
        if (internetDisponible) enviarHeartbeat();  // reportar la reconexión
      } else {
        unsigned long seg = (ahora - inicioSinWifi) / 1000;
        Serial.print("✗ Sin red. Tiempo: ");
        Serial.print(seg);
        Serial.println("s");
      }

    } else {
      inicioSinWifi = 0;

      if (ahora - ultimoChequeoInternet >= INTERVALO_INTERNET) {
        ultimoChequeoInternet = ahora;
        internetDisponible = hayInternet();

        if (internetDisponible) {
          if (fallosInternet > 0) {
            Serial.println("✓ Internet restaurado.");
            fallosInternet = 0;
            enviarHeartbeat();
          } else {
            Serial.println("✓ Internet disponible.");
          }
          setLEDs(true);
        } else {
          fallosInternet++;
          Serial.print("⚠ Sin internet. Fallo #");
          Serial.print(fallosInternet);
          Serial.print(" de ");
          Serial.println(MAX_FALLOS_INTERNET);

          if (fallosInternet >= MAX_FALLOS_INTERNET) {
            fallosInternet = 0;
            Serial.println("✗ 3 fallos seguidos. Intentando red de respaldo...");
            setLEDs(false);
            WiFi.disconnect();
            delay(500);
          }
        }
      }
    }
  }

  // ── Heartbeat periódico ──
  if (ahora - ultimoHeartbeat >= INTERVALO_HEARTBEAT) {
    ultimoHeartbeat = ahora;
    enviarHeartbeat();
  }

  // ── Detectar botón ──
  bool botonPresionado = (digitalRead(PIN_BOTON) == LOW);

  if (botonPresionado && !botonPresionadoAntes) {
    if (ahora - ultimaAlerta >= COOLDOWN) {
      ultimaAlerta = ahora;
      Serial.println("🚨 ¡Botón presionado! Enviando alerta...");
      enviarAlerta();
    } else {
      unsigned long restante = (COOLDOWN - (ahora - ultimaAlerta)) / 1000;
      Serial.print("⏳ Cooldown. Espera ");
      Serial.print(restante);
      Serial.println("s");
      parpadearLED(PIN_LED_ROJO, 2, 100);
    }
  }

  botonPresionadoAntes = botonPresionado;
  delay(50);
}

// ─────────────────────────────────────────────
//  REGISTRAR REDES EN WIFIMULTI
// ─────────────────────────────────────────────
void configurarWifiMulti() {
  if (ssid1.length() > 0) {
    wifiMulti.addAP(ssid1.c_str(), pass1.c_str());
    Serial.print("  wifiMulti: red primaria registrada -> ");
    Serial.println(ssid1);
  }
  if (ssid2.length() > 0) {
    wifiMulti.addAP(ssid2.c_str(), pass2.c_str());
    Serial.print("  wifiMulti: red de respaldo registrada -> ");
    Serial.println(ssid2);
  }
}

// ─────────────────────────────────────────────
//  VERIFICAR INTERNET REAL
// ─────────────────────────────────────────────
bool hayInternet() {
  WiFiClient cliente;
  HTTPClient http;
  http.begin(cliente, "http://clients3.google.com/generate_204");
  http.setTimeout(3000);
  int httpCode = http.GET();
  http.end();
  return (httpCode == 204);
}

// ─────────────────────────────────────────────
//  CONTROL DE LEDs
// ─────────────────────────────────────────────
void setLEDs(bool conectado) {
  digitalWrite(PIN_LED_VERDE, conectado ? HIGH : LOW);
  digitalWrite(PIN_LED_ROJO, conectado ? LOW : HIGH);
}

// ─────────────────────────────────────────────
//  LLAMADA AL BACKEND
// ─────────────────────────────────────────────
// Todas las peticiones van firmadas con el par deviceCode/deviceSecret en
// encabezados, que es lo que exige el backend (middleware deviceAuth). El
// secreto NUNCA va en la URL: quedaría escrito en los registros del servidor.
int llamarBackend(const String& ruta, const String& cuerpo, String& respuesta) {
  if (deviceCode.length() == 0 || deviceSecret.length() == 0) {
    Serial.println("✗ Sin credenciales del botón: no se puede hablar con el servidor.");
    return -1;
  }

  String url = String(API_URL) + ruta;
  bool esHttps = url.startsWith("https://");

  // En el ESP32 hay que darle el cliente a mano: con https, HTTPClient
  // necesita uno TLS o la llamada falla antes de salir del aparato.
  //
  // setInsecure() = no se valida el certificado del servidor. Lo correcto
  // sería fijar aquí el certificado raíz de la CA del backend, pero esos
  // certificados caducan y un botón instalado en una tienda no se
  // reflashea: hoy se prefiere una alerta que sale sin validar el
  // certificado a una que no sale. El secreto del aparato viaja igual
  // cifrado; lo que no se detecta es un servidor suplantado.
  WiFiClientSecure clienteSeguro;
  WiFiClient clientePlano;
  if (esHttps) clienteSeguro.setInsecure();

  HTTPClient http;
  bool listo = esHttps ? http.begin(clienteSeguro, url) : http.begin(clientePlano, url);
  if (!listo) {
    Serial.println("✗ No se pudo preparar la conexión con el servidor.");
    return -1;
  }

  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-code", deviceCode);
  http.addHeader("x-device-secret", deviceSecret);

  int httpCode = http.POST(cuerpo);
  respuesta = (httpCode > 0) ? http.getString() : "";
  http.end();
  return httpCode;
}

// Saca un valor de un JSON plano sin librería de parseo: el ESP32 tiene poca
// memoria y las respuestas del backend son cortas y de forma conocida.
// Devuelve "" si no está la llave.
String valorJson(const String& json, const String& llave) {
  int i = json.indexOf("\"" + llave + "\"");
  if (i < 0) return "";
  i = json.indexOf(':', i);
  if (i < 0) return "";
  i++;
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length()) return "";

  if (json[i] == '"') {
    int fin = json.indexOf('"', i + 1);
    if (fin < 0) return "";
    return json.substring(i + 1, fin);
  }

  int fin = i;
  while (fin < (int)json.length() && json[fin] != ',' && json[fin] != '}') fin++;
  String v = json.substring(i, fin);
  v.trim();
  return v;
}

// ─────────────────────────────────────────────
//  HEARTBEAT + CONFIGURACIÓN
// ─────────────────────────────────────────────
void enviarHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  String json = "{";
  json += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"redActiva\":\"" + WiFi.SSID() + "\",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"fallosInternet\":" + String(fallosInternet) + ",";
  // La versión que este aparato ya tiene aplicada. Si coincide con la del
  // servidor, contesta config:null y nos ahorramos el JSON entero.
  json += "\"configVersion\":" + String(configVersion);
  json += "}";

  String respuesta;
  int httpCode = llamarBackend("/api/devices/heartbeat", json, respuesta);

  if (httpCode == 200) {
    Serial.println("✓ Heartbeat enviado.");
    aplicarConfiguracion(respuesta);
  } else {
    Serial.print("✗ Error heartbeat HTTP: ");
    Serial.println(httpCode);
    if (httpCode == 401) {
      Serial.println("  El servidor no reconoce este botón: revisa deviceCode/deviceSecret.");
    }
  }
}

// Lo que la app configuró. Llega en la respuesta del heartbeat y se guarda en
// la memoria del aparato: así sigue vigente tras un reinicio aunque el
// servidor no esté disponible en ese momento.
void aplicarConfiguracion(const String& respuesta) {
  String version = valorJson(respuesta, "version");
  if (version.length() == 0) return;  // config:null → no hay nada nuevo

  long nueva = version.toInt();
  if (nueva == configVersion) return;

  String nombre = valorJson(respuesta, "nombre");
  String direccion = valorJson(respuesta, "direccion");
  long heartbeatSeg = valorJson(respuesta, "heartbeatSegundos").toInt();
  long cooldownSeg = valorJson(respuesta, "cooldownSegundos").toInt();
  String nuevoSsid2 = valorJson(respuesta, "ssidRespaldo");
  String nuevaPass2 = valorJson(respuesta, "passRespaldo");

  if (nombre.length() > 0) NOMBRE_NEGOCIO = nombre;
  if (direccion.length() > 0) DIRECCION = direccion;
  if (heartbeatSeg > 0) INTERVALO_HEARTBEAT = (unsigned long)heartbeatSeg * 1000UL;
  if (cooldownSeg > 0) COOLDOWN = (unsigned long)cooldownSeg * 1000UL;

  bool cambioLaRedDeRespaldo = (nuevoSsid2 != ssid2 || nuevaPass2 != pass2);
  ssid2 = nuevoSsid2;
  pass2 = nuevaPass2;
  configVersion = nueva;

  guardarConfiguracion(NOMBRE_NEGOCIO, DIRECCION, ssid1, pass1, ssid2, pass2);

  Serial.println("✓ Configuración actualizada desde la app:");
  Serial.print("  Negocio   : ");
  Serial.println(NOMBRE_NEGOCIO);
  Serial.print("  Heartbeat : ");
  Serial.print(INTERVALO_HEARTBEAT / 1000);
  Serial.println("s");
  Serial.print("  Cooldown  : ");
  Serial.print(COOLDOWN / 1000);
  Serial.println("s");
  Serial.print("  Red 2     : ");
  Serial.println(ssid2.length() > 0 ? ssid2 : "(sin red de respaldo)");

  // WiFiMulti no tiene forma de olvidar una red ya registrada: para que la
  // nueva de respaldo entre en juego hay que reiniciar. Solo se hace si de
  // verdad cambió.
  if (cambioLaRedDeRespaldo) {
    Serial.println("  La red de respaldo cambió: reiniciando para aplicarla...");
    delay(500);
    ESP.restart();
  }
}

// ─────────────────────────────────────────────
//  ENVIAR ALERTA AL BACKEND
// ─────────────────────────────────────────────
// El servidor decide a quién le llega: la alerta se crea en el grupo al que
// este botón está vinculado desde la app, y de ahí salen los push, la sirena
// y el aviso en el chat. Aquí solo se reporta el botonazo.
void enviarAlerta() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("✗ Sin WiFi. No se puede enviar la alerta.");
    parpadearLED(PIN_LED_ROJO, 5, 100);
    setLEDs(false);
    return;
  }

  String json = "{\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"}";

  // Hasta 5 intentos, pero solo mientras el servidor NO conteste: si
  // contestó, el botonazo ya quedó registrado y repetirlo sería avisar dos
  // veces de la misma emergencia. (El backend además ignora los reintentos
  // que caen dentro del cooldown, por si el acuse se perdió en el camino.)
  for (int i = 0; i < 5; i++) {
    String respuesta;
    int httpCode = llamarBackend("/api/devices/panic", json, respuesta);

    if (httpCode == 201 || httpCode == 200) {
      Serial.print("✓ Alerta registrada. id=");
      Serial.println(valorJson(respuesta, "alertId"));
      parpadearLED(PIN_LED_VERDE, 3, 100);
      setLEDs(true);
      return;
    }

    if (httpCode == 409) {
      // Botón sin grupo: no hay a quién avisarle. Reintentar no arregla nada.
      Serial.println("✗ Este botón no está vinculado a ningún grupo en la app.");
      parpadearLED(PIN_LED_ROJO, 5, 200);
      setLEDs(true);
      return;
    }

    if (httpCode == 401) {
      Serial.println("✗ El servidor no reconoce este botón (credenciales).");
      parpadearLED(PIN_LED_ROJO, 5, 200);
      setLEDs(true);
      return;
    }

    Serial.print("✗ Error alerta, intento ");
    Serial.print(i + 1);
    Serial.print(" de 5. HTTP: ");
    Serial.println(httpCode);
    parpadearLED(PIN_LED_ROJO, 2, 200);

    if (i < 4) delay(3000);
  }

  Serial.println("✗ No se pudo entregar la alerta después de 5 intentos.");
  setLEDs(internetDisponible);
}

// ─────────────────────────────────────────────
//  CONECTAR WIFI (WiFiManager) — solo cuando no hay credenciales
//  o wifiMulti no logró conectar en el intento directo
// ─────────────────────────────────────────────
// El portal ya NO pide nombre, dirección ni red de respaldo: eso se manda
// desde la app. Aquí queda lo único que no puede viajar por internet —la red
// principal, sin la cual el aparato no llega al servidor— y, si hace falta,
// la identidad del botón.
void conectarWiFi() {
  WiFiManager wm;
  wm.setCustomHeadElement(PORTAL_CSS);
  wm.setTitle("SCILD — Botón de pánico");

  wm.setConnectTimeout(30);
  wm.setConnectRetries(5);
  wm.setConfigPortalTimeout(180);

  // OJO con los nombres: el "código del botón" es su número de serie
  // (BTN-002), NO el código impreso en la caja —ese es otro, el que teclea el
  // cliente en la app para adueñarse del aparato—. Se distinguen a simple
  // vista: el de serie es corto, el secreto son 32 caracteres revueltos.
  WiFiManagerParameter param_code("code", "Numero de serie del boton (ej. BTN-002)", deviceCode.c_str(), 32);
  WiFiManagerParameter param_secret("secret", "Secreto del boton (32 caracteres)", "", 64);

  bool pideCredenciales = (deviceCode.length() == 0 || deviceSecret.length() == 0);
  if (pideCredenciales) {
    wm.addParameter(&param_code);
    wm.addParameter(&param_secret);
  }

  wm.setAPCallback([](WiFiManager* wm) {
    Serial.println("★ Portal activo — SCILD-CONFIG (se cierra solo en 3 min)");
    Serial.println("  Abre 192.168.4.1 en tu navegador");
  });

  bool seGuardaronParametros = false;
  wm.setSaveParamsCallback([&]() {
    seGuardaronParametros = true;
  });

  bool conectado = wm.autoConnect("SCILD-CONFIG");

  if (!conectado) {
    Serial.println("✗ No se pudo conectar. Reiniciando para reintentar...");
    parpadearLED(PIN_LED_ROJO, 5, 200);
    delay(1000);
    ESP.restart();
  }

  if (pideCredenciales && seGuardaronParametros) {
    guardarCredenciales(param_code.getValue(), param_secret.getValue());
  }

  // La red que acaba de funcionar pasa a ser la primaria. El resto de los
  // ajustes los trae el primer heartbeat.
  guardarConfiguracion(NOMBRE_NEGOCIO, DIRECCION, WiFi.SSID(), WiFi.psk(), ssid2, pass2);

  Serial.println("✓ WiFi conectado.");
  Serial.print("  Red activa: ");
  Serial.println(WiFi.SSID());
  Serial.print("  IP: ");
  Serial.println(WiFi.localIP());
}

// ─────────────────────────────────────────────
//  GUARDAR / CARGAR CONFIGURACIÓN
// ─────────────────────────────────────────────
void guardarConfiguracion(String nombre, String dir,
                          String s1, String p1,
                          String s2, String p2) {
  preferences.begin("negocio", false);
  preferences.putString("nombre", nombre);
  preferences.putString("dir", dir);
  preferences.putString("ssid1", s1);
  preferences.putString("pass1", p1);
  preferences.putString("ssid2", s2);
  preferences.putString("pass2", p2);
  preferences.putLong("cfgver", configVersion);
  preferences.putULong("hb", INTERVALO_HEARTBEAT);
  preferences.putULong("cd", COOLDOWN);
  preferences.end();
  Serial.println("✓ Configuración guardada.");
}

void guardarCredenciales(String code, String secret) {
  deviceCode = code;
  deviceSecret = secret;
  preferences.begin("negocio", false);
  preferences.putString("code", code);
  preferences.putString("secret", secret);
  preferences.end();
  Serial.println("✓ Credenciales del botón guardadas.");
}

void cargarConfiguracion() {
  preferences.begin("negocio", true);
  NOMBRE_NEGOCIO = preferences.getString("nombre", NOMBRE_NEGOCIO);
  DIRECCION = preferences.getString("dir", DIRECCION);
  ssid1 = preferences.getString("ssid1", "");
  pass1 = preferences.getString("pass1", "");
  ssid2 = preferences.getString("ssid2", "");
  pass2 = preferences.getString("pass2", "");
  configVersion = preferences.getLong("cfgver", 0);
  INTERVALO_HEARTBEAT = preferences.getULong("hb", INTERVALO_HEARTBEAT);
  COOLDOWN = preferences.getULong("cd", COOLDOWN);

  // Lo grabado de fábrica MANDA sobre lo que haya guardado el portal. Es lo
  // que uno espera al flashear una unidad con sus credenciales dentro, y
  // además es la salida cuando alguien se equivocó al capturarlas: se
  // corrigen en el sketch y se vuelve a cargar, sin tener que borrar el
  // aparato entero. Si las constantes van vacías (lo normal cuando se usa el
  // portal), se usa lo guardado.
  if (strlen(DEVICE_CODE_FABRICA) > 0 && strlen(DEVICE_SECRET_FABRICA) > 0) {
    deviceCode = String(DEVICE_CODE_FABRICA);
    deviceSecret = String(DEVICE_SECRET_FABRICA);
  } else {
    deviceCode = preferences.getString("code", "");
    deviceSecret = preferences.getString("secret", "");
  }
  preferences.end();
}

// ─────────────────────────────────────────────
//  PARPADEAR LED
// ─────────────────────────────────────────────
void parpadearLED(int pin, int veces, int intervalo) {
  for (int i = 0; i < veces; i++) {
    digitalWrite(pin, HIGH);
    delay(intervalo);
    digitalWrite(pin, LOW);
    delay(intervalo);
  }
}
