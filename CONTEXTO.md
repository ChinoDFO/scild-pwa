# Sistema de botón de emergencia — contexto del proyecto

Este documento resume en qué va el proyecto para que cualquiera que se sume
pueda entender las decisiones tomadas y seguir desde donde se quedó, sin
tener que reconstruir el hilo de conversación completo.

## 1. Qué es esto

Una plataforma para gestionar botones físicos de emergencia (ESP32)
instalados en comercios/establecimientos pequeños. Cuando alguien presiona
el botón, el dispositivo avisa al backend, y el backend notifica a los
usuarios del establecimiento correspondiente. La app también permite ver el
estado de los botones, generar una alerta manualmente, chatear entre
integrantes del grupo, y consultar la ubicación del establecimiento.

Arquitectura general: **ESP32 → Backend → PWA**. El ESP32 nunca habla
directo con los usuarios; todo pasa por el backend.

## 2. Decisiones de arquitectura ya tomadas (y por qué)

- **Es un proyecto separado de `scild-web`.** `scild-web` es la tienda
  donde se pide el botón (React + Vite + Firestore + EmailJS) y **se queda
  tal cual está, sin login para hacer un pedido**. Este sistema de
  emergencia es un producto aparte: login, grupos, dispositivos, alertas.
  Único punto de contacto entre ambos: en `scild-web`, junto a "Gestionar
  pedidos", va una opción nueva que lleva a un tutorial de instalación de
  esta PWA (pendiente de hacer).
