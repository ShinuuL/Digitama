// Ciclo de passos feito só com os pixels do sprite de batalha: os sprites de
// batalha do DS não têm quadros de caminhada (os de mapa são outra arte, em
// outra escala). Cada pé é uma ilha de pixels na faixa de baixo do sprite; o
// pé que dá o passo sobe em dois tempos, avança 1 px no alto e desce.
//
// Nenhum pixel é inventado, redesenhado nem misturado: os quadros só
// *deslocam* pixels do original. Se num quadro menos de 95% do desenho
// original continua visível e intacto (o pé que sobe cobre um pouco da perna),
// a caminhada é recusada e o Digimon anda sem mexer as pernas (só o balanço do
// corpo). Puro, sem DOM: o pet e o scripts/check-walk.mjs usam exatamente isto.

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Quadros do ciclo: contato, sobe, alto, desce — um pé e depois o outro. */
export const WALK_PHASES = 8;
/** Fração mínima do desenho original que continua visível e intacta. */
export const MIN_FIDELITY = 0.95;

const ALPHA = 16;
/** Quanto cada grupo de pés está levantado (0..1) em cada quadro. */
const LIFT_A = [0, 0.5, 1, 0.5, 0, 0, 0, 0];
const LIFT_B = [0, 0, 0, 0, 0, 0.5, 1, 0.5];

interface Island {
  pixels: number[];
  x0: number;
  x1: number;
  bottom: number;
}

/** Ilhas de pixels (8 vizinhos) na faixa de baixo, de `top` até o fim. */
function islands(src: Raster, top: number): Island[] {
  const { width: w, height: h, data } = src;
  const seen = new Uint8Array(w * h);
  const out: Island[] = [];
  for (let y = top; y < h; y++)
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seen[start] || data[start * 4 + 3] <= ALPHA) continue;
      const isl: Island = { pixels: [], x0: x, x1: x, bottom: y };
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const px = i % w, py = (i - px) / w;
        isl.pixels.push(i);
        if (px < isl.x0) isl.x0 = px;
        if (px > isl.x1) isl.x1 = px;
        if (py > isl.bottom) isl.bottom = py;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || nx >= w || ny < top || ny >= h) continue;
            const j = ny * w + nx;
            if (seen[j] || data[j * 4 + 3] <= ALPHA) continue;
            seen[j] = 1;
            stack.push(j);
          }
      }
      out.push(isl);
    }
  return out;
}

/** Uma ilha larga (pés juntos) dividida na coluna mais vazia do meio dela. */
function split(isl: Island, w: number): Island[] {
  const count = new Map<number, number>();
  for (const i of isl.pixels) count.set(i % w, (count.get(i % w) ?? 0) + 1);
  const span = isl.x1 - isl.x0;
  let cut = -1, least = Infinity;
  for (let x = isl.x0 + Math.round(span * 0.3); x <= isl.x0 + Math.round(span * 0.7); x++) {
    const n = count.get(x) ?? 0;
    if (n < least) {
      least = n;
      cut = x;
    }
  }
  if (cut < 0) return [isl];
  const part = (keep: (x: number) => boolean): Island => {
    const pixels = isl.pixels.filter((i) => keep(i % w));
    const xs = pixels.map((i) => i % w);
    return { pixels, x0: Math.min(...xs), x1: Math.max(...xs), bottom: Math.max(...pixels.map((i) => Math.floor(i / w))) };
  };
  return [part((x) => x < cut), part((x) => x >= cut)];
}

/** Por que a caminhada foi recusada (para o scripts/check-walk.mjs). */
export interface WalkReport {
  reason?: string;
  feet?: number;
  /** Por quadro: fração do desenho original visível e intacta (o critério). */
  kept?: number[];
  /** Por quadro: fração idêntica no mesmo lugar (só informativo). */
  inPlace?: number[];
}

/** Altura da faixa dos pés (fração do sprite), da mais baixa para a mais alta. */
const BANDS = [0.2, 0.27, 0.34];

/**
 * Os pés: ilhas grandes da faixa de baixo que chegam à metade de baixo dela.
 * Não precisam encostar no chão: em perspectiva o pé de trás fica mais alto.
 * Ilhas pequenas (garras soltas, ponta de cauda) ficam paradas. Sem dois pés,
 * tenta uma faixa mais alta. No máximo quatro, da esquerda para a direita.
 */
