// Desenho em canvas. Duas fontes de sprite:
//  1. Pacotes da pasta local de sprites (`<id>/idle.png`, `attack.png`, `hit.png`,
//     baixados por scripts/fetch-sprites.mjs, ou `<id>.png` seu): sprites reais,
//     com fundo removido, bordas recortadas e silhuetas para os efeitos.
//  2. O desenho em código de sprites.ts, quando não há pacote (e para os ovos).
import { sprite } from "./sprites";
import { walkFrames } from "./walk";
import type { ArtAnim } from "./art.gen";

export type Pose = "idle" | "attack" | "hit" | "walk";

interface Frame {
  normal: HTMLCanvasElement;
  white: HTMLCanvasElement;
  red: HTMLCanvasElement;
  w: number;
  h: number;
  /** Ciclo de passos gerado a partir da pose parada (só nela). */
  walk?: HTMLCanvasElement[];
  /** Respiração gerada (só quando não há o idle do jogo). */
  breath?: HTMLCanvasElement[];
  /** Idle do jogo (folhas do DS): os quadros e o deslocamento de cada um em
   *  relação ao primeiro, para não tremer entre quadros. */
  cycle?: { canvas: HTMLCanvasElement; ox: number; oy: number }[];
  /** Ordem de vaivém dos quadros do idle (0,1,2,1,…), calculada uma vez. */
  seq?: number[];
}

/**
 * Para onde o sprite olha no arquivo (1 = direita), redução de arte ampliada e,
 * nos grandes, o centro do rosto (px do quadro 0 do idle) para o retrato: o
 * ponto mais alto deles costuma ser asa, capa ou lança, não a cabeça.
 */
const PACK_INFO: Record<string, { face: 1 | -1; down?: number; head?: [number, number] }> = {
  botamon: { face: -1 }, koromon: { face: -1 }, agumon: { face: -1 }, greymon: { face: 1, head: [50, 35] },
  metalgreymon: { face: 1, head: [68, 42] }, wargreymon: { face: -1 },
  jyarimon: { face: -1 }, gigimon: { face: -1 }, guilmon: { face: 1 }, growlmon: { face: 1, head: [40, 26] },
  wargrowlmon: { face: 1, head: [43, 40] }, gallantmon: { face: -1, head: [62, 40] },
  dodomon: { face: 1, down: 4 }, dorimon: { face: -1 }, dorumon: { face: 1 }, dorugamon: { face: -1, head: [26, 60] },
  doruguremon: { face: 1, head: [42, 50] }, alphamon: { face: -1, head: [40, 32] },
};

/** Altura alvo (px) por estágio, no tamanho "Normal". */
const TARGET_H = [44, 44, 56, 84, 112, 128, 140];
const SIZE_FACTOR: Record<number, number> = { 3: 0.75, 4: 1, 5: 1.35, 6: 1.7 };

let loaded = new Map<string, Partial<Record<Pose, Frame>>>();
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
  if (x1 < 0) {
    release(c);
    throw new Error("sprite vazio");
  }
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
  release(c);
  return { normal: out, white: tinted(out, "#ffffff"), red: tinted(out, "#ff3b3b"), w, h };
}

/** Solta a memória de um canvas na hora, sem esperar o coletor de lixo. */
function release(...list: (HTMLCanvasElement | undefined)[]) {
  for (const c of list) if (c) c.width = c.height = 0;
}

function releaseFrame(f: Frame | undefined) {
  if (!f) return;
  release(f.normal, f.white, f.red, ...(f.walk ?? []), ...(f.breath ?? []), ...(f.cycle ?? []).map((c) => c.canvas));
}

/**
 * Os sprites de batalha do DS não têm quadros de caminhada: o ciclo de passos
 * sai dos próprios pixels da pose parada (src/pet/walk.ts). Sem pés separáveis,
 * ou se um quadro esconderia mais de 5% do desenho, não há ciclo e o Digimon
 * anda só com o balanço do corpo.
 */
