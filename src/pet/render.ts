// Desenho em canvas. Duas fontes de sprite:
//  1. Pacotes da pasta local de sprites (`<id>/idle.png`, `attack.png`, `hit.png`,
//     baixados por scripts/fetch-sprites.mjs, ou `<id>.png` seu): sprites reais,
//     com fundo removido, bordas recortadas e silhuetas para os efeitos.
//  2. O desenho em código de sprites.ts, quando não há pacote (e para os ovos).
import { sprite } from "./sprites";

export type Pose = "idle" | "attack" | "hit" | "walk";

interface Frame {
  normal: HTMLCanvasElement;
  white: HTMLCanvasElement;
  red: HTMLCanvasElement;
  w: number;
  h: number;
  /** Ciclo de passos gerado a partir da pose parada (só nela). */
  walk?: HTMLCanvasElement[];
  /** Respiração: [solto, -1 px, -2 px] — a cabeça e o tronco descem e sobem. */
  breath?: HTMLCanvasElement[];
}

/** Para onde o sprite olha no arquivo (1 = direita) e redução de arte ampliada. */
const PACK_INFO: Record<string, { face: 1 | -1; down?: number }> = {
  botamon: { face: -1 }, koromon: { face: -1 }, agumon: { face: -1 }, greymon: { face: 1 },
  metalgreymon: { face: 1 }, wargreymon: { face: -1 },
  jyarimon: { face: -1 }, gigimon: { face: -1 }, guilmon: { face: 1 }, growlmon: { face: 1 },
  wargrowlmon: { face: 1 }, gallantmon: { face: -1 },
  dodomon: { face: 1, down: 4 }, dorimon: { face: -1 }, dorumon: { face: 1 }, dorugamon: { face: -1 },
  doruguremon: { face: 1 }, alphamon: { face: -1 },
};

/** Altura alvo (px) por estágio, no tamanho "Normal". */
const TARGET_H = [44, 44, 56, 84, 112, 128, 140];
const SIZE_FACTOR: Record<number, number> = { 3: 0.75, 4: 1, 5: 1.35, 6: 1.7 };

const packs = new Map<string, Partial<Record<Pose, Frame>>>();
const codeCache = new Map<string, HTMLCanvasElement>();

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = url;
  });
}

