// Ícones em pixel art (16×16) dos botões hexagonais do Digivice, do menu do
// pet e da captura. A fonte são os art/icons/*.aseprite (feitos e editáveis no
// Aseprite); `node scripts/export-art.mjs` gera o icons.gen.ts.
// "k" contorno, "x" cor do ícone, "d" sombra da cor, "w" brilho, "." vazio.
import { ART } from "./icons.gen";

/** A cor `hex` escurecida (a sombra do ícone). */
function shade(hex: string, f = 0.62) {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const c = (v: number) => Math.round(v * f).toString(16).padStart(2, "0");
  return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

const cache = new Map<string, string>();

/** O ícone como data URL PNG, na cor `color`, com pixel de `px`. */
export function icon(name: keyof typeof ART | string, color = "#ffd23f", px = 2): string {
  const key = `${name}:${color}:${px}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = (ART[name as keyof typeof ART] ?? ART.star).frames[0];
  const c = document.createElement("canvas");
  c.width = c.height = grid.length * px;
  const g = c.getContext("2d")!;
  const dark = shade(color);
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ".") continue;
      g.fillStyle = ch === "k" ? "#0b0820" : ch === "w" ? "#ffffff" : ch === "d" ? dark : color;
      g.fillRect(x * px, y * px, px, px);
    }
  });
  const url = c.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

/** Um <img> com o ícone, já com pixels nítidos. */
export function iconImg(name: string, color?: string, px?: number): HTMLImageElement {
  const img = new Image();
  img.src = icon(name, color, px);
  img.className = "px-icon";
  img.draggable = false;
  return img;
}