function makeWalk(src: HTMLCanvasElement, face: 1 | -1): HTMLCanvasElement[] | undefined {
  const w = src.width, h = src.height;
  const pixels = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const frames = walkFrames({ width: w, height: h, data: pixels.data }, face);
  return frames?.map((f) => {
    const c = canvas(w, h);
    c.getContext("2d")!.putImageData(new ImageData(f.data, w, h), 0, 0);
    return c;
  });
}

/**
 * Respiração em quadros, como os spritistas fazem: o tronco *estica* 1–2 px.
 * A parte de cima sobe e a linha de junção se repete no vão — nenhum pixel do
 * desenho é apagado ou sobreposto. Os quadros têm 2 px a mais de altura (em
 * cima); o desenho continua apoiado pelos pés.
 */
const BREATH_PAD = 2;
function makeBreath(src: HTMLCanvasElement): HTMLCanvasElement[] {
  const w = src.width, h = src.height;
  const split = Math.round(h * 0.6);
  const offsets = [0, 1, h >= 80 ? 2 : 1];
  return offsets.map((k) => {
    const c = canvas(w, h + BREATH_PAD);
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const top = BREATH_PAD - k;
    // de baixo: fica onde está
    g.drawImage(src, 0, split, w, h - split, 0, BREATH_PAD + split, w, h - split);
    // de cima: sobe k px
    g.drawImage(src, 0, 0, w, split, 0, top, w, split);
    // o vão de k linhas repete a última linha da parte de cima
    for (let i = 0; i < k; i++) g.drawImage(src, 0, split - 1, w, 1, 0, top + split + i, w, 1);
    return c;
  });
}

/**
 * Onde o quadro `b` se encaixa sobre `a`: o deslocamento (±8 px) com mais
 * pixels iguais entre os dois, medido pelos pés para cima (base alinhada).
 */
function bestOffset(a: HTMLCanvasElement, b: HTMLCanvasElement): [number, number] {
  const ga = a.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, a.width, a.height).data;
  const gb = b.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, b.width, b.height).data;
  let best: [number, number] = [0, 0];
  let bestScore = -1;
  const baseY = a.height - b.height; // base com base
  const baseX = Math.round((a.width - b.width) / 2);
  for (let dy = -8; dy <= 8; dy++)
    for (let dx = -8; dx <= 8; dx++) {
      let score = 0;
      for (let y = 0; y < b.height; y += 2)
        for (let x = 0; x < b.width; x += 2) {
          const ax = x + baseX + dx, ay = y + baseY + dy;
          if (ax < 0 || ay < 0 || ax >= a.width || ay >= a.height) continue;
          const ib = (y * b.width + x) * 4, ia = (ay * a.width + ax) * 4;
          if (gb[ib + 3] < 128 || ga[ia + 3] < 128) continue;
          if (Math.abs(ga[ia] - gb[ib]) + Math.abs(ga[ia + 1] - gb[ib + 1]) + Math.abs(ga[ia + 2] - gb[ib + 2]) < 24) score++;
        }
      if (score > bestScore) {
        bestScore = score;
        best = [baseX + dx, baseY + dy];
      }
    }
  return best;
}

let loading = 0;

/**
 * Carrega os pacotes vindos do backend (`id` ou `id/pose` → data URL). Monta
 * tudo à parte e troca de uma vez (o pet nunca fica sem sprite no meio), e
 * solta na hora os quadros antigos: são centenas de canvas por linha.
 */
