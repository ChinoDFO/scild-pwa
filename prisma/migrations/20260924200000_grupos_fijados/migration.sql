-- Fijar un grupo arriba de la lista.
--
-- Va en GroupMember y no en Group porque el pin es de cada persona: quien
-- atiende el coto quiere ese chat siempre a la mano, y a los demás miembros
-- del mismo grupo no se les mueve nada.
--
-- Se guarda la fecha en vez de un booleano para poder ordenar entre varios
-- fijados: el último que se fija queda hasta arriba. NULL = no fijado.

-- AlterTable
ALTER TABLE "GroupMember" ADD COLUMN     "pinnedAt" TIMESTAMP(3);
