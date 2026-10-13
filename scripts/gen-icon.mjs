// Gera src-tauri/icons/source.png (1024×1024): o Digitama em pixel art.
// Depois: `npx tauri icon src-tauri/icons/source.png -o src-tauri/icons`.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const EGG = [
  "................",
  "......kkkk......",
  "....kkwwwwkk....",
  "...kwwwwwwssk...",
  "..kwwoowwwwssk..",
  "..kwoooowwwwsk..",
  ".kwwwoowwwwwssk.",
  ".kwwwwwwwoowwsk.",
  ".kwwwwwwoooowsk.",
  ".kwoowwwwoowwsk.",
  ".kooooowwwwwssk.",
  ".kwoowwwwwwwssk.",
  "..kwwwwwwwwssk..",
  "...kkwwwwsskk...",
  ".....kkkkkk.....",
  "................",
];
const PAL = { k: [40, 28, 50, 255], w: [250, 246, 236, 255], s: [214, 200, 182, 255], o: [242, 128, 32, 255], ".": [0, 0, 0, 0] };

const SIZE = 1024, CELL = SIZE / 16;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const c = PAL[EGG[Math.floor(y / CELL)][Math.floor(x / CELL)]];
    c.forEach((v, i) => (raw[y * (SIZE * 4 + 1) + 1 + x * 4 + i] = v));
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log("src-tauri/icons/source.png gerado");
