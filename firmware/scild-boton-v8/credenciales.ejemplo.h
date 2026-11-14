/*
 * Credenciales de UNA unidad. Copia este archivo como `credenciales.h`
 * (en esta misma carpeta) y llénalo con lo que te dio el panel de
 * administración al dar de alta el botón.
 *
 *   SCILD_DEVICE_CODE   → el número de serie, corto: BTN-003
 *   SCILD_DEVICE_SECRET → el secreto, 32 caracteres revueltos
 *
 * OJO: el código con guiones que va impreso en la CAJA (BNB-YWG-VQZ) NO va
 * aquí. Ese se teclea en la app, para adueñarse del botón y vincularlo a un
 * grupo. Confundirlos es el error más fácil de cometer: los dos son códigos
 * del mismo aparato, pero uno vive dentro y el otro afuera.
 *
 * `credenciales.h` está en el .gitignore y NO se sube: el secreto solo se
 * muestra una vez y no debe terminar en GitHub. Este archivo de ejemplo sí
 * se versiona, para que quien clone el proyecto sepa qué hace falta.
 *
 * Si no existe `credenciales.h`, el programa compila igual: el botón queda
 * sin credenciales de fábrica y las pide en su portal la primera vez.
 */

#define SCILD_DEVICE_CODE ""
#define SCILD_DEVICE_SECRET ""