export function findFeet(src: Raster) {
  const { width: w, height: h } = src;
  let found = { feet: [] as Island[], all: [] as Island[], top: h };
  for (const band of BANDS) {
    const top = h - Math.max(4, Math.round(h * band));
    const all = islands(src, top);
    const biggest = Math.max(0, ...all.map((i) => i.pixels.length));
    const low = top + (h - top) * 0.5;
    let feet = all.filter((i) => i.bottom >= low && i.pixels.length >= Math.max(6, biggest * 0.2));
    if (feet.length === 1 && feet[0].x1 - feet[0].x0 >= w * 0.35) feet = split(feet[0], w);
    feet = feet.sort((a, b) => b.pixels.length - a.pixels.length).slice(0, 4).sort((a, b) => a.x0 - b.x0);
    found = { feet, all, top };
    if (feet.length >= 2) break;
  }
  return found;
}

/** Fração dos pixels (do original ou do quadro) idênticos no mesmo lugar. */
export function inPlace(a: Raster, b: Raster): number {
  let same = 0, total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const oa = a.data[i + 3] > ALPHA, ob = b.data[i + 3] > ALPHA;
    if (!oa && !ob) continue;
    total++;
    if (oa && ob && a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) same++;
  }
  return total ? same / total : 1;
}

/** O mesmo pixel (cor e alfa) em `a[i]` e `b[j]`. */
const samePx = (a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number) =>
  a[i * 4] === b[j * 4] && a[i * 4 + 1] === b[j * 4 + 1] && a[i * 4 + 2] === b[j * 4 + 2] && a[i * 4 + 3] === b[j * 4 + 3];

/**
 * Os `WALK_PHASES` quadros da caminhada, do mesmo tamanho do original, ou
 * `null` quando não dá para achar os pés ou algum quadro esconderia demais o
 * desenho. `face`: para onde o sprite olha no arquivo (1 = direita).
 */
export function walkFrames(src: Raster, face: 1 | -1, report: WalkReport = {}): Raster[] | null {
  const { width: w, height: h, data } = src;
  if (w < 8 || h < 16) {
    report.reason = "sprite pequeno demais";
    return null;
  }
  const feet = findFeet(src).feet;
  report.feet = feet.length;
  if (feet.length < 2) {
    report.reason = "não achei dois pés separados";
    return null;
  }
  const lift = Math.max(2, Math.round(h * 0.045));
  const step = Math.max(1, Math.round(w * 0.015));
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > ALPHA) opaque++;

  const frames: Raster[] = [];
  report.kept = [];
  report.inPlace = [];
  for (let phase = 0; phase < WALK_PHASES; phase++) {
    const out = new Uint8ClampedArray(data);
    const moving = feet
      .map((foot, n) => ({ foot, a: (n % 2 === 0 ? LIFT_A : LIFT_B)[phase] }))
      .filter((m) => m.a > 0)
      .map(({ foot, a }) => ({ foot, dy: Math.round(lift * a), dx: a === 1 ? face * step : 0 }));
    // primeiro tira os pés que sobem, depois os pinta no lugar novo
    for (const { foot } of moving) for (const i of foot.pixels) out.fill(0, i * 4, i * 4 + 4);
    const moved = new Map<number, number>(); // pixel original → onde foi parar (-1 = fora)
    for (const { foot, dx, dy } of moving)
      for (const i of foot.pixels) {
        const x = (i % w) + dx, y = Math.floor(i / w) - dy;
        if (x < 0 || x >= w || y < 0) {
          moved.set(i, -1);
          continue;
        }
        const j = y * w + x;
        out.set(data.subarray(i * 4, i * 4 + 4), j * 4);
        moved.set(i, j);
      }
    // quanto do desenho original continua visível e intacto (parado ou deslocado)
    let kept = 0;
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] <= ALPHA) continue;
      const j = moved.has(i) ? moved.get(i)! : i;
      if (j >= 0 && samePx(data, i, out, j)) kept++;
    }
    const frame = { width: w, height: h, data: out };
    const fid = kept / opaque;
    report.kept.push(fid);
    report.inPlace.push(inPlace(src, frame));
    if (fid < MIN_FIDELITY) {
      report.reason = `no quadro ${phase} só ${(fid * 100).toFixed(1)}% do desenho continua visível`;
      return null;
    }
    frames.push(frame);
  }
  return frames;
}
