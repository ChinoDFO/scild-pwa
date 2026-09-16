import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";

const router = Router();

// La PWA llama esto justo después de login/registro (ya autenticado con
// Firebase) para obtener el perfil sincronizado y a qué grupos pertenece.
router.get("/me", userAuth, async (req, res) => {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: req.user.id },
    include: { group: true },
  });

  res.json({
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    phone: req.user.phone,
    groups: memberships.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      role: m.role,
    })),
  });
});

export default router;