- **Base de datos: PostgreSQL + Prisma**, no Firestore, aunque el resto del
  ecosistema del usuario es Firebase. Se decidió así para tener consultas
  relacionales y migraciones versionadas de verdad (grupos, membresías,
  alertas, auditoría). La base real vive en [Neon](https://neon.tech)
  (Postgres serverless gratis).
- **Autenticación: Firebase Authentication**, pero en un **proyecto de
  Firebase dedicado y separado** llamado `scild-emergencia` — distinto del
  proyecto que usa `scild-web` — para no mezclar usuarios de la tienda con
  usuarios del sistema de emergencia. El backend nunca maneja contraseñas:
  solo verifica el ID token que genera el cliente con el SDK de Firebase.
- **El backend es Node/Express**, separado del frontend, pensado para que
  después puedan colgarse apps móviles nativas sin tocar la lógica central
  (por ahora fuera de alcance, solo PWA).
- **Device Secret nunca se guarda ni compara en texto plano**: se guarda su
  hash (bcrypt). El ESP32 nunca puede generar una alerta solo con su ID
  público — necesita el secreto real.
- **Un botón existe antes de tener dueño.** Se da de alta al prepararlo
  (sin grupo) con dos códigos: el `deviceSecret`, que va dentro del ESP32,
  y el **código de vinculación impreso en la caja**, con el que su dueño lo
  liga a su grupo desde la app sin que nosotros toquemos nada. El código de
  la caja **no cambia** al desvincular (el papel tiene que seguir
  sirviendo); lo que dice si está libre u ocupado es `Device.claimedAt`.
- **Tiempo real con Socket.IO, pero solo de bajada.** El socket únicamente
  *avisa* a la PWA (mensaje nuevo, alerta nueva o cambiada, grupo editado).
  Todo lo que el usuario *hace* sigue yendo por la API HTTP, donde están la
  validación, los permisos y el rate limiting: un solo camino que mantener.
- **El push del chat es distinto al de una emergencia**, para que nadie
  silencie la app y se pierda una alerta de verdad: los mensajes se agrupan
  por grupo (el aviso nuevo reemplaza al anterior), se descartan solos, no
  se le mandan a quien ya trae esa conversación abierta en pantalla, y si
  hay varios sin leer se resumen en "N mensajes nuevos" en vez de sonar uno
  por uno. La alerta, en cambio, se queda fija hasta que la toques.
- **Catálogo de tipos de alerta en el backend** (`src/tiposAlerta.js`), no
  como enum de Prisma: agregar o quitar opciones no requiere migración y la
  PWA arma su menú pidiéndolo a la API.

## 3. Repos

| Proyecto | Qué es | Dónde vive | GitHub |
|---|---|---|---|
| `scild-web` | Tienda/pedidos (sin tocar) | `PP/scild-web` | https://github.com/ChinoDFO/SCILD-web |
| `scild-backend` | Backend del sistema de emergencia (este repo) | `PP/scild-backend` | https://github.com/ChinoDFO/scild-pwa |
| `scild-emergencia` | Frontend del sistema de emergencia (PWA instalable) | `PP/scild-emergencia` | https://github.com/ChinoDFO/scild-emergencia |

## 4. Qué ya funciona (implementado y probado)

**Hito (2026-09-17): el flujo central funciona de punta a punta.** Una alerta
creada en el backend llegó como notificación push real a la PWA en Chrome
(Windows), con la app abierta y con la app cerrada. Para el flujo completo
faltan el ESP32 físico real y tener todo publicado con HTTPS (ver roadmap).

### Backend (`scild-backend`)

- **Base de datos** migrada en Neon con 11 tablas: `User`, `Group`,
  `GroupMember`, `Device`, `DeviceEvent`, `DeviceConfiguration`, `Alert`,
  `Notification`, `PushToken`, `Message`, `AuditLog`. Ver
  `prisma/schema.prisma`.
- **Endpoints del ESP32** (autenticados con headers `x-device-code` /
  `x-device-secret`, comparados contra el hash guardado):
  - `POST /api/devices/heartbeat` — reporta que sigue vivo, actualiza
    batería/firmware/última conexión.
  - `POST /api/devices/panic` — crea una `Alert`, pone el dispositivo en
    `EMERGENCY`, devuelve el id de la alerta creada. Un botón sin vincular
    responde 409: no tiene a quién avisarle (el heartbeat sí funciona, para
    poder probarlo antes de venderlo).
  - `POST /api/devices/status` — reporta estado (`ONLINE`/`MAINTENANCE`
    solamente; `EMERGENCY` solo lo dispara `/panic`, nunca el propio
    dispositivo).
- **Endpoints de usuario** (autenticados con `Authorization: Bearer
  <idToken>` de Firebase):
  - `GET /api/auth/me` — perfil + grupos del usuario (se autocrea en
    Postgres la primera vez que llega un token válido). Cada grupo trae
    `sinLeer`: cuántos mensajes del chat no ha visto.
  - `PATCH /api/auth/me` `{ displayName }` — el **apodo** con el que los
    demás ven a la persona ("Mamá", "Cajero"); máx. 40 caracteres. Sale en
    el chat, en la lista de miembros y en el push de sus alertas.
  - `POST /api/groups` — crea un grupo/establecimiento, el creador queda
    como `ADMIN`. **Nombre y dirección son obligatorios** (la dirección es
    lo que se necesita para llegar en una emergencia). La columna sigue
    siendo opcional en la base porque hay grupos viejos sin dirección; la
    app le pide al admin que la agregue.
  - `PATCH /api/groups/:id` — solo ADMIN (403 si eres miembro, 404 si no
    eres del grupo): edita nombre, dirección y coordenadas. No deja la
    dirección vacía. Queda en `AuditLog`.
  - `POST /api/groups/:id/invite-code` — solo ADMIN: genera un código de
    invitación nuevo y el anterior deja de servir.
  - `PATCH /api/groups/:id/members/:userId` `{ role }` — solo ADMIN: nombra
    o quita administradores. Nunca deja al grupo sin ninguno (409).
  - `DELETE /api/groups/:id/members/me` — salir del grupo. Bloquea (409) al
    único ADMIN si quedan más personas (primero nombra a otro), y si es el
    último miembro borra el grupo vacío con él, salvo que tenga botones
    vinculados.
  - `DELETE /api/groups/:id` — solo ADMIN, y pide el nombre del grupo
    escrito igual en `confirmarNombre`. Se niega (409) si el grupo tiene
    botones vinculados: el ESP32 se quedaría sin a quién avisar y su
    secreto no se puede recuperar (falta "desvincular botón" en el
    roadmap).
  - `POST /api/groups/:id/devices/claim` `{ claimCode, name? }` — vincula
    un botón al grupo con el código de su caja. Lo puede hacer **cualquier
    miembro** (en un coto, cada vecino vincula el suyo) y queda como su
    dueño. 409 si ya estaba vinculado, y el mismo 404 exista o no el
    código, para que nadie ande adivinando códigos.
  - `DELETE /api/groups/:id/devices/:deviceId` — desvincular. Solo su dueño
    o el ADMIN del grupo. El botón queda libre y se puede volver a vincular
    con el mismo código, aquí o en otro grupo.
  - `POST /api/groups/:id/read` — marca el chat como leído hasta ahora.
    Pone en cero el contador de `GET /api/auth/me` y hace que el siguiente
    aviso push traiga el mensaje en vez de "N mensajes nuevos".
  - `GET /api/groups/:id/messages` (`?antesDe=<fecha ISO>` para paginar de
    50 en 50) y `POST /api/groups/:id/messages` `{ content }` — **chat del
    grupo** (máx. 1000 caracteres). Cada mensaje nuevo se reparte al
    instante por Socket.IO.
  - `POST /api/groups/join` — se une a un grupo con `inviteCode` (404 si
    no existe, 409 si ya es miembro).
  - `POST /api/notifications/token` — registra el token de FCM del
    navegador actual (se reasigna si ya existía bajo otra cuenta).
  - `DELETE /api/notifications/token` — lo borra al cerrar sesión.
  - `GET /api/groups/:id` — detalle: miembros, botones con estado
    **derivado** (`OFFLINE` si lleva >3× `heartbeatInterval` sin señal,
    `IRREGULAR` si >1.5×) y `inviteCode` solo si eres ADMIN.
  - `GET /api/alerts/tipos` — catálogo de tipos de alerta (🚨 Emergencia,
    🚗 Carro sospechoso, 👤 Personas sospechosas, 🚔 Robo o asalto,
    🔥 Incendio, 🚑 Emergencia médica). Se edita en `src/tiposAlerta.js`;
    `GENERAL` debe existir siempre (es el del botón físico).
  - `GET /api/alerts` (`?groupId=`, `?soloAbiertas=true`) — alertas de tus
    grupos; es la fuente de verdad para quien no tiene push. Cada alerta
    trae `tipo: { id, etiqueta, emoji }` ya resuelto.
  - `POST /api/alerts` `{ groupId, type }` — alerta manual (`source: APP`)
    del tipo elegido (`GENERAL` si no viene; 400 si no existe en el
    catálogo; **403 si la cuenta no es completa**, ver "Acceso"). Avisa a todos los miembros menos a quien la generó. El push
    dice qué pasa: título "🚗 Carro sospechoso", cuerpo "Mamá reportó carro
    sospechoso en Casa Flores".
  - `POST /api/alerts/:id/atender` y `/resolver` — ACTIVE → ACKNOWLEDGED →
    RESOLVED, a prueba de doble clic simultáneo (409). Resolver la última
    alerta abierta de un botón lo saca de `EMERGENCY` (antes nada lo hacía:
    el heartbeat conserva ese estado). Quién hizo qué queda en `AuditLog`.
- **Acceso de la cuenta (`src/acceso.js`) y cupos (`src/cupos.js`)** — el
  sistema de discriminación entre quien tiene botón y quien no:
  - Una cuenta es **completa** (puede disparar alertas) si es **titular**
    de un botón o si un titular le regaló uno de los accesos que compró.
    Cualquier otra es **invitada**: lee y escribe en el chat de sus grupos,
    pero no dispara alertas de ningún tipo.
  - El permiso vive en la **cuenta, no en el grupo**: se tiene en todos sus
    grupos o en ninguno. Es lo que hace funcionar el caso comunitario (en
    un coto con varios botones cada quien avisa de lo suyo y todos se
    enteran) sin que un vecino tenga que habilitar a otro a mano.
  - **Dos titulares por botón**: el `claimCode` impreso en la caja se
    valida **dos veces** (`DeviceHolder`, tope en `TITULARES_POR_BOTON`).
    Un botón es de la casa, no de una persona. El tope se comprueba
    *después* de insertar, dentro de la transacción: contar antes deja
    pasar dos códigos simultáneos, y no hay índice que exprese "máximo dos
    filas por deviceId".
  - **Cupos**: cada botón vinculado da lugar para **10 personas** en el
    grupo (`LUGARES_POR_BOTON`). `GroupMember.seatDeviceId` dice de qué
    botón sale cada lugar; `POST /api/groups/join` responde 409 cuando ya
    no hay. Para crecer, alguien más tiene que unirse con su botón.
    El lugar se le carga al botón con espacio más antiguo, no a quien
    invitó: el código de invitación es uno solo por grupo y no dice quién
    lo compartió. Al desvincular un botón sus miembros **no** salen del
    grupo, se quedan "sin respaldo" hasta que entre otro botón.
  - **Accesos comprados**: `Device.extraAccesses` son lugares completos que
    el titular reparte entre los invitados de su grupo (`AccessGrant`,
    `ACCESOS_POR_COMPRA = 5`). De fábrica es 0: 2 titulares + 8 invitados.
    Con una compra: 2 + 5 completos + 3 invitados = los 7 del plan. Lo
    mueve un administrador de la plataforma al confirmar el pago
    (**pendiente**, ver roadmap).
  - Endpoints en `src/routes/acceso.js`: `GET /api/acceso` (lo que pinta el
    apartado de Códigos), `POST /api/acceso/vincular` `{ claimCode }`,
    `POST` y `DELETE /api/acceso/otorgar` `{ deviceId, userId }`.
  - `POST /api/groups/:id/devices/claim` acepta `claimCode` (te vuelve
    titular **y** vincula el botón al grupo) o `deviceId` (traes al grupo
    un botón del que ya eres titular). Solo un titular puede vincularlo:
    es decidir a quién le avisa.
- **Ampliar el límite: pago y panel (`src/pagos.js`, `src/comprobantes.js`,
  `src/routes/pagos.js`, `src/routes/admin.js`)** — el cliente deposita por
  transferencia y un administrador de la plataforma lo confirma a mano:
  - `PaymentRequest` es **una fila por intento**, no una por cliente, y cada
    una admite **una sola captura**. Si un comprobante se rechaza (borroso,
    monto que no cuadra), el cliente abre otra solicitud y manda una nueva.
    Con "una captura por cuenta" un error de foto dejaría a alguien que ya
    pagó sin forma de comprobarlo.
  - El cliente **no escribe texto libre**: manda mensajes de un catálogo
    cerrado (`MENSAJES_CLIENTE`) y el backend resuelve el texto y la
    respuesta automática. Soporte sí escribe libre. Así el hilo es
    predecible, no hay nada que moderar y nadie acaba escribiendo datos de
    su tarjeta donde no van.
  - Las **capturas viven en la propia base** (`PaymentRequest.proofImage`,
    `Bytes`). Se intentó Firebase Storage primero, pero habilitarlo obliga a
    mover el proyecto de Firebase al plan de pago por uso; el proyecto ya
    tiene Postgres y un comprobante de celular pesa unos cientos de
    kilobytes, así que no hay nada que optimizar todavía. Si algún día son
    miles, se cambia por un bucket sin tocar el resto: la imagen entra y
    sale solo por `src/comprobantes.js`.
  - La PWA manda la imagen **cruda** (`express.raw`, sin multipart ni
    dependencia nueva). La imagen **nunca** viaja en el JSON de las listas:
    esas consultas seleccionan `proofType`, que basta para saber si ya hay
    captura. El panel la pide aparte a
    `GET /api/admin/solicitudes/:id/comprobante`, con su sesión, y la pinta
    como blob — un `<img src>` directo no serviría porque el navegador no
    manda la cabecera `Authorization` al cargar una imagen, y un comprobante
    trae nombre, banco y monto de una persona.
  - `leerComprobante` devuelve un **Buffer** a propósito: desde Prisma 6 un
    campo `Bytes` se lee como `Uint8Array`, y `res.send()` de Express solo
    trata como binario a un Buffer — con cualquier otro objeto serializaría
    la imagen a JSON.
  - **Las capturas se sueltan solas a los 3 meses** (`src/limpieza.js`): un
    comprobante trae nombre, banco y monto de una persona, y una vez cerrado
    el trámite no hay razón para seguirlo guardando. Se borra la imagen pero
    **se conserva la solicitud**, así que el historial de quién pidió qué y
    en qué acabó sigue completo, y queda un `AuditLog` de cada barrido. Una
    solicitud todavía abierta conserva su captura aunque tenga meses: le
    falta que alguien la revise. Corre como temporizador dentro del proceso
    (diario, arranca a los 5 min de encender) y no como cron del sistema:
    nada que configurar al desplegar, y es idempotente, así que no importa
    si lo corren varias instancias. A mano: `npm run comprobantes:limpiar`.
  - Requiere los `PAGO_*` del `.env` (banco, CLABE, titular, monto).
  - `POST /api/admin/solicitudes/:id/aprobar` es lo **único** que sube
    `Device.extraAccesses` (con `updateMany` sobre el estado esperado: dos
    administradores aprobando a la vez suman una sola vez). Hay también
    `/rechazar` con motivo, `/mensajes` y `POST /api/admin/clientes/:id/accesos`
    para ampliar a mano un caso raro. Todo queda en `AuditLog`.
  - `User.isPlatformAdmin` se prende **a mano en la base**. No hay endpoint
    que lo otorgue a propósito: sería el camino más corto para que una
    cuenta comprometida se regale todo.
- **Tiempo real (`src/realtime.js`, Socket.IO en el mismo puerto que la
  API)**: el socket se autentica con el mismo ID token de Firebase y entra
  solo a las salas de los grupos del usuario (nadie escucha un grupo
  ajeno). Eventos: `mensaje:nuevo`, `alertas:cambio` (alerta creada por
  la app o por el botón, atendida o resuelta) y `grupo:actualizado`.
  Si la PWA se une a un grupo después de conectarse, pide la sala con
  `grupo:entrar` (se verifica la membresía).
  - Los handlers se registran **antes** de cualquier `await` en la
    conexión: un evento que llega sin handler se pierde sin aviso (pasó
    con `grupo:entrar`, lo detectó la prueba end-to-end).
  - Igual que Express 4, Socket.IO no atrapa promesas rechazadas: cada
    handler async tiene su try/catch para no tumbar el proceso.
  - `grupo:viendo` le dice al backend qué conversación trae abierta cada
    quien, y `estaViendoGrupo()` lo usa para no mandarle push de chat a
    quien ya la está leyendo. `grupo:eliminado` saca de la pantalla a los
    demás miembros cuando el grupo desaparece.
- **Express 5**: con Express 4 cualquier error en una ruta async (p. ej.
  Neon tardando en despertar) tumbaba el proceso entero, incluido `/panic`.
  Ahora hay un manejador de errores que responde JSON y el servidor sigue.
- **Notificaciones push (FCM)**, en `src/push.js`:
  - `/panic` crea la `Alert` y, en la **misma transacción**, una
    `Notification` PENDING por cada miembro del grupo. Así queda registro
    de a quién había que avisar aunque FCM falle.
  - El envío ocurre **después** de responderle al ESP32 (corre con batería
    y timeout corto, no puede esperar a FCM). Cada `Notification` pasa a
    `SENT` o `FAILED`; basta que uno de los navegadores del usuario reciba
    el aviso para contarla como enviada.
  - Los tokens que FCM reporta como muertos (app desinstalada, permiso
    revocado, token rotado) se borran solos, para no reintentar contra
    ellos en cada alerta.
  - Miembros sin ningún token registrado se quedan en `PENDING` a
    propósito: no es un fallo de envío, la alerta les debe aparecer dentro
    de la app cuando entren.
  - **Una alerta insiste; un mensaje del chat no.** El aviso de alerta se
    manda **3 veces cada 4 s** con el mismo `tag` y `renotify`, así que
    cada repetición vuelve a sonar en vez de apilarse muda. Se corta en
    cuanto alguien toca "Ya voy" o "Resuelta" (se relee el estado antes de
    cada ronda). Lleva además `requireInteraction` (no se auto-descarta),
    patrón de `vibrate`, `Urgency: high`, la acción **"Ya voy"** y el
    enlace directo al grupo. El aviso de chat va con `Urgency: normal`,
    agrupado por grupo y sin insistencia.
  - Por qué no suena como ntfy: una PWA **no puede crear su propio canal de
    notificaciones** en Android. El sonido, la vibración y el "No molestar"
    los decide el canal que Chrome usa para todos los sitios, y la
    propiedad `sound` del estándar no la implementó ningún navegador.
    Repetir el aviso es lo único que sí está en nuestras manos. Para una
    alarma tipo sísmica hay que envolver la PWA en una app nativa
    (Capacitor) y mandar el bloque `android.notification.channelId`.
  - Ícono PNG (`/pwa-192x192.png`; Android no muestra SVG).
- Seguridad: Helmet, rate limiting (30 req/min dispositivos, 120 req/min
  usuarios) y CORS:
  - **Producción**: define `FRONTEND_ORIGIN` (separado por comas si son
    varios) y solo esos orígenes pasan.
  - **Desarrollo** (sin `FRONTEND_ORIGIN`): se acepta `localhost` en
    cualquier puerto. Antes solo pasaba el 5173, y cuando Vite se brincaba
    solo al 5174 (porque el 5173 estaba ocupado) todo fallaba con CORS.
- `scripts/createDevice.js` (`npm run device:create -- BTN-001`) — da de
  alta un botón e imprime sus dos códigos: el `deviceSecret` (va en el
  ESP32, se muestra **una sola vez**) y el código de vinculación que se
  imprime en la caja. Pasándole además un nombre de grupo lo deja vinculado
  de una vez, solo para pruebas. El formato del código de caja está en
  `src/claimCode.js`: 9 caracteres sin letras que se confundan (sin I, L,
  O, 0 ni 1), mostrados como ABC-DEF-GHJ, y al capturarlo se aceptan
  minúsculas, espacios, guiones y el prefijo "SCILD".
- `scripts/sendTestAlert.js` (`npm run alert:test -- "Abarrotes Flores"
  INCENDIO`; el tipo es opcional) — manda una alerta **real** de prueba a
  todos los miembros del grupo, por el mismo camino que `/panic`. Sirve para probar el push sin el ESP32. La
  alerta queda activa para poder probar "Ya voy" / "Marcar resuelta".

### Frontend (`scild-emergencia`)

Proyecto nuevo: React + TypeScript + Vite + Tailwind v4 + React Router.

- `Login.tsx` / `Registro.tsx` — formularios contra Firebase Auth, con
  mensajes de error en español por cada código de error. El registro pide
  el **apodo** ("¿Cómo te van a ver en tu grupo?"). Si no se pudo guardar,
  o la cuenta es de antes, Inicio lo vuelve a pedir (`components/Apodo.tsx`,
  que también permite cambiarlo).
- `AuthContext.tsx` — sesión global (`onAuthStateChanged`).
- `RutaProtegida.tsx` — redirige a `/login` si no hay sesión.
- `Inicio.tsx` — pantalla protegida que llama a `GET /api/auth/me` para
  mostrar el perfil ya sincronizado con el backend.
- `services/api.ts` — cliente que adjunta el ID token de Firebase en cada
  llamada al backend.
- `services/notificaciones.ts` + `components/Notificaciones.tsx` — pide el
  permiso, saca el token de FCM y lo registra en el backend. Distingue los
  cuatro estados posibles (no soportado / desactivadas / bloqueadas /
  activadas). Dos detalles importantes:
  - Sacar **y** borrar el token siempre usa el registro del service worker
    de la app. Antes, al cerrar sesión se pedía el token sin él, Firebase
    registraba otro SW, devolvía un token distinto y el real se quedaba en
    el backend: ese navegador seguía recibiendo las alertas de quien ya
    había salido.
  - `onMessage` de Firebase solo guarda **un** handler (llamarlo de nuevo
    reemplaza al anterior), así que `escucharAlertasEnPrimerPlano` lo
    registra una vez y reparte el aviso a todos los que escuchan.
- `components/AlarmaEnPantalla.tsx` + `services/sirena.ts` — con la app
  abierta el navegador **no** dibuja la notificación del sistema, así que
  una alerta pasaría desapercibida. El componente va montado en toda la app
  (la alerta puede llegar en cualquier pantalla), muestra el aviso rojo con
  "Ver alerta"/"Silenciar" y toca una **sirena**. La sirena se genera con el
  oscilador del navegador en vez de un mp3: no hay archivo que cargar, suena
  sin red y una notificación web no puede traer sonido propio. `prepararSirena()`
  se llama en `main.tsx` para desbloquear el audio en el primer toque —
  sin gesto previo el navegador no deja sonar, y esperar a la emergencia
  sería tarde.
- `pages/Codigos.tsx` — apartado de **Códigos**: el estado de la cuenta
  (completa o invitada), el campo para capturar el código de la caja
  ("Confirmar"), los botones de los que eres titular con sus accesos
  comprados, a quién se los diste y "Ampliar límite". El código también se
  pide, opcional, en `pages/Registro.tsx`: si falla ahí, la cuenta **no** se
  deshace y se manda a Códigos con el motivo.
- `pages/Pago.tsx` — el chat con los administradores: datos bancarios,
  respuestas predeterminadas ("Ya pagué", "¿Cuánto tarda?"…) y el envío de
  **una** captura. La imagen se valida también aquí (5 MB, JPG/PNG/WebP)
  para no hacerle subir de más a alguien con datos móviles.
- `pages/Admin.tsx` — panel de los administradores de la plataforma, con
  dos vistas: **Solicitudes** (filtro por estado y búsqueda, comprobante a
  la vista, aprobar/rechazar/escribirle) y **Clientes** (un renglón por
  botón vendido, con quien lo registró primero, si tiene el límite ampliado
  y "Ampliar +5"). Va dentro de la PWA y no en `SCILD-web` para no duplicar
  sesión, cliente de API y estilos: es una ruta más, que solo abre quien
  tiene `isPlatformAdmin` (el backend responde 403 a cualquier otro).
- `pages/Ayuda.tsx` + `src/data/ayuda.ts` — apartado de Ayuda con preguntas
  por secciones (el botón físico, alertas y notificaciones, cuenta y
  grupos). **El contenido se edita en `src/data/ayuda.ts`**, sin tocar la
  pantalla: una pregunta con `pendiente: true` sale con el aviso de que
  falta escribirla, y `CONTACTO` es donde van el teléfono y el correo de
  soporte cuando se definan.
- `pages/Grupo.tsx` — **una sola pantalla al estilo de una app de
  mensajería** (parecida a WhatsApp en la forma de usarse, pero con
  colores, fondo e íconos propios: encabezado oscuro, rojo SCILD, burbujas
  rosadas, patrón de escudos/campanas/casas):
  - **Encabezado**: nombre del grupo y sus miembros ("Tú, Papá, Luis"). Si
    se cae la conexión en tiempo real dice "Conectando…". Al tocarlo se abre
    la info del grupo (`components/InfoGrupo.tsx`: establecimiento editable
    por el ADMIN, Google Maps, botones, miembros y código de invitación).
  - **Botón SOS** (`components/BotonPanico.tsx`): círculo rojo grande justo
    debajo del encabezado. Se **mantiene presionado 1 segundo** (un anillo
    se va llenando) y manda una alerta `GENERAL` al instante, sin menú ni
    confirmación. El segundo evita que un roce accidental despierte a todo
    el grupo; se cambia en `MANTENER_MS`. Quien dispara la alerta es un
    `setTimeout`, no la animación: el navegador pausa
    `requestAnimationFrame` si la página no está visible. Funciona también
    con teclado (mantener Espacio/Enter) y vibra al empezar y al enviar.
  - **Alertas abiertas fijas** debajo del SOS, con "Ya voy" y "Resuelta",
    para atenderlas sin buscarlas.
  - **Conversación** (`components/Conversacion.tsx`): mensajes y alertas en
    una sola línea de tiempo, agrupada por día ("Hoy", "Ayer"...) con la
    etiqueta del día fija arriba mientras se ven sus mensajes. Las alertas
    salen como tarjetas con su estado. Se queda pegada abajo al llegar algo
    nuevo o al abrirse el teclado (salvo que estés leyendo mensajes viejos).
  - **Caja de mensaje** abajo: crece con el texto; Enter envía y
    Shift+Enter hace salto de línea. A la derecha, donde WhatsApp pone el
    micrófono, va un botón rojo **"!"** que abre el menú "¿Qué está
    pasando?" (`components/MenuAlertas.tsx`) con los tipos del catálogo en
    círculos; al tocar uno la alerta sale de inmediato. Si hay texto
    escrito, ese botón cambia a "enviar".
  - La lógica vive en hooks reutilizables: `hooks/useAlertas.ts` (también
    lo usa la lista de Inicio) y `hooks/useMensajes.ts`.
  - Mientras la pantalla está abierta el chat se marca como leído y el
    backend no manda push de ese grupo.
  - `components/InfoGrupo.tsx`: en "Botones", cada uno muestra de quién es
    y su estado, con "Desvincular" para su dueño o el ADMIN, y abajo
    "Vincular un botón" para capturar el código de la caja. Cierra con
    "Salir del grupo" (todos) y
    "Eliminar grupo" (solo ADMIN, escribiendo el nombre para confirmar), y
    cada miembro tiene "Hacer admin" / "Quitar admin" para el ADMIN.
- `Inicio.tsx` muestra un globito rojo con los mensajes sin leer de cada
  grupo y el enlace a Ayuda.
- `components/GestionGrupos.tsx` — crear establecimiento / unirse con código
  (en `Inicio.tsx`, junto con la lista de alertas abiertas de todos tus
  grupos). La dirección es obligatoria al crear.
- `services/tiempoReal.ts` — una sola conexión Socket.IO para toda la app
  (se abre al primer uso, se cierra al cerrar sesión) y los hooks
  `useEventoTiempoReal` / `useAlReconectar`. En cada reconexión manda un ID
  token fresco. Reintenta sola en los dos casos en que Socket.IO no lo hace
  (el servidor cortó la conexión o la rechazó al conectar). Las listas se
  actualizan al instante por el socket; el refresco cada 60 s, al volver a
  la pestaña y al llegar un push quedan solo como respaldo.
  `useConexionTiempoReal` alimenta el "Conectando…" del encabezado.
- `index.html` usa `interactive-widget=resizes-content` para que en Android
  la pantalla se ajuste al abrir el teclado y la caja de mensaje no quede
  tapada. El color de la barra de estado (`theme-color`, también en el
  manifest de `vite.config.ts`) es el mismo gris oscuro del encabezado.
- **Instalable (`vite-plugin-pwa`, estrategia `injectManifest`)**: hay UN
  solo service worker, `src/sw/sw.ts`, que precachea la app (abre sin red,
  también en rutas como `/grupos/:id`) y recibe el push de FCM con la app
  cerrada. Reemplazó a `public/firebase-messaging-sw.js`: solo cabe un SW por
  scope, y si el plugin generara el suyo, las alertas dejarían de llegar.
  Como ahora pasa por Vite, lee la config de `import.meta.env`. Se registra
  al arrancar en `main.tsx` y `notificaciones.ts` usa ese mismo registro.
  Se actualiza solo (`autoUpdate` + `skipWaiting`). Tiene su propio
  `tsconfig.sw.json` porque corre sin DOM.
- Al tocar la notificación se enfoca la PWA si ya está abierta (en la
  pantalla que sea) o se abre. Ese handler se registra **antes** que
  Firebase a propósito: el del SDK corta la propagación del evento y solo
  enfoca una ventana si su URL coincide exacto, así que el handler que había
  en el SW anterior nunca llegaba a ejecutarse.
- Íconos PNG en `public/`, generados desde `public/icono.svg` con
  `npx pwa-assets-generator` (config en `pwa-assets.config.ts`). Si cambias
  el ícono, edita el SVG y vuelve a correr ese comando.

### Cómo se probó

- Registro real, logout, login con contraseña incorrecta (rechaza bien) y
  correcta (entra bien).
- Grupos y alertas: script end-to-end contra Neon y Firebase reales (23
  chequeos): crear grupo, unirse con código, que un usuario ajeno reciba 404
  en todo, heartbeat y pánico de un botón simulado, estados derivados,
  atender/resolver (incluido el 409 por doble clic), que el botón salga de
  `EMERGENCY`, que la alerta manual no le avise a quien la generó, la
  auditoría, y que un JSON roto responda 400 sin tumbar el servidor. Los
  usuarios de prueba se crean con Firebase Admin + *custom tokens* (sin
  contraseñas) y se borran al final junto con sus datos.
- Chat, tipos de alerta, apodos, edición de grupo y tiempo real: segunda
  prueba end-to-end (42 chequeos) con tres usuarios y **sockets reales**:
  validaciones (apodo, dirección, mensaje vacío o largo, tipo inventado),
  permisos (miembro 403 al editar, ajeno 404 en todo y sin recibir nada por
  el socket, token falso rechazado), que el código viejo deje de servir,
  que los mensajes y cambios de alertas lleguen en vivo, y la paginación
  del chat. Luego en el navegador: menú de alerta → "Incendio", mensaje de
  otro usuario apareciendo sin recargar, edición de la dirección, apodos.
- Pantalla estilo mensajería: en el navegador con tamaño de celular
  (375×812) y una familia de prueba (mensajes de ayer y hoy, una alerta
  resuelta y una activa): soltar el SOS antes del segundo no envía nada y
  mantenerlo sí; menú "!" → tipos; Enter envía; info del grupo desde el
  encabezado; "Resuelta" quita la alerta de las fijas; y con el backend
  apagado el encabezado dice "Conectando…" y se recupera solo al volver.
- Vinculación de botones: cuarta prueba end-to-end (29 chequeos) que da de
  alta un botón con el script real y recorre todo: sin vincular no dispara
  alertas pero sí se reporta, quién puede vincular y desvincular, que la
  alerta diga de qué casa es, que no se filtren el secreto ni el código de
  la caja, y que el mismo código sirva para volver a vincularlo en otro
  grupo. También probado en el navegador.
- Salir/eliminar grupo, nombrar admin y avisos de chat: tercera prueba
  end-to-end (31 chequeos). El push del chat se comprueba desde fuera con
  tokens falsos: FCM los rechaza y el backend los borra, así que el token
  que sobrevive es justo el de quien NO debía recibir el aviso (quien trae
  el chat abierto, o el propio autor del mensaje).
- Push: alertas reales con `npm run alert:test`, recibidas en Chrome con la
  app abierta y cerrada.
- PWA: build de producción con `vite preview` → un solo SW activo en `/`,
  manifest válido, app en caché y rutas como `/grupos/:id` cargando sin red.

## 5. Cómo levantar el proyecto localmente

Necesitas correr backend y frontend al mismo tiempo (dos terminales):

```bash
# Terminal 1 — backend
cd scild-backend
npm install
npx prisma generate   # OJO: repetirlo cada vez que un pull traiga cambios al schema
npm run dev        # http://localhost:3000

# Terminal 2 — frontend
cd scild-emergencia
npm install
npm run dev        # http://localhost:5173
```

Archivos que necesitas y **no vienen en git** (pide que te los compartan
por un canal privado, nunca por chat público ni commiteados):

- `scild-backend/.env` — con `DATABASE_URL` (la de Neon, compartida).
- `scild-backend/firebase-service-account.json` — mejor pide que te
  generen una clave de servicio **propia** en Firebase Console
  (Configuración del proyecto → Cuentas de servicio → Generar nueva clave
  privada) en vez de que te pasen la misma que usa otro.
- `scild-emergencia/.env` — la config web de Firebase (`VITE_FIREBASE_*`,
  esta sí es pública/no secreta), la `VITE_FIREBASE_VAPID_KEY` para el push
  web (Firebase Console → Cloud Messaging → Certificados push web) y
  `VITE_API_URL=http://localhost:3000`.

Cosas que ya nos hicieron perder tiempo:

- **Después de un pull que cambie `prisma/schema.prisma`, corre `npx prisma
  generate` con el backend detenido.** Si el cliente de Prisma queda viejo,
  el backend arranca pero truena en cuanto toca un modelo nuevo (pasó con
  `PushToken`: el push fallaba siempre). En Windows, con el backend
  corriendo, `generate` falla con `EPERM` porque el DLL está en uso.
- **Fíjate en qué puerto quedó Vite.** Si el 5173 está ocupado se va solo al
  5174. El backend ya lo acepta en desarrollo, pero el permiso de
  notificaciones del navegador es por puerto: lo que activaste en uno no
  cuenta en el otro.
- Si ves muchos `ERR_CONNECTION_REFUSED` a `localhost:3000/socket.io` en la
  consola, el backend está apagado (la app sigue abriendo porque la PWA
  queda en caché). Levántalo y se reconecta sola.
- En la consola de desarrollo salen avisos de Workbox ("precaching URLs
  without revision info", "Router is responding to"). Son solo de modo dev;
  en el build de producción no aparecen.
- Con `npm run dev`, el backend se reinicia solo al cambiar el código,
  **pero no** al regenerar Prisma: después de `npx prisma generate`
  reinícialo a mano (o guarda cualquier archivo de `src/`).
- Si FCM acepta el envío pero no ves el aviso, revisa Windows: Configuración
  → Sistema → Notificaciones (Chrome permitido, "No molestar" apagado).

Nota para Windows: si el proyecto vive dentro de OneDrive, `npm run dev` del
backend se reinicia solo cada rato, porque `node --watch` ve los archivos que
OneDrive sincroniza en `node_modules`. Se acota con
`node --watch-path=./src src/server.js`, o moviendo el proyecto fuera de
OneDrive.

Las notificaciones push **solo funcionan sobre HTTPS o en `localhost`**. En
iPhone, además, Safari solo las permite si la PWA está instalada en la
pantalla de inicio (de ahí que el punto de `vite-plugin-pwa` importe para
iOS, no solo por comodidad).

## 6. Qué falta (roadmap inmediato)

Ya hecho: alerta manual, pantallas de grupos, atender/resolver alertas,
PWA instalable con push funcionando, chat del grupo en tiempo real, tipos
de alerta, apodos, edición del grupo por el admin y dirección obligatoria.
En orden sugerido:

1. **Publicar con HTTPS (deploy).** Es lo que desbloquea todo lo demás: sin
   HTTPS no hay push ni instalación en celulares (solo funcionan en
   `localhost`), el ESP32 necesita un backend público al que llamar, y el
   tutorial de `scild-web` necesita una URL real a la cual mandar. Opción
   propuesta: frontend en **Firebase Hosting** (ya usamos ese proyecto de
   Firebase; es estático y con HTTPS gratis) y backend en un servicio de
   Node como **Render** o **Railway**. Pendientes técnicos del deploy:
   - `firebaseAdmin.js` hoy lee la clave de servicio de un **archivo**; en
     el hosting conviene leerla de una variable de entorno.
   - Definir `FRONTEND_ORIGIN` en el backend y `VITE_API_URL` en el build
     del frontend con las URLs reales.
   - Agregar el dominio publicado a los dominios autorizados de Firebase
     Auth.
   - Los planes gratuitos "duermen" el backend tras un rato sin tráfico, y
     el primer `/panic` tardaría varios segundos. En emergencias hay que
     evitarlo (plan que no duerma, o que el heartbeat de los botones lo
     mantenga despierto).
2. ~~Vincular botones desde la app~~ ✅ (ver arriba: código de la caja).
   Falta lo que se decida para **grupos de comunidad** (punto 8) y poder
   **rotar el código de la caja** si se filtra (hoy solo se puede cambiar
   a mano en la base).
3. **Firmware real del ESP32** — que llame a `/api/devices/heartbeat`,
   `/panic` y `/status` con sus credenciales (necesita el backend
   publicado, punto 1).
4. **Página-tutorial de instalación en `scild-web`** — nueva opción junto
   a "Gestionar pedidos" que explique cómo instalar esta PWA (necesita la
   URL publicada, punto 1).
5. **Confiabilidad de las alertas:**
   - Reintentar las `Notification` que quedaron en `PENDING`/`FAILED` (hoy
     solo se intenta una vez).
   - Avisar cuando un botón pasa a `OFFLINE`: un botón apagado es un riesgo
     silencioso, nadie se entera hasta que se necesita.
6. **Pantallas de dispositivos** — ya se ve estado/última señal/batería;
   falta historial (`DeviceEvent`) y configuración básica.
7. **Ubicación** — ya hay enlace a Google Maps con la dirección; falta
   capturar coordenadas y editar la dirección después de crear el grupo.
8. **Grupos de comunidad (cotos, fraccionamientos)** — un coto donde cada
   casa tiene su botón. Propuesta acordada a discutir: NO un modelo aparte,
   sino un `type` en Group (`PERSONAL` | `COMUNIDAD`) que cambia textos y
   valores por defecto, más un **apodo por grupo**
   (`GroupMember.nickname`): en comunidad se pide obligatorio al entrar
   ("¿Cómo se llama tu casa?" → "Casa de Juan") y manda sobre el apodo
   global; en los personales se sigue usando el global ("Mamá"). El botón
   de cada casa se vincula con el código de la caja (punto 2) y toma ese
   nombre, para que la alerta diga "Se presionó Casa de Juan".
9. **Vista de administrador para el equipo** — fuera de la PWA, como
   herramienta interna: mismo login de Firebase con un custom claim
   `admin`, endpoints bajo `/api/admin/*`. Prioridad de contenido:
   dispositivos (estado/batería/última señal y alta de nuevos), alertas
   recientes con cuánto tardaron en atenderse, entregas de push fallidas,
   grupos y auditoría. **Sin mostrar el contenido del chat** y registrando
   en `AuditLog` todo lo que haga un administrador.
10. **Mejoras al chat y a los grupos** (ideas, no urgentes):
   - Que el ADMIN pueda sacar a alguien del grupo (ya puede nombrar y
     quitar administradores).
   - Silenciar el chat de un grupo sin salirse de él.
   - Nota opcional al enviar una alerta ("camioneta gris, placas…").
   - Apodo por grupo (hoy es uno por persona para todos sus grupos).

## 7. Notas de seguridad para quien se una

- Nunca subir `.env` ni `firebase-service-account.json` a git (ya están en
  `.gitignore`, pero revisa antes de un `git add -A`).
- El `deviceSecret` que imprime `createDevice.js` solo se muestra una vez
  — si se pierde, hay que rotar el dispositivo (crear uno nuevo), no se
  puede recuperar el valor original.
