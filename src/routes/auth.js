import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { accesoDeCuenta } from "../acceso.js";
import { firebaseAuth } from "../firebaseAdmin.js";
import { emitirAGrupo } from "../realtime.js";

const router = Router();

// La PWA llama esto justo después de login/registro (ya autenticado con
// Firebase) para obtener el perfil sincronizado y a qué grupos pertenece.
router.get("/me", userAuth, async (req, res) => {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: req.user.id },
    include: { group: true },
  });

  // Mensajes sin leer por grupo, para el globito de la lista de grupos.
  const sinLeer = await Promise.all(
    memberships.map((m) =>
      prisma.message.count({
        where: { groupId: m.groupId, userId: { not: req.user.id }, createdAt: { gt: m.lastReadAt } },
      })
    )
  );

  // Si la cuenta puede alertar. La PWA esconde el botón SOS y el menú de
  // tipos cuando es false, en todos sus grupos.
  const acceso = await accesoDeCuenta(req.user.id);

  res.json({
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    phone: req.user.phone,
    accesoCompleto: acceso.completo,
    esTitular: acceso.esTitular,
    // Administrador de la plataforma: le aparece el panel de solicitudes.
    esAdminPlataforma: req.user.isPlatformAdmin,
    groups: memberships.map((m, i) => ({
      id: m.group.id,
      name: m.group.name,
      role: m.role,
      sinLeer: sinLeer[i],
    })),
  });
});

// Apodo con el que los demás ven a la persona en sus grupos ("Mamá",
// "Don Pepe", "Cajero turno tarde"). Se pide al registrarse y se puede
// cambiar después. Aparece en el chat, la lista de miembros y en el aviso
// push de las alertas que genera ("Mamá reportó: Carro sospechoso").
router.patch("/me", userAuth, async (req, res) => {
  const { displayName } = req.body ?? {};

  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return res.status(400).json({ error: "El apodo no puede ir vacío" });
  }
  if (displayName.trim().length > 40) {
    return res.status(400).json({ error: "El apodo puede tener máximo 40 caracteres" });
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { displayName: displayName.trim() },
  });

  res.json({ displayName: user.displayName });
});

// Eliminar la cuenta. Lo pide la ley en varios lados y, aquí, algo más
// concreto: mientras la cuenta exista ocupa uno de los DOS lugares del código
// de la caja, y ese botón no se le puede pasar a nadie más.
//
// Qué pasa con lo que cuelga de la cuenta (lo define el esquema):
//   - DeviceHolder se borra en cascada -> SE LIBERA EL LUGAR DEL CÓDIGO.
//   - Los botones NO se borran (ownerId es SetNull): el aparato es físico y
//     sigue existiendo; su secreto no se podría recuperar.
//   - Las alertas que generó se quedan (createdById SetNull): son el
//     historial del grupo, no son suyas.
//   - Sus mensajes del chat SÍ se borran (Message.userId es Cascade).
//   - Las membresías se borran, y con ellas se liberan lugares del grupo.
router.delete("/me", userAuth, async (req, res) => {
  // Las mismas dos trabas que para salirse de un grupo, por la misma razón:
  // una cuenta que se va no puede dejar un grupo sin quien lo administre ni
  // un grupo huérfano con botones dentro.
  const membresias = await prisma.groupMember.findMany({
    where: { userId: req.user.id },
    select: { groupId: true, role: true, group: { select: { name: true } } },
  });

  for (const m of membresias) {
    const [totalMiembros, totalAdmins, totalBotones] = await Promise.all([
      prisma.groupMember.count({ where: { groupId: m.groupId } }),
      prisma.groupMember.count({ where: { groupId: m.groupId, role: "ADMIN" } }),
      prisma.device.count({ where: { groupId: m.groupId } }),
    ]);

    if (m.role === "ADMIN" && totalAdmins === 1 && totalMiembros > 1) {
      return res.status(409).json({
        error: `Eres el único administrador de "${m.group.name}". Nombra a otro administrador o elimina el grupo antes de borrar tu cuenta.`,
      });
    }
    if (totalMiembros === 1 && totalBotones > 0) {
      return res.status(409).json({
        error: `Eres el único miembro de "${m.group.name}" y tiene botones vinculados. Elimina el grupo antes de borrar tu cuenta.`,
      });
    }
  }

  // De qué botones era titular: después de borrarla hay que dejarlos en un
  // estado coherente, no solo quitarle la fila.
  const titularidades = await prisma.deviceHolder.findMany({
    where: { userId: req.user.id },
    select: { deviceId: true },
  });

  // Grupos que se quedan sin nadie: se van con ella (misma regla que salir).
  const gruposQueSeVan = [];
  for (const m of membresias) {
    const total = await prisma.groupMember.count({ where: { groupId: m.groupId } });
    if (total === 1) gruposQueSeVan.push(m.groupId);
  }

  const { id: userId, email, firebaseUid } = req.user;

  await prisma.$transaction(async (tx) => {
    // La bitácora se escribe ANTES del borrado y sobrevive: AuditLog.userId
    // es SetNull, así que queda el rastro de que esta cuenta se eliminó
    // aunque ya no se pueda apuntar a quién era.
    await tx.auditLog.create({
      data: {
        userId,
        action: "ACCOUNT_DELETED",
        entity: "User",
        entityId: userId,
        metadata: { email, botonesLiberados: titularidades.map((t) => t.deviceId) },
      },
    });

    for (const groupId of gruposQueSeVan) {
      await tx.group.delete({ where: { id: groupId } });
    }

    // Aquí caen en cascada DeviceHolder, GroupMember, AccessGrant, Message,
    // PushToken, Notification y sus solicitudes de pago.
    await tx.user.delete({ where: { id: userId } });

    // Y ahora sí, los botones que quedaron sin ella.
    for (const { deviceId } of titularidades) {
      const quedan = await tx.deviceHolder.findMany({
        where: { deviceId },
        select: { userId: true },
        orderBy: { createdAt: "asc" },
      });

      await tx.device.update({
        where: { id: deviceId },
        data: quedan.length === 0
          // Sin titulares vuelve a estar "en la caja": claimedAt en null es
          // lo que hace que el código impreso sirva otra vez. Dejarlo con
          // fecha y sin titulares es el estado zombi que ya nos mordió una
          // vez (un botón en un grupo donde nadie podía alertar).
          ? { claimedAt: null, ownerId: null }
          // Queda uno: hereda el aparato, para que alguien pueda
          // desvincularlo de su grupo.
          : { ownerId: quedan[0].userId },
      });
    }
  });

  // Fuera de la transacción a propósito y en este orden: si esto falla, en
  // Postgres ya no hay nada y la persona simplemente volvería a entrar como
  // cuenta nueva y vacía. Al revés (borrar Firebase primero) la dejaría sin
  // poder entrar y con sus datos todavía aquí.
  try {
    await firebaseAuth.deleteUser(firebaseUid);
  } catch (e) {
    console.error(`Cuenta ${email} borrada de la base, pero no de Firebase:`, e.message);
  }

  for (const groupId of membresias.map((m) => m.groupId)) {
    emitirAGrupo(groupId, "grupo:actualizado", { groupId });
  }

  res.json({ ok: true, botonesLiberados: titularidades.length });
});

export default router;
