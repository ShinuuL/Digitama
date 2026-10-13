// Sprites em pixel art desenhados em código: cada Digimon é uma lista de formas
// simples (elipses, polígonos, linhas, pontos) rasterizadas numa grade pequena
// (16 px bebês, 32 px Criança, 40 px do Adulto em diante), com contorno e
// sombreamento automáticos. Proporções, poses e paletas foram estudadas nos
// sprites do Digimon Story (DS) e dos V-Pets (Wikimon).
//
// São recriações à mão — não os sprites oficiais. Para usar os
// seus, coloque um PNG com o id do Digimon (ex.: agumon.png) na pasta de
// sprites (Configurações → Abrir pasta de sprites).

export type Shape =
  | ["e", number, number, number, number, string] // elipse: cx, cy, rx, ry
  | ["r", number, number, number, number, string] // retângulo: x, y, w, h
  | ["p", number[], string] // polígono: x0,y0,x1,y1…
  | ["l", number, number, number, number, string] // linha de pixels
  | ["d", number, number, string]; // um pixel

export interface SpriteDef {
  size: number;
  shapes: Shape[];
  /** Cores que não recebem sombra (olhos, brilhos). */
  flat?: string[];
}

export interface Sprite {
  size: number;
  /** Cor de cada pixel, linha a linha; null = transparente. */
  px: (string | null)[];
}

const OUTLINE = "#1a1222";
const W = "#ffffff";
const PUPIL = "#141020";

/** Espelha formas no eixo X (para asas e orelhas simétricas). */
function mirror(shapes: Shape[], size: number): Shape[] {
  return shapes.map((s): Shape => {
    switch (s[0]) {
      case "e":
        return ["e", size - s[1], s[2], s[3], s[4], s[5]];
      case "r":
        return ["r", size - s[1] - s[3], s[2], s[3], s[4], s[5]];
      case "p":
        return ["p", s[1].map((v, i) => (i % 2 === 0 ? size - v : v)), s[2]];
      case "l":
        return ["l", size - 1 - s[1], s[2], size - 1 - s[3], s[4], s[5]];
      case "d":
        return ["d", size - 1 - s[1], s[2], s[3]];
    }
  });
}

const both = (shapes: Shape[], size: number): Shape[] => [...shapes, ...mirror(shapes, size)];

// ── Ovos ─────────────────────────────────────────────────────────────────────

function eggDef(base: string, spot: string, pattern: "spots" | "stripes" | "stars"): SpriteDef {
  const shapes: Shape[] = [["e", 8, 9, 5, 6.5, base]];
  if (pattern === "spots") {
    shapes.push(["e", 6, 7, 1.6, 1.1, spot], ["e", 10.5, 11, 1.6, 1.3, spot], ["e", 5.5, 12.5, 1, 1, spot], ["e", 10.5, 5.5, 1, 0.8, spot]);
  } else if (pattern === "stripes") {
    shapes.push(["l", 4, 8, 6, 6, spot], ["l", 7, 6, 9, 8, spot], ["l", 10, 8, 12, 6, spot]);
    shapes.push(["l", 4, 12, 6, 10, spot], ["l", 7, 10, 9, 12, spot], ["l", 10, 12, 12, 10, spot]);
  } else {
    for (const [x, y] of [[6, 6], [10, 9], [6, 12], [11, 4]] as const) {
      shapes.push(["d", x, y, spot], ["d", x - 1, y, spot], ["d", x + 1, y, spot], ["d", x, y - 1, spot], ["d", x, y + 1, spot]);
    }
  }
  return { size: 16, shapes, flat: [spot] };
}

const K = OUTLINE;

// ── Agumon → WarGreymon ──────────────────────────────────────────────────────

const AG = "#fccc30"; // amarelo do Agumon
const AG_D = "#d89024";
const AG_GREEN = "#30b460";
const CLAW = "#eceef4";
const GR_O = "#fc9c00"; // laranja do Greymon
const GR_D = "#e06a00";
const GR_Y = "#fccc00";
const GR_HELM = "#60483c";
const GR_STRIPE = "#2484f0";
const HORN = "#c9d6d6";
const MOUTH_IN = "#c0303a";
const METAL = "#a8b4b4";
const METAL_D = "#606c84";
const WG_GOLD = "#fce400";
const WG_GOLD_D = "#c09000";
const SILVER = "#d0d0d6";
const SILVER_D = "#9c9c9c";

const botamon: SpriteDef = {
  size: 16,
  shapes: [
    ["e", 8, 10.5, 5.5, 4.5, "#3a3640"],
    ["d", 4, 6, "#3a3640"], ["d", 6, 5, "#3a3640"], ["d", 8, 5, "#3a3640"], ["d", 10, 5, "#3a3640"], ["d", 12, 6, "#3a3640"],
    ["d", 4, 11, "#5c5866"], ["d", 12, 12, "#5c5866"], ["d", 7, 14, "#5c5866"],
    ["r", 5, 9, 2, 2, "#ffd84a"], ["r", 9, 9, 2, 2, "#ffd84a"],
    ["d", 6, 10, PUPIL], ["d", 10, 10, PUPIL],
  ],
  flat: ["#ffd84a", PUPIL, "#5c5866"],
};

