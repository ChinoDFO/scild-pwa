import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";

const router = Router();

// Panel de los administradores de la PLATAFORMA (nosotros), no de un grupo.
//
// isPlatformAdmin se prende a mano en la base de datos. No hay endpoint para
// otorgarlo a propósito: si lo hubiera, sería el camino más corto para que
// una cuenta comprometida se regale todo.
//
// Por ahora solo trae la lista de clientes. Antes tenía las solicitudes de
// pago, pero se quitó el sistema de pagos: ya no hay accesos que comprar ni
// comprobantes que revisar. Lo que falta aquí (está en el roadmap) es el
// estado de los botones, las alertas recientes con cuánto tardaron en
// atenderse, y las entregas de push fallidas.
router.use(userAuth, (req, res, next) => {
  if (!req.user.isPlatformAdmin) {
    return res.status(403).json({ error: "No tienes acceso al panel de administración" });
  }
  next();
});

const nombreDe = (u) => u?.displayName || u?.email || "—";

// Un renglón por botón registrado, con quien lo registró primero (el cliente
// de verdad), quién lo comparte y cuánto de su cupo se está usando.
router.get("/clientes", async (req, res) => {
  const { q } = req.query;

  const devices = await prisma.device.findMany({
    where: {
      // Solo botones que alguien ya registró: los que siguen en el almacén
      // no son clientes todavía.
      holders: { some: {} },
      ...(q
        ? {
            OR: [
              { deviceCode: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
              { holders: { some: { user: { email: { contains: q, mode: "insensitive" } } } } },
              { holders: { some: { user: { displayName: { contains: q, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      deviceCode: true,
      createdAt: true,
      group: { select: { name: true } },
      _count: { select: { seats: true } },
      holders: {
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          user: { select: { id: true, displayName: true, email: true, createdAt: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(
    devices.map((d) => {
      const [primero, ...resto] = d.holders;
      return {
        deviceId: d.id,
        nombre: d.name || d.deviceCode,
        deviceCode: d.deviceCode,
        grupo: d.group?.name ?? null,
        // El titular que lo registró primero: el cliente.
        cliente: {
          userId: primero.user.id,
          nombre: nombreDe(primero.user),
          email: primero.user.email,
          registradoEl: primero.createdAt,
        },
        // El segundo, si ya usaron las dos validaciones del código.
        acompanante: resto[0] ? nombreDe(resto[0].user) : null,
        lugaresOcupados: d._count.seats,
      };
    })
  );
});

export default router;
