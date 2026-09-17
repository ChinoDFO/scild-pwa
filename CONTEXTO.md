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

## 3. Repos

| Proyecto | Qué es | Dónde vive | GitHub |
|---|---|---|---|
| `scild-web` | Tienda/pedidos (sin tocar) | `PP/scild-web` | https://github.com/ChinoDFO/SCILD-web |
| `scild-backend` | Backend del sistema de emergencia (este repo) | `PP/scild-backend` | https://github.com/ChinoDFO/scild-pwa |
| `scild-emergencia` | Frontend del sistema de emergencia (login, dashboard, etc.) | `PP/scild-emergencia` | **todavía no está en GitHub** — pendiente |

## 4. Qué ya funciona (implementado y probado)

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
    `EMERGENCY`, devuelve el id de la alerta creada.
  - `POST /api/devices/status` — reporta estado (`ONLINE`/`MAINTENANCE`
    solamente; `EMERGENCY` solo lo dispara `/panic`, nunca el propio
    dispositivo).
- **Endpoints de usuario** (autenticados con `Authorization: Bearer
  <idToken>` de Firebase):
  - `GET /api/auth/me` — perfil + grupos del usuario (se autocrea en
    Postgres la primera vez que llega un token válido).
  - `POST /api/groups` — crea un grupo/establecimiento, el creador queda
    como `ADMIN`.
  - `POST /api/groups/join` — se une a un grupo con `inviteCode` (404 si
    no existe, 409 si ya es miembro).
  - `POST /api/notifications/token` — registra el token de FCM del
    navegador actual (se reasigna si ya existía bajo otra cuenta).
  - `DELETE /api/notifications/token` — lo borra al cerrar sesión.
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
- Seguridad: Helmet, rate limiting (30 req/min dispositivos, 120 req/min
  usuarios), CORS restringido al origen del frontend.
- `scripts/createDevice.js` — da de alta un dispositivo de prueba (crea su
  grupo si no existe) e imprime el `deviceSecret` en claro una sola vez.

### Frontend (`scild-emergencia`)

Proyecto nuevo: React + TypeScript + Vite + Tailwind v4 + React Router.

- `Login.tsx` / `Registro.tsx` — formularios contra Firebase Auth, con
  mensajes de error en español por cada código de error.
- `AuthContext.tsx` — sesión global (`onAuthStateChanged`).
- `RutaProtegida.tsx` — redirige a `/login` si no hay sesión.
- `Inicio.tsx` — pantalla protegida que llama a `GET /api/auth/me` para
  mostrar el perfil ya sincronizado con el backend.
- `services/api.ts` — cliente que adjunta el ID token de Firebase en cada
  llamada al backend.
- `services/notificaciones.ts` + `components/Notificaciones.tsx` — pide el
  permiso, saca el token de FCM y lo registra en el backend. Distingue los
  cuatro estados posibles (no soportado / desactivadas / bloqueadas /
  activadas) y muestra la alerta en pantalla cuando llega con la app
  abierta, porque en primer plano el navegador no dibuja el aviso del
  sistema.
- `public/firebase-messaging-sw.js` — service worker que recibe las alertas
  con la app cerrada. No pasa por Vite, así que recibe la config de
  Firebase en la query string con la que se registra, en vez de llevarla
  hardcodeada.

Todo esto se probó de punta a punta en navegador: registro real, logout,
login con contraseña incorrecta (rechaza bien) y correcta (entra bien).

## 5. Cómo levantar el proyecto localmente

Necesitas correr backend y frontend al mismo tiempo (dos terminales):

```bash
# Terminal 1 — backend
cd scild-backend
npm install
npx prisma generate
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

En orden sugerido, retomando el plan por etapas de la propuesta original:

1. **Endpoint de alerta manual** — el `AlertSource.APP` ya existe en el
   schema y `push.js` ya sabe redactar el aviso para ese caso, pero falta
   el `POST /api/alerts` que lo dispare desde la PWA.
2. **Pantallas de grupos en el frontend** — crear grupo / unirse con
   código de invitación (el backend ya lo soporta, falta la UI).
3. **Pantallas de dispositivos** — ver estado, última conexión, historial,
   configuración básica.
4. **Ubicación** — guardar dirección/coordenadas del grupo y mostrar
   enlace a Google Maps.
5. **Chat grupal** — Socket.IO + tabla `Message` (ya existe en el schema).
6. **`vite-plugin-pwa`** — hacer instalable la app (manifest, service
   worker, ícono).
7. **Página-tutorial de instalación en `scild-web`** — nueva opción junto
   a "Gestionar pedidos" que explique cómo instalar esta PWA.
8. **Firmware real del ESP32** — que efectivamente llame a
   `/api/devices/heartbeat`, `/panic` y `/status` con sus credenciales.

## 7. Notas de seguridad para quien se una

- Nunca subir `.env` ni `firebase-service-account.json` a git (ya están en
  `.gitignore`, pero revisa antes de un `git add -A`).
- El `deviceSecret` que imprime `createDevice.js` solo se muestra una vez
  — si se pierde, hay que rotar el dispositivo (crear uno nuevo), no se
  puede recuperar el valor original.