const koromon: SpriteDef = {
  size: 16,
  shapes: [
    // orelhas compridas que se curvam para fora
    ...both([["l", 5, 7, 3, 3, "#f09ce4"], ["l", 3, 3, 1, 2, "#f09ce4"], ["d", 0, 3, "#f09ce4"]], 16),
    ["e", 8, 10.5, 6.5, 4.5, "#fcc0e4"],
    ["e", 8, 13, 5.5, 2, "#f09ce4"],
    ["r", 4, 9, 2, 2, "#9c0000"], ["r", 10, 9, 2, 2, "#9c0000"], ["d", 4, 9, W], ["d", 10, 9, W],
    ["l", 6, 12, 9, 12, "#782424"], ["d", 5, 11, "#782424"], ["d", 10, 11, "#782424"],
  ],
  flat: ["#9c0000", W, "#782424"],
};

const agumon: SpriteDef = {
  size: 32,
  shapes: [
    ["p", [3, 29, 9, 20, 13, 24, 10, 29], AG_D],
    // perna de trás (mais escura, dá profundidade)
    ["e", 12, 23, 4, 4.5, AG_D], ["r", 10, 25, 4, 5, AG_D], ["r", 8, 29, 6, 2, AG_D],
    ["d", 8, 30, CLAW], ["d", 10, 30, CLAW], ["d", 12, 30, CLAW],
    ["e", 16, 19, 6, 7, AG],
    // perna da frente
    ["e", 19, 23, 4, 4.5, AG], ["r", 18, 25, 4, 5, AG], ["r", 17, 29, 7, 2, AG],
    ["d", 19, 30, CLAW], ["d", 21, 30, CLAW], ["d", 23, 30, CLAW],
    // braço com três garras
    ["p", [18, 15, 22, 15, 25, 19, 23, 21, 19, 19], AG],
    ["l", 19, 16, 22, 19, AG_D],
    ["d", 25, 20, CLAW], ["d", 26, 19, CLAW], ["d", 24, 21, CLAW],
    // cabeça grande e focinho comprido
    ["e", 17, 8.5, 7, 5.5, AG],
    ["p", [17, 5.5, 27, 6.5, 29.5, 9, 29.5, 12.5, 26, 13.5, 17, 13.5], AG],
    ["l", 18, 11, 28, 11, K], ["d", 28, 8, K],
    ["d", 21, 12, CLAW], ["d", 25, 12, CLAW],
    ["e", 19.5, 6, 2, 2.2, AG_GREEN], ["d", 19, 5, W], ["d", 20, 6, PUPIL], ["d", 20, 7, PUPIL],
  ],
  flat: [AG_GREEN, W, PUPIL, CLAW],
};

const greymonBody = (helmet: string, frontArm = true): Shape[] => [
  ["p", [2, 34, 10, 24, 15, 28, 8, 35], GR_O],
  ["l", 6, 30, 8, 32, GR_STRIPE], ["l", 9, 27, 11, 29, GR_STRIPE],
  ["e", 13, 28, 5, 5, GR_D], ["r", 11, 31, 4, 5, GR_D], ["r", 9, 35, 7, 3, GR_D],
  ["d", 9, 37, CLAW], ["d", 11, 37, CLAW], ["d", 13, 37, CLAW],
  ["e", 18, 23, 8, 8.5, GR_O],
  ["e", 21, 25, 4.5, 6, GR_Y],
  ["l", 12, 18, 14, 22, GR_STRIPE], ["l", 11, 23, 13, 26, GR_STRIPE], ["l", 15, 16, 16, 18, GR_STRIPE],
  ["e", 23, 28, 5, 5, GR_O], ["r", 22, 31, 4, 5, GR_O], ["r", 21, 35, 8, 3, GR_O],
  ["d", 22, 37, CLAW], ["d", 24, 37, CLAW], ["d", 26, 37, CLAW], ["d", 28, 37, CLAW],
  ["p", [20, 19, 25, 21, 28, 25, 26, 26, 21, 23], GR_D],
  ["d", 28, 26, CLAW], ["d", 27, 27, CLAW],
  ...(frontArm
    ? ([
        ["p", [22, 20, 29, 22, 32, 26, 30, 27, 24, 24], GR_O],
        ["d", 26, 22, GR_STRIPE], ["d", 27, 23, GR_STRIPE],
        ["d", 32, 27, CLAW], ["d", 33, 26, CLAW], ["d", 31, 28, CLAW],
      ] as Shape[])
    : []),
  // cabeça, boca aberta com dentes
  ["e", 25, 12, 7, 5.5, GR_O],
  ["p", [24, 9, 36, 10, 38, 13, 36, 15, 25, 15], GR_O],
  ["p", [24, 16, 35, 17, 36, 19, 25, 19], GR_O],
  ["p", [25, 15, 36, 15, 35, 17, 25, 16], MOUTH_IN],
  ["d", 27, 15, W], ["d", 30, 15, W], ["d", 33, 15, W], ["d", 28, 17, W], ["d", 31, 17, W], ["d", 34, 17, W],
  // capacete (casca da cabeça) com três chifres
  ["p", [17, 8, 22, 4, 31, 5, 37, 9, 37, 11, 30, 11, 25, 12, 19, 13], helmet],
  ["p", [19, 7, 13, 1, 16, 1, 22, 5], HORN],
  ["p", [26, 5, 29, 0, 31, 1, 30, 6], HORN],
  ["p", [35, 9, 38, 5, 39, 6, 37, 10], HORN],
  ["e", 29, 10, 1.3, 1, "#d02020"], ["d", 29, 10, PUPIL],
];

