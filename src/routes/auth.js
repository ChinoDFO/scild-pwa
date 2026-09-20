import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { accesoDeCuenta } from "../acceso.js";

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

export default router;
