// Renderiza todos os sprites numa folha PNG para conferir o desenho:
//   node scripts/preview-sprites.mjs [saida.png] [escala]
// Uma linha por linha evolutiva, do ovo ao Supremo.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { rasterize, SPRITE_DEFS } from "../src/pet/sprites.ts";

const out = process.argv[2] ?? "sprites-preview.png";
const S = Number(process.argv[3] ?? 4);
const ROWS = [
  ["digitama-agumon", "botamon", "koromon", "agumon", "greymon", "metalgreymon", "wargreymon"],
  ["digitama-guilmon", "jyarimon", "gigimon", "guilmon", "growlmon", "wargrowlmon", "gallantmon"],
  ["digitama-dorumon", "dodomon", "dorimon", "dorumon", "dorugamon", "doruguremon", "alphamon"],
];
const CELL = 44 * S;
const W = CELL * 7, H = CELL * ROWS.length;
const img = Buffer.alloc(W * H * 4);
const put = (x, y, [r, g, b]) => {
  const i = (y * W + x) * 4;
  img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, ((x >> 3) + (y >> 3)) % 2 ? [74, 74, 92] : [84, 84, 104]);
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

ROWS.forEach((row, r) =>
  row.forEach((id, c) => {
    const def = SPRITE_DEFS[id];
    if (!def) return;
    const sp = rasterize(def);
    const ox = c * CELL + Math.floor((CELL - sp.size * S) / 2);
    const oy = r * CELL + (CELL - sp.size * S) - 4;
    sp.px.forEach((col, i) => {
      if (!col) return;
      const px = i % sp.size, py = Math.floor(i / sp.size);
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) put(ox + px * S + dx, oy + py * S + dy, hex(col));
    });
  }),
);

const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (t, d) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) img.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`${out} (${W}×${H})`);