const greymon: SpriteDef = {
  size: 40,
  shapes: greymonBody(GR_HELM),
  flat: [CLAW, W, PUPIL, MOUTH_IN, GR_STRIPE, "#d02020"],
};

const metalgreymon: SpriteDef = {
  size: 40,
  shapes: [
    // asas roxas atrás
    ["p", [14, 18, 2, 4, 6, 6, 4, 10, 9, 10, 7, 15, 12, 14], "#54489c"],
    ["p", [17, 15, 12, 1, 16, 3, 15, 7, 19, 8, 18, 12], "#7a6cc0"],
    ["l", 13, 16, 5, 7, "#48306c"],
    ...greymonBody(METAL, false),
    ["p", [18, 7, 14, 10, 17, 11, 20, 9], "#e03c3c"],
    // placa no peito e o braço de metal (Trident Arm)
    ["e", 21, 21, 4.5, 4, METAL], ["l", 18, 21, 24, 21, METAL_D], ["d", 21, 19, METAL_D],
    ["p", [22, 20, 30, 22, 33, 25, 31, 27, 24, 25], METAL],
    ["p", [32, 22, 39, 24, 36, 26, 39, 29, 33, 29], METAL_D],
  ],
  flat: [CLAW, W, PUPIL, MOUTH_IN, GR_STRIPE, "#d02020", METAL_D, "#48306c"],
};

const wargreymon: SpriteDef = {
  size: 40,
  shapes: [
    // Brave Shield: as duas metades laranja atrás dos ombros
    ["e", 8, 15, 5, 8, "#a85a10"], ["e", 8, 15, 4, 7, "#e8902c"],
    ["e", 32, 15, 5, 8, "#a85a10"], ["e", 32, 15, 4, 7, "#e8902c"],
    ["p", [6, 12, 8, 9, 10, 12, 8, 15], "#d8303c"], ["p", [30, 12, 32, 9, 34, 12, 32, 15], "#d8303c"],
    // cabelo loiro saindo do capacete
    ["p", [15, 8, 9, 6, 11, 10, 7, 12, 14, 13], "#fcfc6c"],
    ["r", 14, 27, 5, 9, WG_GOLD], ["r", 21, 27, 5, 9, WG_GOLD],
    ["r", 14, 30, 5, 1, WG_GOLD_D], ["r", 21, 30, 5, 1, WG_GOLD_D],
    ["r", 13, 35, 7, 3, WG_GOLD_D], ["r", 20, 35, 7, 3, WG_GOLD_D],
    ["d", 13, 37, CLAW], ["d", 26, 37, CLAW],
    ["r", 14, 17, 12, 11, GR_O],
    ["r", 14, 17, 12, 6, WG_GOLD],
    ["r", 18, 19, 4, 2, "#d8303c"], ["d", 19, 21, "#d8303c"], ["d", 20, 21, "#d8303c"],
    ["r", 14, 25, 12, 2, "#846000"],
    ["r", 9, 18, 5, 8, WG_GOLD], ["r", 26, 18, 5, 8, WG_GOLD],
    // Dramon Destroyers
    ["p", [27, 24, 39, 21, 37, 24, 39, 27, 36, 30, 27, 29], SILVER],
    ["l", 30, 25, 37, 23, SILVER_D], ["l", 30, 27, 37, 27, SILVER_D],
    ["p", [13, 24, 1, 21, 3, 24, 1, 27, 4, 30, 13, 29], SILVER],
    ["l", 10, 25, 3, 23, SILVER_D], ["l", 10, 27, 3, 27, SILVER_D],
    ["e", 20, 11, 5.5, 5, GR_O],
    ["p", [21, 10, 30, 11, 31, 13, 30, 15, 22, 15], GR_O], ["l", 23, 13, 30, 13, K],
    // capacete dourado, separado do rosto por uma linha escura
    ["p", [14, 9, 17, 4, 25, 4, 29, 8, 27, 10, 15, 11], WG_GOLD],
    ["l", 16, 11, 27, 10, K],
    ["p", [22, 4, 27, 0, 26, 5], WG_GOLD], ["p", [26, 7, 32, 3, 30, 8], WG_GOLD], ["p", [17, 5, 15, 1, 19, 4], WG_GOLD],
    ["d", 25, 9, AG_GREEN], ["d", 25, 8, AG_GREEN],
  ],
  flat: [CLAW, AG_GREEN, "#d8303c", SILVER_D, "#846000", "#a85a10"],
};

// ── Guilmon → Gallantmon ─────────────────────────────────────────────────────

const GU = "#f23434";
const GU_D = "#9c183c";
const GU_W = "#f0f0fc";
const HAZARD = "#241818";
const GU_EYE = "#fcd23c";