export async function loadPacks(map: Record<string, string>) {
  const ticket = ++loading;
  const packs = new Map<string, Partial<Record<Pose, Frame>>>();
  const cycles = new Map<string, { n: number; frame: Frame }[]>();
  await Promise.all(
    Object.entries(map).map(async ([key, url]) => {
      const [id, rawPose = "idle"] = key.split("/");
      const m = /^idle_(\d+)$/.exec(rawPose);
      if (m) {
        try {
          const frame = await processFrame(url, PACK_INFO[id]?.down ?? 1);
          const list = cycles.get(id) ?? [];
          list.push({ n: Number(m[1]), frame });
          cycles.set(id, list);
        } catch {
          /* quadro inválido: ignora */
        }
        return;
      }
      const pose = rawPose;
      if (!["idle", "attack", "hit"].includes(pose)) return;
      try {
        const frame = await processFrame(url, PACK_INFO[id]?.down ?? 1);
        if (pose === "idle") frame.walk = makeWalk(frame.normal, PACK_INFO[id]?.face ?? -1);
        frame.breath = makeBreath(frame.normal);
        const entry = packs.get(id) ?? {};
        entry[pose as Pose] = frame;
        packs.set(id, entry);
      } catch {
        /* arquivo inválido: fica o desenho em código */
      }
    }),
  );
  // o idle do jogo: o quadro 0 vira a pose parada, e cada quadro é alinhado a ele
  for (const [id, list] of cycles) {
    list.sort((a, b) => a.n - b.n);
    if (list.length < 2) continue;
    const first = list[0].frame;
    const entry = packs.get(id) ?? {};
    // a pose parada passa a ser o quadro 0 (mesma arte da folha)
    releaseFrame(entry.idle);
    entry.idle = { ...first, walk: makeWalk(first.normal, PACK_INFO[id]?.face ?? -1) };
    entry.idle.cycle = list.map(({ frame }, i) => {
      const [ox, oy] = i === 0 ? [0, 0] : bestOffset(first.normal, frame.normal);
      // dos outros quadros só o desenho normal é usado
      if (i > 0) release(frame.white, frame.red);
      return { canvas: frame.normal, ox, oy };
    });
    const n = list.length;
    entry.idle.seq = [...Array(n).keys(), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)];
    packs.set(id, entry);
  }
  const old = loaded;
  if (ticket !== loading) {
    // outra carga começou depois desta: a dela vale
    for (const entry of packs.values()) Object.values(entry).forEach(releaseFrame);
    return;
  }
  loaded = packs;
  for (const entry of old.values()) Object.values(entry).forEach(releaseFrame);
}

export function hasPack(id: string) {
  return !!loaded.get(id)?.idle;
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
  const p = loaded.get(id);
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
  /** Tempo do idle do jogo (índice de quadro que cresce sempre). */
  cycle?: number;
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
  /** Grade desenhada por cima, em pixels do sprite (rachaduras do ovo). */
  overlay?: string[];
}

