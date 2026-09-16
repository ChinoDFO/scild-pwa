import { Router } from "express";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";

const router = Router();

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

// Crea un grupo/establecimiento y hace ADMIN a quien lo crea.
router.post("/", userAuth, async (req, res) => {
  const { name, address, latitude, longitude } = req.body ?? {};

  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "El grupo necesita un nombre" });
  }

  const group = await prisma.group.create({
    data: {
      name: name.trim(),
      address: typeof address === "string" ? address : undefined,
      latitude: typeof latitude === "number" ? latitude : undefined,
      longitude: typeof longitude === "number" ? longitude : undefined,
      inviteCode: generateInviteCode(),
      members: {
        create: { userId: req.user.id, role: "ADMIN" },
      },
    },
  });

  res.status(201).json(group);
});

// Un usuario se une a un grupo existente con el código de invitación
// (propuesta, sección 5: controla quién pertenece a cada grupo).
router.post("/join", userAuth, async (req, res) => {
  const { inviteCode } = req.body ?? {};

  if (typeof inviteCode !== "string" || inviteCode.trim().length === 0) {
    return res.status(400).json({ error: "Falta el código de invitación" });
  }

  const group = await prisma.group.findUnique({
    where: { inviteCode: inviteCode.trim().toUpperCase() },
  });

  if (!group) {
    return res.status(404).json({ error: "Código de invitación inválido" });
  }

  try {
    const membership = await prisma.groupMember.create({
      data: { userId: req.user.id, groupId: group.id, role: "MEMBER" },
    });
    res.status(201).json({ groupId: group.id, groupName: group.name, role: membership.role });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "Ya perteneces a este grupo" });
    }
    throw e;
  }
});

export default router;