const jyarimon: SpriteDef = {
  size: 16,
  shapes: [
    ...both([["p", [3, 8, 2, 2, 7, 6], "#f2662a"]], 16),
    ["e", 8, 10.5, 6, 4.5, "#f2662a"],
    ["r", 4, 8, 3, 3, PUPIL], ["r", 9, 8, 3, 3, PUPIL], ["d", 5, 8, W], ["d", 10, 8, W],
    ["d", 8, 12, "#9c2a10"],
  ],
  flat: [PUPIL, W, "#9c2a10"],
};

const gigimon: SpriteDef = {
  size: 16,
  shapes: [
    ["p", [4, 8, 2, 1, 7, 6], "#ee5a3a"], ["p", [10, 6, 14, 1, 13, 8], HAZARD],
    ["p", [10, 7, 13, 3, 12, 8], "#ee5a3a"],
    ["e", 8, 10, 6, 4.5, "#ee5a3a"],
    ["e", 7.5, 12, 4, 2.2, "#f8b49a"],
    ["p", [13, 13, 15, 14, 13, 15], "#ee5a3a"],
    ["r", 9, 8, 2, 2, GU_EYE], ["d", 10, 9, PUPIL],
    ["p", [11, 11, 13, 10, 13, 12], HAZARD],
    ["l", 4, 12, 9, 12, PUPIL], ["d", 5, 13, W], ["d", 8, 13, W],
  ],
  flat: [GU_EYE, PUPIL, W, HAZARD],
};

const guilmon: SpriteDef = {
  size: 32,
  shapes: [
    ["p", [2, 27, 9, 20, 13, 24, 7, 29], GU],
    ["l", 5, 25, 6, 27, HAZARD], ["l", 8, 23, 9, 25, HAZARD],
    ["e", 12, 23, 4, 4.5, GU_D], ["r", 10, 25, 4, 5, GU_D], ["r", 8, 29, 6, 2, GU_D],
    ["d", 8, 30, CLAW], ["d", 10, 30, CLAW], ["d", 12, 30, CLAW],
    ["e", 16, 19, 6, 7, GU],
    ["e", 18.5, 20, 3.5, 5.5, GU_W],
    // a Digital Hazard no peito
    ["d", 18, 18, HAZARD], ["d", 19, 18, HAZARD], ["d", 17, 19, HAZARD], ["d", 20, 19, HAZARD], ["d", 18, 20, HAZARD], ["d", 19, 20, HAZARD],
    ["l", 11, 16, 12, 19, HAZARD],
    ["e", 19, 23, 4, 4.5, GU], ["r", 18, 25, 4, 5, GU], ["r", 17, 29, 7, 2, GU],
    ["l", 18, 26, 21, 26, HAZARD],
    ["d", 19, 30, CLAW], ["d", 21, 30, CLAW], ["d", 23, 30, CLAW],
    ["p", [18, 15, 22, 15, 25, 19, 23, 21, 19, 19], GU],
    ["d", 25, 20, CLAW], ["d", 26, 19, CLAW], ["d", 24, 21, CLAW],
    // orelhas em asa
    ["p", [14, 8, 9, 1, 12, 1, 17, 5], GU], ["p", [17, 5, 17, 0, 21, 1, 20, 5], GU],
    ["e", 18, 9, 6.5, 5, GU],
    ["p", [18, 6.5, 27, 7.5, 29.5, 10, 28.5, 13, 18, 14], GU],
    ["p", [19, 13, 28, 13, 26, 15, 20, 15], GU_W],
    ["l", 19, 12, 28, 12, K],
    ["l", 14, 8, 15, 11, HAZARD], ["l", 24, 8, 25, 8, HAZARD],
    ["e", 21.5, 8, 1.4, 1.3, GU_EYE], ["d", 22, 8, PUPIL],
  ],
  flat: [CLAW, HAZARD, GU_EYE, PUPIL],
};

const growlmon: SpriteDef = {
  size: 40,
  shapes: [
    ["p", [2, 34, 10, 26, 15, 30, 8, 36], GU],
    ["l", 5, 32, 7, 34, HAZARD], ["l", 9, 29, 10, 31, HAZARD],
    ["e", 14, 29, 5, 5, GU_D], ["r", 12, 32, 4, 4, GU_D], ["r", 10, 35, 7, 3, GU_D],
    ["d", 10, 37, CLAW], ["d", 12, 37, CLAW], ["d", 14, 37, CLAW],
    ["e", 19, 24, 9, 9, GU],
    ["e", 21.5, 26, 5.5, 6.5, "#e4d8d8"],
    ["l", 12, 19, 14, 23, HAZARD], ["l", 11, 25, 13, 28, HAZARD],
    ["e", 24, 29, 5, 5, GU], ["r", 23, 32, 4, 4, GU], ["r", 22, 35, 8, 3, GU],
    ["l", 23, 31, 26, 31, HAZARD],
    ["d", 23, 37, CLAW], ["d", 25, 37, CLAW], ["d", 27, 37, CLAW], ["d", 29, 37, CLAW],
    // lâminas dos cotovelos
    ["p", [22, 21, 15, 26, 17, 27, 24, 24], "#e4d8d8"],
    ["p", [23, 19, 30, 22, 34, 27, 31, 29, 26, 25], GU],
    ["d", 34, 28, CLAW], ["d", 35, 27, CLAW], ["d", 33, 29, CLAW],
    // juba branca
    ["p", [17, 9, 18, 3, 21, 5, 23, 1, 25, 5, 27, 3, 27, 8, 22, 11, 18, 12], "#e4d8d8"],
    ["e", 25, 12, 6.5, 5.5, GU],
    ["p", [24, 9, 36, 10, 38, 13, 36, 15, 25, 15], GU],
    ["p", [24, 16, 35, 17, 35, 19, 25, 19], GU],
    ["p", [25, 15, 36, 15, 35, 17, 25, 16], "#601818"],
    ["d", 27, 15, W], ["d", 30, 15, W], ["d", 33, 15, W], ["d", 28, 17, W], ["d", 31, 17, W],
    ["l", 30, 9, 32, 11, HAZARD], ["l", 21, 13, 22, 16, HAZARD],
    ["e", 28, 10, 1.3, 1, GU_EYE], ["d", 28, 10, PUPIL],
  ],
  flat: [CLAW, HAZARD, GU_EYE, PUPIL, W, "#601818"],
};