/** Desenha o Digimon e devolve a caixa ocupada (para o clique-através). */
export function drawMon(g: CanvasRenderingContext2D, id: string, o: DrawOpts): [number, number, number, number] {
  const f = frameFor(id, o.pose ?? "idle");
  const native = hasPack(id) ? (PACK_INFO[id]?.face ?? -1) : 1;
  const flip = (o.facing ?? native) !== native;
  const w = f.w * o.scale, h = f.h * o.scale;
  const sx = o.sx ?? 1, sy = o.sy ?? 1;
  // idle do jogo: vai e volta pelos quadros (0,1,2,1,…), cada um no seu encaixe
  let ox = 0, oy = 0;
  let body: HTMLCanvasElement = f.normal;
  if ((o.pose ?? "idle") === "idle" && f.cycle && f.seq && o.cycle != null) {
    const seq = f.seq;
    const c = f.cycle[seq[((o.cycle % seq.length) + seq.length) % seq.length]];
    body = c.canvas;
    ox = c.ox;
    oy = c.oy;
  } else if (o.pose === "walk" && f.walk) {
    body = f.walk[(o.step ?? 0) % f.walk.length];
  } else if (f.breath && o.breath) {
    body = f.breath[Math.max(0, Math.min(f.breath.length - 1, o.breath))];
  }
  // rastro: cópias translúcidas atrás, as mais distantes mais apagadas
  (o.ghosts ?? []).forEach((gx, i) => {
    g.save();
    g.imageSmoothingEnabled = false;
    g.globalAlpha = (o.alpha ?? 1) * (0.42 - i * 0.12);
    g.translate(Math.round(o.x + gx), Math.round(o.y));
    g.scale(flip ? -1 : 1, 1);
    g.drawImage(body, -Math.round((body.width * o.scale) / 2), -body.height * o.scale, body.width * o.scale, body.height * o.scale);
    g.restore();
  });
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = o.alpha ?? 1;
  g.translate(Math.round(o.x), Math.round(o.y));
  if (o.rot) g.rotate(o.rot);
  g.scale((flip ? -1 : 1) * sx, sy);
  // cada quadro com o próprio tamanho (os de respiração são um pouco mais altos);
  // os do idle do jogo entram no encaixe calculado em relação ao quadro 0
  const bw = body.width * o.scale, bh = body.height * o.scale;
  if (f.cycle && body !== f.normal && (o.pose ?? "idle") === "idle") {
    g.drawImage(body, -Math.round(w / 2) + ox * o.scale, -h + oy * o.scale, bw, bh);
  } else {
    g.drawImage(body, -Math.round(bw / 2), -bh, bw, bh);
  }
  if (o.overlay) drawGrid(g, o.overlay, -Math.round(bw / 2), -bh, o.scale, "#1a1222");
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

/** Onde está o rosto: o centro do desenho no alto do sprite (x, e a primeira linha com pixels). */
const faces = new Map<string, { x: number; top: number }>();
function faceOf(id: string, f: Frame) {
  let face = faces.get(id);
  if (face) return face;
  const data = f.normal.getContext("2d")!.getImageData(0, 0, f.w, f.h).data;
  let top = -1, sum = 0, n = 0;
  for (let y = 0; y < f.h && (top < 0 || y < top + Math.max(8, f.h * 0.35)); y++)
    for (let x = 0; x < f.w; x++)
      if (data[(y * f.w + x) * 4 + 3] > 16) {
        if (top < 0) top = y;
        sum += x;
        n++;
      }
  face = { x: n ? sum / n : f.w / 2, top: Math.max(0, top) };
  faces.set(id, face);
  return face;
}

/**
 * Desenha cabendo numa caixa (miniaturas do chat e das configurações). Se o
 * Digimon cabe em escala inteira, inteiro; se não (os Supremos têm até 152 px
 * de alto), o rosto em tamanho real: encolher pixel art abaixo de 1× apaga os
 * pixels, então o retrato é um recorte do alto do sprite, como nos jogos.
 */
export function drawMonFit(g: CanvasRenderingContext2D, id: string, cx: number, bottom: number, maxW: number, maxH: number) {
  const f = frameFor(id, "idle");
  const scale = Math.min(maxW / f.w, maxH / f.h);
  if (scale >= 1) {
    drawMon(g, id, { x: cx, y: bottom, scale: Math.floor(scale) });
    return;
  }
  const w = Math.min(f.w, Math.floor(maxW)), h = Math.min(f.h, Math.floor(maxH));
  const head = PACK_INFO[id]?.head;
  // o rosto um pouco acima do meio do retrato; sem a marca, o alto do desenho
  const [fx, fy] = head ?? [faceOf(id, f).x, faceOf(id, f).top + h * 0.45];
  const sx = Math.round(Math.max(0, Math.min(f.w - w, fx - w / 2)));
  const sy = Math.round(Math.max(0, Math.min(f.h - h, fy - h * 0.45)));
  g.save();
  g.imageSmoothingEnabled = false;
  g.drawImage(f.normal, sx, sy, w, h, Math.round(cx - w / 2), Math.round(bottom - h), w, h);
  g.restore();
}

/**
 * Grade ASCII (as de art.gen.ts): "k" contorno, "w" branco, "x" preenchimento,
 * "y" cor clara, "." vazio. `flip` espelha na horizontal (golpe para a esquerda).
 */
export function drawGrid(
  g: CanvasRenderingContext2D,
  grid: string[],
  x: number,
  y: number,
  px: number,
  fill: string,
  outline = "#1a1222",
  light = fill,
  flip = false,
) {
  grid.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === ".") continue;
      g.fillStyle = ch === "k" ? outline : ch === "w" ? "#ffffff" : ch === "y" ? light : fill;
      const col = flip ? row.length - 1 - rx : rx;
      g.fillRect(Math.round(x + col * px), Math.round(y + ry * px), px, px);
    }
  });
}

