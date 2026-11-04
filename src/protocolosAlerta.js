// Qué hacer y qué NO hacer en cada tipo de emergencia. Protocolos GENERALES
// —no sustituyen la instrucción de una autoridad en el momento— basados en
// las recomendaciones públicas de Protección Civil y Cruz Roja México.
//
// Sale pegado a la propia alerta (ver tiposAlertaGrupo.js) y no en el aviso
// push: un push no tiene espacio para esto, y es justo en el momento de ver
// la alerta —no antes— cuando de verdad hace falta.
export const PROTOCOLO_DEFAULT = {
  hacer: [
    "Mantén la calma y evalúa si hay peligro inmediato antes de actuar.",
    "Aléjate del peligro si puedes hacerlo con seguridad.",
    "Marca al 911 y describe la emergencia con claridad.",
    "Avisa a los demás del grupo qué está pasando.",
  ],
  noHacer: [
    "No te quedes a grabar o investigar si hay riesgo para ti.",
    "No bloquees el paso a quienes van a ayudar.",
  ],
};

export const PROTOCOLOS = {
  CARRO_SOSPECHOSO: {
    hacer: [
      "Obsérvalo desde una distancia segura, sin acercarte.",
      "Anota placas, color, marca y hacia dónde se fue.",
      "Avisa a tus vecinos por el chat del grupo.",
      "Marca al 911 si ves algo evidente: forzando algo, vigilando una casa.",
    ],
    noHacer: [
      "No te acerques a pedir explicaciones.",
      "No intentes bloquearlo o seguirlo tú mismo.",
      "No acuses a nadie en público sin estar seguro.",
    ],
  },
  PERSONA_SOSPECHOSA: {
    hacer: [
      "Mantente a distancia y obsérvala desde un lugar seguro.",
      "Fíjate en su ropa, estatura y hacia dónde se dirige.",
      "Avisa a quienes estén cerca y al grupo.",
      "Marca al 911 si merodea cerca de una casa o intenta forzar algo.",
    ],
    noHacer: ["No la confrontes ni la sigas.", "No la acuses en público sin estar seguro."],
  },
  ROBO: {
    hacer: [
      "Si el asalto está en curso, prioriza tu seguridad: coopera y no resistas.",
      "En cuanto estés a salvo, marca al 911.",
      "Anota lo que recuerdes (señas, vehículo, dirección) apenas puedas.",
      "Avisa al grupo para que los demás tomen precauciones.",
    ],
    noHacer: [
      "No forcejees por tus pertenencias.",
      "No persigas a quien huye.",
      "No entres a un lugar donde pueda seguir el responsable.",
    ],
  },
  INCENDIO: {
    hacer: [
      "Sal del lugar de inmediato y cierra puertas detrás de ti para frenar el fuego.",
      "Agáchate por debajo del humo al salir.",
      "Ya afuera, marca al 911.",
      "Si es un conato pequeño y tienes un extintor a la mano, intenta apagarlo sin arriesgar tu salida.",
    ],
    noHacer: [
      "No uses el elevador.",
      "No regreses por pertenencias.",
      "No abras puertas que estén calientes al tacto.",
    ],
  },
  EMERGENCIA_MEDICA: {
    hacer: [
      "Marca al 911 y describe los síntomas.",
      "Si sabes primeros auxilios, atiende mientras llega ayuda (RCP, controlar sangrados).",
      "Mantén a la persona cómoda y consciente si es posible.",
      "Despeja el área para que pueda llegar la ayuda.",
    ],
    noHacer: [
      "No muevas a la persona si sospechas una lesión de columna o cuello, salvo peligro inmediato.",
      "No le des de comer, beber ni medicamentos sin indicación médica.",
    ],
  },
  ACCIDENTE_VIAL: {
    hacer: [
      "Pon las intermitentes y, si es seguro, coloca señalización o triángulos.",
      "Marca al 911 y describe el lugar y cuántos heridos hay.",
      "Atiende a los heridos sin moverlos si sospechas una lesión grave.",
      "Aléjate del tráfico mientras esperas ayuda.",
    ],
    noHacer: [
      "No muevas a los heridos salvo riesgo inmediato (fuego, más tráfico).",
      "No te quedes parado en el carril.",
      "No discutas responsabilidades antes de que llegue la autoridad.",
    ],
  },
  FUGA_GAS: {
    hacer: [
      "Cierra la llave de paso del gas si puedes hacerlo con seguridad.",
      "Ventila abriendo puertas y ventanas.",
      "Sal del lugar y aléjate.",
      "Marca al 911 o al 071 (CFE) ya que estés afuera.",
    ],
    noHacer: [
      "No enciendas ni apagues luces ni aparatos eléctricos.",
      "No uses el celular, encendedores ni cerillos dentro del área.",
      "No toques interruptores.",
    ],
  },
  INUNDACION: {
    hacer: [
      "Muévete a un piso alto o terreno elevado.",
      "Corta la electricidad del lugar si está a tu alcance y es seguro.",
      "Marca al 911 si hay personas atrapadas.",
      "Aléjate de corrientes de agua en movimiento.",
    ],
    noHacer: [
      "No camines ni manejes sobre agua en movimiento: 30 cm pueden arrastrar un auto.",
      "No toques cables ni aparatos eléctricos mojados.",
      "No bajes a sótanos o niveles ya inundados.",
    ],
  },
  FALLA_ELECTRICA: {
    hacer: [
      "Aléjate del cable o equipo dañado, al menos lo que mide un poste.",
      "Marca al 071 (CFE) para reportarlo, o al 911 si hay alguien en peligro o riesgo de incendio.",
      "Avisa a los vecinos para que tampoco se acerquen.",
    ],
    noHacer: [
      "No toques cables caídos ni intentes moverlos o cubrirlos tú mismo.",
      "No pises charcos cerca de un cable caído.",
    ],
  },
  DISTURBIO: {
    hacer: [
      "Obsérvalo desde una distancia segura.",
      "Marca al 911 si se está saliendo de control.",
      "Avisa a los demás del grupo para que eviten la zona.",
    ],
    noHacer: ["No intentes separar a quienes pelean.", "No grabes exponiéndote de cerca."],
  },
  VANDALISMO: {
    hacer: [
      "Documenta el daño con fotos o video si puedes hacerlo con seguridad, sin confrontar a nadie.",
      "Repórtalo al 911 y cuéntalo en el chat con lo que viste.",
      "Conserva la evidencia para tu seguro o la denuncia.",
    ],
    noHacer: [
      "No confrontes a quien lo está haciendo.",
      "No limpies ni repares nada antes de documentarlo.",
    ],
  },
  ANIMAL_PELIGROSO: {
    hacer: [
      "Aleja a niños y mascotas y mantente a distancia.",
      "Si es un perro, quédate quieto y evita el contacto visual directo en vez de correr.",
      "Avisa a los vecinos por el chat.",
      "Marca al 911 si hay riesgo real de ataque.",
    ],
    noHacer: [
      "No intentes acorralarlo ni capturarlo tú mismo.",
      "No corras: puede detonar su instinto de persecución.",
      "No le des la espalda de forma brusca.",
    ],
  },
  DESASTRE_NATURAL: {
    hacer: [
      "Si tiembla, aléjate de ventanas y objetos que puedan caer, y resguárdate junto a una zona estructuralmente segura.",
      "Cuando termine, sal por las rutas de evacuación sin correr.",
      "Mantente informado y sigue las indicaciones de Protección Civil.",
    ],
    noHacer: [
      "No uses el elevador.",
      "No pierdas tiempo buscando pertenencias.",
      "No regreses a un inmueble dañado sin que lo revisen primero.",
    ],
  },
};

export function protocoloDeAlerta(id) {
  return PROTOCOLOS[id] ?? PROTOCOLO_DEFAULT;
}