const wargrowlmon: SpriteDef = {
  size: 40,
  shapes: [
    // Atomic Blasters nas costas
    ["r", 12, 2, 4, 15, "#ccccc0"], ["r", 19, 1, 4, 15, "#ccccc0"],
    ["r", 12, 2, 4, 2, "#e42418"], ["r", 19, 1, 4, 2, "#e42418"],
    ["l", 13, 6, 13, 15, "#9c9c90"], ["l", 20, 5, 20, 14, "#9c9c90"],
    ["p", [12, 20, 2, 12, 1, 14, 9, 25], "#d8d8e4"],
    ["e", 14, 29, 5, 5, "#b43030"], ["r", 12, 32, 4, 4, "#b43030"], ["r", 10, 35, 7, 3, "#a8a8c0"],
    ["d", 10, 37, CLAW], ["d", 13, 37, CLAW],
    ["e", 20, 24, 9, 9, "#e42418"],
    ["e", 21, 21, 6, 5, "#a8a8c0"], ["l", 17, 22, 25, 22, "#606084"], ["e", 21, 21, 1.5, 1.5, HAZARD],
    ["e", 24, 29, 5, 5, "#e42418"], ["r", 23, 32, 4, 4, "#e42418"], ["r", 22, 35, 8, 3, "#a8a8c0"],
    ["d", 23, 37, CLAW], ["d", 26, 37, CLAW], ["d", 29, 37, CLAW],
    ["p", [23, 19, 30, 21, 33, 25, 30, 27, 25, 24], "#a8a8c0"],
    ["p", [27, 21, 37, 12, 38, 14, 31, 25], "#d8d8e4"], ["l", 30, 21, 36, 14, "#9c9c90"],
    ["p", [17, 9, 18, 4, 21, 6, 23, 3, 25, 6, 22, 11, 18, 12], "#e4d8d8"],
    ["e", 26, 12, 6, 5, "#e42418"],
    ["p", [25, 10, 36, 11, 38, 13, 36, 16, 26, 16], "#e42418"],
    ["p", [20, 9, 26, 6, 34, 8, 37, 11, 28, 11, 22, 12], "#a8a8c0"],
    ["l", 26, 14, 36, 14, K],
    ["e", 29, 12, 1.2, 1, GU_EYE],
  ],
  flat: [CLAW, HAZARD, GU_EYE, "#606084", "#9c9c90"],
};

const gallantmon: SpriteDef = {
  size: 40,
  shapes: [
    // capa vermelha
    ["p", [12, 9, 30, 9, 37, 30, 27, 26, 21, 35, 14, 26, 5, 31], "#d8183c"],
    ["p", [14, 12, 28, 12, 31, 24, 21, 30, 11, 24], "#78183c"],
    // Gram, a lança
    ["p", [27, 25, 28, 21, 39, 1, 31, 22], "#e6e8f4"], ["l", 30, 20, 37, 5, "#909cc0"],
    ["r", 15, 26, 4, 9, "#d8d8f0"], ["r", 21, 26, 4, 9, "#d8d8f0"],
    ["p", [14, 34, 20, 34, 19, 37, 12, 38], "#a89024"], ["p", [20, 34, 26, 34, 27, 38, 21, 37], "#a89024"],
    ["r", 15, 15, 10, 12, "#d8d8f0"], ["r", 16, 16, 8, 4, "#d8183c"], ["r", 15, 25, 10, 1, "#a89024"],
    ["e", 14, 15, 3, 2.5, "#d8183c"], ["e", 26, 15, 3, 2.5, "#d8183c"],
    ["r", 26, 17, 4, 7, "#d8d8f0"], ["r", 26, 22, 4, 2, "#a89024"],
    // Aegis, o escudo
    ["e", 10, 22, 6.5, 7, "#a89024"], ["e", 10, 22, 5.5, 6, "#c8cce0"],
    ["e", 10, 22, 2.2, 2.2, "#d8183c"], ["d", 10, 22, HAZARD],
    ["d", 10, 16, "#fcf090"], ["d", 15, 22, "#fcf090"], ["d", 10, 28, "#fcf090"], ["d", 5, 22, "#fcf090"],
    ["e", 20, 10, 4, 4.5, "#d8d8f0"], ["r", 18, 9, 5, 2, "#3c3c60"], ["d", 21, 9, "#fcf090"],
    ["p", [19, 6, 21, 1, 23, 6], "#d8183c"],
    ["l", 17, 7, 13, 3, "#78789c"], ["l", 13, 3, 11, 6, "#78789c"],
  ],
  flat: [HAZARD, "#fcf090", "#3c3c60", "#909cc0", "#78789c"],
};