function tinted(src: HTMLCanvasElement, color: string) {
  const c = canvas(src.width, src.height);
  const g = c.getContext("2d")!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Fundo sólido vira transparente (cor do canto), recorta e reduz se preciso. */
async function processFrame(url: string, down = 1): Promise<Frame> {
  const img = await loadImage(url);
  const c = canvas(img.naturalWidth, img.naturalHeight);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  if (px[3] === 255) {
    const [r, gg, b] = [px[0], px[1], px[2]];
    for (let i = 0; i < px.length; i += 4) if (px[i] === r && px[i + 1] === gg && px[i + 2] === b) px[i + 3] = 0;
  }
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (px[(y * c.width + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("sprite vazio");
  g.putImageData(data, 0, 0);
  const w = Math.ceil((x1 - x0 + 1) / down), h = Math.ceil((y1 - y0 + 1) / down);
  const out = canvas(w, h);
  const og = out.getContext("2d")!;
  og.imageSmoothingEnabled = false;
  if (down > 1) {
    // arte ampliada (ex.: dot 8×): uma amostra do meio de cada bloco
    const src = g.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    const dst = og.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(src.width - 1, x * down + (down >> 1)), sy = Math.min(src.height - 1, y * down + (down >> 1));
        const si = (sy * src.width + sx) * 4, di = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) dst.data[di + k] = src.data[si + k];
      }
    og.putImageData(dst, 0, 0);
  } else {
    og.drawImage(c, x0, y0, w, h, 0, 0, w, h);
  }
  return { normal: out, white: tinted(out, "#ffffff"), red: tinted(out, "#ff3b3b"), w, h };
}

/**
 * Os sprites de batalha do DS não têm quadros de caminhada; este ciclo de 4
 * passos é feito a partir da pose parada: a faixa das pernas é dividida ao meio
 * e cada metade sobe alternadamente, com o corpo descendo 1 px a cada passo.
 */
function makeWalk(src: HTMLCanvasElement): HTMLCanvasElement[] {
  const w = src.width, h = src.height;
  // só a faixa dos pés sobe; o resto do corpo fica por baixo (sem buraco nem corte)
  const legTop = Math.round(h * 0.75);
  const lift = Math.max(2, Math.round(h * 0.06));
  const mid = Math.round(w / 2);
  const frames: HTMLCanvasElement[] = [];
  for (const phase of [0, 1, 2, 3]) {
    const c = canvas(w, h);
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const step = phase === 1 || phase === 3;
    // o corpo desce 1 px no passo (o peso cai na perna de apoio)
    g.drawImage(src, 0, step ? 1 : 0);
    if (step) {
      const x0 = phase === 1 ? 0 : mid, x1 = phase === 1 ? mid : w;
      // o pé que dá o passo: apaga embaixo e redesenha mais alto
      g.clearRect(x0, legTop, x1 - x0, h - legTop);
      g.drawImage(src, x0, legTop, x1 - x0, h - legTop, x0, legTop - lift + 1, x1 - x0, h - legTop);
    }
    frames.push(c);
  }
  return frames;
}

/**
 * Respiração em quadros, como num sprite de jogo: a parte de cima (acima de
 * ~55% da altura) desce 1 e 2 px sobre a de baixo; pés e base ficam parados.
 * Sprites pequenos só descem 1 px, para não "derreter".
 */
function makeBreath(src: HTMLCanvasElement): HTMLCanvasElement[] {
  const w = src.width, h = src.height;
  const split = Math.round(h * 0.55);
  const offsets = [0, 1, h >= 80 ? 2 : 1];
  return offsets.map((k) => {
    if (k === 0) return src;
    const c = canvas(w, h);
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, split, w, h - split, 0, split, w, h - split);
    g.drawImage(src, 0, 0, w, split, 0, k, w, split);
    return c;
  });
}

/** Carrega os pacotes vindos do backend (`id` ou `id/pose` → data URL). */
export async function loadPacks(map: Record<string, string>) {
  packs.clear();
  await Promise.all(
    Object.entries(map).map(async ([key, url]) => {
      const [id, pose = "idle"] = key.split("/");
      if (!["idle", "attack", "hit"].includes(pose)) return;
      try {
        const frame = await processFrame(url, PACK_INFO[id]?.down ?? 1);
        if (pose === "idle") frame.walk = makeWalk(frame.normal);
        frame.breath = makeBreath(frame.normal);
        const entry = packs.get(id) ?? {};
        entry[pose as Pose] = frame;
        packs.set(id, entry);
      } catch {
        /* arquivo inválido: fica o desenho em código */
      }
    }),
  );
}

export function hasPack(id: string) {
  return !!packs.get(id)?.idle;
}

function codeCanvas(id: string, variant: "normal" | "white" | "red") {
  const key = `${id}:${variant}`;
  let c = codeCache.get(key);
  if (c) return c;
  const sp = sprite(id);
  c = canvas(sp.size, sp.size);
  const g = c.getContext("2d")!;
  sp.px.forEach((col, i) => {
    if (!col) return;
    g.fillStyle = variant === "white" ? "#ffffff" : variant === "red" ? "#ff3b3b" : col;
    g.fillRect(i % sp.size, Math.floor(i / sp.size), 1, 1);
  });
  codeCache.set(key, c);
  return c;
}

function frameFor(id: string, pose: Pose): Frame {
  const p = packs.get(id);
  const f = (pose === "walk" ? p?.idle : p?.[pose]) ?? p?.idle;
  if (f) return f;
  const n = codeCanvas(id, "normal");
  return { normal: n, white: codeCanvas(id, "white"), red: codeCanvas(id, "red"), w: n.width, h: n.height };
}

/** Escala inteira do Digimon (pixels nítidos) para o estágio e o tamanho escolhido. */
export function monScale(id: string, stage: number, size = 4): number {
  const f = SIZE_FACTOR[size] ?? 1;
  if (hasPack(id)) {
    // passos de 0,5×: os sprites do DS têm tamanhos nativos bem diferentes
    const h = frameFor(id, "idle").h;
    return Math.max(1, Math.round(((TARGET_H[stage] * f) / h) * 2) / 2);
  }
  const s = sprite(id).size;
  return Math.max(2, Math.round(((s <= 16 ? 64 : s <= 32 ? 96 : 120) * f) / s));
}

/** Largura e altura na tela da pose parada. */
export function monBox(id: string, scale: number): { w: number; h: number } {
  const f = frameFor(id, "idle");
  return { w: f.w * scale, h: f.h * scale };
}

export interface DrawOpts {
  /** Centro horizontal e base (pés) em px CSS. */
  x: number;
  y: number;
  scale: number;
  pose?: Pose;
  /** Quadro do ciclo de passos (pose "walk"). */
  step?: number;
  /** Quadro de respiração (0..2). */
  breath?: number;
  /** Rastro: deslocamentos de cópias fantasmas (px, no sentido do mundo). */
  ghosts?: number[];
  /** Para onde deve olhar: 1 direita, -1 esquerda. */
  facing?: number;
  sx?: number;
  sy?: number;
  rot?: number;
  white?: number;
  red?: number;
  alpha?: number;
}

/** Desenha o Digimon e devolve a caixa ocupada (para o clique-através). */
export function drawMon(g: CanvasRenderingContext2D, id: string, o: DrawOpts): [number, number, number, number] {
  const f = frameFor(id, o.pose ?? "idle");
  const native = hasPack(id) ? (PACK_INFO[id]?.face ?? -1) : 1;
  const flip = (o.facing ?? native) !== native;
  const w = f.w * o.scale, h = f.h * o.scale;
  const sx = o.sx ?? 1, sy = o.sy ?? 1;
  const body =
    o.pose === "walk" && f.walk
      ? f.walk[(o.step ?? 0) % f.walk.length]
      : f.breath && o.breath
        ? f.breath[Math.max(0, Math.min(f.breath.length - 1, o.breath))]
        : f.normal;
  // rastro: cópias translúcidas atrás, as mais distantes mais apagadas
  (o.ghosts ?? []).forEach((gx, i) => {
    g.save();
    g.imageSmoothingEnabled = false;
    g.globalAlpha = (o.alpha ?? 1) * (0.42 - i * 0.12);
    g.translate(Math.round(o.x + gx), Math.round(o.y));
    g.scale(flip ? -1 : 1, 1);
    g.drawImage(body, -Math.round(w / 2), -h, w, h);
    g.restore();
  });
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = o.alpha ?? 1;
  g.translate(Math.round(o.x), Math.round(o.y));
  if (o.rot) g.rotate(o.rot);
  g.scale((flip ? -1 : 1) * sx, sy);
  g.drawImage(body, -Math.round(w / 2), -h, w, h);
  if (o.white) {
    g.globalAlpha = (o.alpha ?? 1) * Math.min(1, o.white);
    g.drawImage(f.white, -Math.round(w / 2), -h, w, h);
  }
  if (o.red) {
    g.globalAlpha = (o.alpha ?? 1) * Math.min(1, o.red);
    g.drawImage(f.red, -Math.round(w / 2), -h, w, h);
  }
  g.restore();
  return [o.x - (w * sx) / 2, o.y - h * sy, w * sx, h * sy];
}

/** Desenha cabendo numa caixa (miniaturas do chat e das configurações). */
export function drawMonFit(g: CanvasRenderingContext2D, id: string, cx: number, bottom: number, maxW: number, maxH: number) {
  const f = frameFor(id, "idle");
  const scale = Math.max(0.5, Math.min(maxW / f.w, maxH / f.h));
  const s = scale >= 1 ? Math.floor(scale) : scale;
  drawMon(g, id, { x: cx, y: bottom, scale: s });
}

/** Grade ASCII: "k" contorno, "x" preenchimento, "." vazio. */
export function drawGrid(g: CanvasRenderingContext2D, grid: string[], x: number, y: number, px: number, fill: string, outline = "#1a1222") {
  grid.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === ".") continue;
      g.fillStyle = ch === "k" ? outline : ch === "w" ? "#ffffff" : fill;
      g.fillRect(Math.round(x + rx * px), Math.round(y + ry * px), px, px);
    }
  });
}

/** Disco pixelado de raio `r` (em px de efeito), centro em (cx, cy). */
export function pixelDisc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, px: number, color: string) {
  g.fillStyle = color;
  const n = Math.ceil(r);
  for (let dy = -n; dy <= n; dy++)
    for (let dx = -n; dx <= n; dx++)
      if (dx * dx + dy * dy <= r * r) g.fillRect(Math.round(cx + dx * px), Math.round(cy + dy * px), px, px);
}