/** O quadro de uma animação de art.gen.ts em `ms`: em laço, ou parando no último. */
export function artFrame(anim: ArtAnim, ms: number, loop = true): string[] {
  const total = anim.ms.reduce((a, b) => a + b, 0);
  let t = loop ? ((ms % total) + total) % total : Math.min(Math.max(0, ms), total - 1);
  for (let i = 0; i < anim.frames.length; i++) {
    if (t < anim.ms[i]) return anim.frames[i];
    t -= anim.ms[i];
  }
  return anim.frames[anim.frames.length - 1];
}

const eggCache = new Map<string, { lid: HTMLCanvasElement; base: HTMLCanvasElement }>();

/**
 * O ovo (desenho em código) partido na rachadura: a tampa (com a linha da
 * rachadura) e a base. Os pixels são os do próprio ovo.
 */
export function eggPieces(id: string, crack: string[]) {
  const key = `${id}:${crack.join("")}`;
  const hit = eggCache.get(key);
  if (hit) return hit;
  const egg = codeCanvas(id, "normal");
  const w = egg.width, h = egg.height;
  // em cada coluna, a altura da rachadura (as colunas sem ela copiam a vizinha)
  const cut: (number | null)[] = Array.from({ length: w }, (_, x) => {
    const ys = crack.map((row, y) => (row[x] === "k" ? y : -1)).filter((y) => y >= 0);
    return ys.length ? Math.max(...ys) : null;
  });
  for (let pass = 0; pass < w; pass++)
    for (let x = 0; x < w; x++) cut[x] ??= cut[x - 1] ?? cut[x + 1] ?? null;
  const lid = canvas(w, h), base = canvas(w, h);
  const lg = lid.getContext("2d")!, bg = base.getContext("2d")!;
  for (let x = 0; x < w; x++) {
    const c = cut[x] ?? Math.floor(h / 2);
    lg.drawImage(egg, x, 0, 1, c + 1, x, 0, 1, c + 1);
    bg.drawImage(egg, x, c + 1, 1, h - c - 1, x, c + 1, 1, h - c - 1);
  }
  drawGrid(lg, crack, 0, 0, 1, "#1a1222");
  const pieces = { lid, base };
  eggCache.set(key, pieces);
  return pieces;
}

/** Desenha um canvas inteiro (pedaço de casca) girando em volta de `pivot` (0 = topo, 1 = base). */
export function drawPiece(g: CanvasRenderingContext2D, c: HTMLCanvasElement, x: number, y: number, scale: number, rot = 0, alpha = 1, pivot = 1) {
  const w = c.width * scale, h = c.height * scale;
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = Math.max(0, Math.min(1, alpha));
  g.translate(Math.round(x), Math.round(y - h * (1 - pivot)));
  if (rot) g.rotate(rot);
  g.drawImage(c, -Math.round(w / 2), -Math.round(h * pivot), w, h);
  g.restore();
}

/** Disco pixelado de raio `r` (em px de efeito), centro em (cx, cy). */
export function pixelDisc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, px: number, color: string) {
  g.fillStyle = color;
  const n = Math.ceil(r);
  for (let dy = -n; dy <= n; dy++)
    for (let dx = -n; dx <= n; dx++)
      if (dx * dx + dy * dy <= r * r) g.fillRect(Math.round(cx + dx * px), Math.round(cy + dy * px), px, px);
}