// ── Dorumon → Alphamon ───────────────────────────────────────────────────────

const DO = "#7860d8";
const DO_D = "#54309c";
const DO_W = "#cccce4";
const DO_GEM = "#e8341c";
const DG_DARK = "#3c3c48";
const DG_BODY = "#4c4a62"; // corpo do Dorugamon, um tom acima das asas
const DG_WING = "#2a2a36";

const dodomon: SpriteDef = {
  size: 16,
  shapes: [
    ...both([["p", [2, 9, 3, 3, 7, 6], "#5454fc"], ["d", 4, 5, "#fc7878"]], 16),
    ["e", 8, 10, 6, 4.5, "#6a6afc"],
    ["e", 8, 12.5, 4, 2.2, "#fcfcfc"],
    ["l", 5, 9, 5, 10, PUPIL], ["l", 10, 9, 10, 10, PUPIL],
    ["d", 8, 11, PUPIL],
  ],
  flat: [PUPIL, "#fc7878"],
};

const dorimon: SpriteDef = {
  size: 16,
  shapes: [
    ["p", [3, 8, 4, 3, 7, 6], "#6466b0"], ["p", [10, 6, 12, 2, 13, 7], "#6466b0"], ["d", 12, 3, "#fca818"],
    ["p", [1, 10, 0, 8, 3, 9], "#6466b0"],
    ["e", 8, 10, 6.5, 4.5, "#6466b0"],
    ["p", [4, 11, 13, 11, 12, 14, 6, 14], "#d6d6e4"],
    ["l", 5, 12, 12, 12, PUPIL], ["d", 6, 13, W], ["d", 8, 13, W], ["d", 10, 13, W],
    ["d", 10, 9, "#cc2430"], ["d", 11, 9, "#e46024"], ["d", 9, 7, "#fca818"],
  ],
  flat: [PUPIL, W, "#cc2430", "#e46024", "#fca818"],
};

const dorumon: SpriteDef = {
  size: 32,
  shapes: [
    // cauda peluda
    ["p", [12, 22, 4, 17, 2, 9, 5, 4, 9, 8, 10, 14, 15, 19], DO],
    ["p", [2, 9, 5, 4, 6, 9], DO_W],
    ["l", 6, 15, 9, 18, DO_D],
    ["p", [12, 15, 7, 10, 13, 13], "#9c88e8"],
    ["e", 13, 25, 4, 4, DO_D], ["r", 10, 27, 6, 2, DO_D],
    ["d", 10, 28, CLAW], ["d", 12, 28, CLAW], ["d", 14, 28, CLAW],
    ["e", 16, 20, 6, 6.5, DO],
    ["e", 18.5, 22, 3.5, 4.5, DO_W],
    ["r", 21, 23, 3, 6, DO_D], ["d", 21, 28, CLAW], ["d", 23, 28, CLAW],
    ["r", 19, 22, 3, 7, DO], ["d", 19, 28, CLAW], ["d", 21, 29, CLAW],
    // orelhas pontudas com miolo laranja
    ["p", [16, 8, 13, 1, 18, 6], DO], ["d", 15, 4, "#e4480c"],
    ["p", [20, 6, 21, 0, 24, 6], DO], ["d", 21, 3, "#e4480c"],
    ["e", 21, 11, 6, 5, DO],
    ["p", [22, 11, 29, 12, 30, 14, 28, 16, 22, 16], DO],
    ["p", [21, 15, 28, 15, 26, 17, 21, 17], DO_W],
    ["l", 22, 15, 28, 15, K],
    // a "interface antiga" na testa
    ["d", 23, 8, DO_GEM], ["d", 24, 8, DO_GEM], ["d", 24, 7, "#ff8a5c"],
    ["d", 25, 10, "#cc2430"], ["d", 26, 10, PUPIL],
  ],
  flat: [CLAW, DO_GEM, "#e4480c", "#ff8a5c", "#cc2430", PUPIL],
};

const dorugamon: SpriteDef = {
  size: 40,
  shapes: [
    // asas de morcego com membrana clara
    ["p", [16, 19, 6, 8, 2, 7, 8, 15, 2, 15, 10, 23], DG_WING],
    ["p", [15, 19, 7, 10, 9, 15, 11, 20], "#b4cccc"],
    ["p", [24, 19, 37, 6, 39, 9, 32, 16, 38, 16, 28, 22], DG_WING],
    ["p", [26, 19, 35, 9, 31, 15, 28, 20], "#b4cccc"],
    ["p", [12, 30, 3, 34, 2, 38, 9, 36, 15, 33], DG_BODY],
    ["l", 5, 35, 8, 33, "#7860c0"],
    ["e", 15, 29, 5, 5, DG_DARK], ["r", 12, 32, 5, 4, DG_DARK], ["r", 10, 35, 8, 3, "#fcfcfc"],
    ["d", 10, 37, "#d02424"], ["d", 12, 37, "#d02424"], ["d", 14, 37, "#d02424"],
    ["e", 19, 25, 7, 8, DG_BODY],
    ["e", 21.5, 23.5, 4, 6, "#eef2f4"],
    ["l", 13, 21, 15, 25, "#7860c0"], ["l", 13, 27, 16, 29, "#7860c0"],
    ["e", 23, 29, 5, 5, DG_BODY], ["r", 22, 32, 4, 4, DG_BODY], ["r", 21, 35, 8, 3, "#fcfcfc"],
    ["d", 22, 37, "#d02424"], ["d", 25, 37, "#d02424"], ["d", 28, 37, "#d02424"],
    ["p", [23, 20, 29, 22, 31, 26, 28, 27, 25, 24], DG_BODY],
    ["d", 31, 27, "#d02424"], ["d", 32, 26, "#d02424"], ["d", 30, 28, "#d02424"],
    ["p", [19, 10, 17, 3, 21, 8], DG_BODY], ["p", [22, 8, 24, 2, 25, 8], DG_BODY],
    ["e", 22, 12, 5, 4.5, DG_BODY],
    ["p", [22, 11, 31, 12, 32, 14, 30, 16, 22, 16], DG_BODY],
    ["p", [22, 15, 30, 15, 28, 18, 22, 18], "#eef2f4"],
    ["l", 23, 15, 30, 15, K],
    ["l", 19, 13, 20, 16, "#7860c0"],
    ["d", 25, 9, DO_GEM], ["d", 26, 11, "#d02424"],
  ],
  flat: ["#d02424", DO_GEM, "#7860c0", "#b4cccc"],
};

const doruguremon: SpriteDef = {
  size: 40,
  shapes: [
    ["p", [18, 15, 4, 4, 2, 10, 7, 12, 1, 18, 8, 19, 3, 25, 14, 23], "#dfe5e5"],
    ["l", 17, 15, 4, 5, DG_DARK], ["l", 16, 17, 2, 18, DG_DARK], ["l", 15, 19, 4, 24, DG_DARK],
    ["p", [24, 12, 37, 2, 39, 8, 34, 10, 39, 16, 30, 17], "#dfe5e5"],
    ["l", 25, 12, 37, 3, DG_DARK], ["l", 27, 14, 38, 15, DG_DARK],
    ["p", [10, 31, 2, 36, 1, 39, 7, 38, 14, 34], "#d80000"],
    ["e", 15, 30, 5, 5, "#902430"], ["r", 12, 33, 5, 3, "#902430"], ["r", 10, 35, 8, 3, "#f0f0f0"],
    ["d", 10, 37, DG_DARK], ["d", 13, 37, DG_DARK], ["d", 16, 37, DG_DARK],
    ["e", 20, 25, 9, 8, "#d80000"],
    ["e", 22.5, 27, 5, 5, "#f0f0f0"], ["e", 21, 26, 3, 3, "#d80000"],
    // espinhos dourados nas costas
    ["p", [13, 19, 12, 15, 15, 18], "#e0a030"], ["p", [16, 17, 16, 13, 18, 16], "#e0a030"], ["p", [19, 16, 20, 12, 21, 15], "#e0a030"],
    ["e", 24, 30, 5, 4, "#d80000"], ["r", 23, 32, 4, 3, "#d80000"], ["r", 22, 35, 8, 3, "#f0f0f0"],
    ["d", 22, 37, DG_DARK], ["d", 25, 37, DG_DARK], ["d", 28, 37, DG_DARK],
    ["p", [24, 21, 30, 23, 32, 27, 29, 28, 26, 25], "#d80000"],
    ["d", 32, 28, DG_DARK], ["d", 33, 27, DG_DARK],
    ["p", [21, 9, 23, 3, 25, 7, 27, 2, 28, 9], "#f0f0f0"],
    ["e", 26, 13, 5, 4, "#d80000"],
    ["p", [26, 12, 35, 13, 36, 15, 34, 17, 26, 17], "#d80000"],
    ["p", [26, 16, 34, 16, 32, 18, 26, 18], "#f0f0f0"],
    ["l", 27, 16, 34, 16, K],
    ["p", [27, 9, 31, 3, 30, 9], DG_DARK],
    ["d", 28, 12, GU_EYE], ["d", 29, 12, PUPIL], ["d", 26, 10, DO_GEM],
  ],
  flat: [DG_DARK, GU_EYE, PUPIL, DO_GEM],
};

const alphamon: SpriteDef = {
  size: 40,
  shapes: [
    // capa azul com forro claro
    ["p", [10, 10, 30, 10, 35, 37, 27, 33, 20, 38, 13, 33, 5, 37], "#2454c0"],
    ["p", [30, 12, 35, 37, 31, 35], "#d8d8f0"],
    ["p", [11, 14, 29, 14, 31, 30, 20, 34, 9, 30], "#0c3090"],
    ["r", 15, 26, 4, 10, "#2a2a30"], ["r", 21, 26, 4, 10, "#2a2a30"],
    ["d", 16, 29, "#f0f060"], ["d", 22, 29, "#f0f060"],
    ["p", [14, 35, 20, 35, 20, 38, 13, 38], "#907818"], ["p", [20, 35, 26, 35, 27, 38, 20, 38], "#907818"],
    ["r", 14, 15, 12, 12, "#303036"],
    ["l", 14, 17, 25, 17, "#f0f060"], ["l", 20, 17, 20, 25, "#907818"], ["e", 20, 20, 1.3, 1.3, "#d8303c"],
    ["r", 14, 25, 12, 1, "#f0f060"],
    // ombreiras grandes
    ["e", 12, 15, 5, 4, "#242428"], ["e", 28, 15, 5, 4, "#242428"],
    ["l", 8, 13, 15, 12, "#f0f060"], ["l", 25, 12, 32, 13, "#f0f060"],
    ["r", 9, 18, 4, 8, "#2a2a30"], ["r", 27, 18, 4, 8, "#2a2a30"],
    ["r", 9, 23, 4, 2, "#907818"], ["r", 27, 23, 4, 2, "#907818"],
    ["e", 20, 9, 4.5, 5, "#242428"],
    ["l", 17, 7, 23, 7, "#f0f060"], ["d", 19, 9, "#ff2a2a"], ["d", 22, 9, "#ff2a2a"],
    ["p", [18, 5, 20, 0, 22, 5], "#f0f060"],
    ["p", [16, 6, 13, 2, 17, 5], "#907818"], ["p", [24, 6, 27, 2, 23, 5], "#907818"],
  ],
  flat: ["#f0f060", "#ff2a2a", "#d8303c", "#907818"],
};

export const SPRITE_DEFS: Record<string, SpriteDef> = {
  "digitama-agumon": eggDef("#fbf6ea", "#f08a24", "spots"),
  "digitama-guilmon": eggDef("#fdf1ec", "#d8263a", "stripes"),
  "digitama-dorumon": eggDef("#eeeaff", "#6a52d0", "stars"),
  botamon, koromon, agumon, greymon, metalgreymon, wargreymon,
  jyarimon, gigimon, guilmon, growlmon, wargrowlmon, gallantmon,
  dodomon, dorimon, dorumon, dorugamon, doruguremon, alphamon,
};

// ── Rasterização ─────────────────────────────────────────────────────────────

function inPoly(pts: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [pts[i], pts[i + 1], pts[j], pts[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function line(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)));
  const [r, g, b] = [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function rasterize(def: SpriteDef): Sprite {
  const n = def.size;
  const px: (string | null)[] = new Array(n * n).fill(null);
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && y >= 0 && x < n && y < n) px[y * n + x] = c;
  };
  for (const s of def.shapes) {
    switch (s[0]) {
      case "e": {
        const [, cx, cy, rx, ry, c] = s;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
            if (dx * dx + dy * dy <= 1) set(x, y, c);
          }
        break;
      }
      case "r":
        for (let y = s[2]; y < s[2] + s[4]; y++) for (let x = s[1]; x < s[1] + s[3]; x++) set(x, y, s[5]);
        break;
      case "p":
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (inPoly(s[1], x + 0.5, y + 0.5)) set(x, y, s[2]);
        break;
      case "l":
        line(s[1], s[2], s[3], s[4], (x, y) => set(x, y, s[5]));
        break;
      case "d":
        set(s[1], s[2], s[3]);
        break;
    }
  }
  // Sombra embaixo/direita, brilho em cima/esquerda — luz vinda do alto à esquerda.
  const flat = new Set([...(def.flat ?? []), OUTLINE]);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= n || y >= n ? null : px[y * n + x]);
  const shaded = px.slice();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = px[y * n + x];
      if (!c || flat.has(c)) continue;
      if (!at(x + 1, y) || !at(x, y + 1)) shaded[y * n + x] = shade(c, -0.22);
      else if (!at(x - 1, y) || !at(x, y - 1)) shaded[y * n + x] = shade(c, 0.18);
    }
  // Contorno: todo pixel vazio encostado (4 vizinhos) num pixel cheio.
  const out = shaded.slice();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (shaded[y * n + x]) continue;
      if (at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1)) out[y * n + x] = OUTLINE;
    }
  return { size: n, px: out };
}

const cache = new Map<string, Sprite>();

export function sprite(id: string): Sprite {
  let s = cache.get(id);
  if (!s) {
    s = rasterize(SPRITE_DEFS[id] ?? SPRITE_DEFS["digitama-agumon"]);
    cache.set(id, s);
  }
  return s;
}

// ── Notas musicais e efeitos pequenos (grades ASCII) ─────────────────────────

export const NOTE_EIGHTH = [
  "..kkk.",
  "..kxkk",
  "..k..k",
  "..k...",
  ".kk...",
  "kxk...",
  "kkk...",
];

export const NOTE_BEAMED = [
  ".kkkkkk",
  ".kxxxxk",
  ".k....k",
  ".k....k",
  "kk...kk",
  "xk..kxk",
  "kk..kkk",
];

export const HEART = [".kk.kk.", "kxxkxxk", "kxxxxxk", ".kxxxk.", "..kxk..", "...k..."];
export const EXCLAIM = ["kkk", "kxk", "kxk", "kxk", "kkk", "kxk", "kkk"];
export const ZZZ = ["kkkk", "..k.", ".k..", "kkkk"];
