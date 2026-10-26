// Confere a caminhada gerada (src/pet/walk.ts) nos sprites da pasta local:
// fidelidade de cada quadro ao original e uma folha de prévia (original + os
// quadros, ampliados). Com o Aseprite, também um GIF por Digimon para ver o
// movimento.
//
//   node scripts/check-walk.mjs [pasta-de-saida] [caminho-do-aseprite]
//
// Os sprites ficam só na sua máquina: a saída padrão é %TEMP%\digitama-walk.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { decodePng, encodePng, prepare } from "./png.mjs";
import { walkFrames, MIN_FIDELITY } from "../src/pet/walk.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "digitama-walk");
const aseprite = process.argv[3] ?? "C:/DEV/Tools/aseprite/build/bin/aseprite.exe";
const spritesDir = join(process.env.APPDATA ?? "", "br.com.mastersys.digitama", "sprites");
// os que andam (do Criança em diante) e para onde olham no arquivo (render.ts)
const WALKERS = {
  agumon: -1, greymon: 1, metalgreymon: 1, wargreymon: -1,
  guilmon: 1, growlmon: 1, wargrowlmon: 1, gallantmon: -1,
  dorumon: 1, dorugamon: -1, doruguremon: 1, alphamon: -1,
};
const SCALE = 2;

function sheet(rows) {
  const pad = 6;
  const W = Math.max(...rows.map((r) => r.reduce((s, f) => s + f.width * SCALE + pad, pad)));
  const H = rows.reduce((s, r) => s + Math.max(...r.map((f) => f.height)) * SCALE + pad, pad);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set(((i % W >> 3) + (Math.floor(i / W) >> 3)) % 2 ? [74, 74, 92, 255] : [84, 84, 104, 255], i * 4);
  let oy = pad;
  for (const row of rows) {
    const rh = Math.max(...row.map((f) => f.height)) * SCALE;
    let ox = pad;
    for (const f of row) {
      for (let y = 0; y < f.height * SCALE; y++)
        for (let x = 0; x < f.width * SCALE; x++) {
          const s = (Math.floor(y / SCALE) * f.width + Math.floor(x / SCALE)) * 4;
          if (f.data[s + 3] <= 16) continue;
          data.set(f.data.subarray(s, s + 3), ((oy + rh - f.height * SCALE + y) * W + ox + x) * 4);
        }
      ox += f.width * SCALE + pad;
    }
    oy += rh + pad;
  }
  return { width: W, height: H, data };
}

// ── Conferência ─────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });
const rows = [];
let accepted = 0;
for (const [id, face] of Object.entries(WALKERS)) {
  const dir = join(spritesDir, id);
  const file = existsSync(join(dir, "idle_0.png")) ? join(dir, "idle_0.png") : join(dir, "idle.png");
  if (!existsSync(file)) {
    console.log(`${id.padEnd(13)} sem sprite`);
    continue;
  }
  const orig = prepare(decodePng(readFileSync(file)));
  const report = {};
  const frames = walkFrames(orig, face, report);
  if (!frames) {
    console.log(`${id.padEnd(13)} RECUSADO (${report.reason}; ${orig.width}×${orig.height}) — anda só com o balanço do corpo`);
    continue;
  }
  accepted++;
  const pct = (list) => list.map((f) => (f * 100).toFixed(1)).join(" ");
  const worst = Math.min(...report.kept);
  console.log(`${id.padEnd(13)} ok  ${report.feet} pés · desenho intacto (pior) ${(worst * 100).toFixed(1)}% · por quadro ${pct(report.kept)}`);
  console.log(`${"".padEnd(13)}     idêntico no mesmo lugar: ${pct(report.inPlace)}`);
  if (worst < MIN_FIDELITY) throw new Error(`${id}: abaixo do mínimo`);
  rows.push([orig, ...frames]);
  // quadros soltos e o GIF (125 ms por quadro, como no app a ~55 px/s)
  const frameDir = join(outDir, id);
  mkdirSync(frameDir, { recursive: true });
  frames.forEach((f, i) => writeFileSync(join(frameDir, `walk_${i}.png`), encodePng(f)));
  if (existsSync(aseprite)) {
    try {
      execFileSync(aseprite, ["-b", join(frameDir, "walk_0.png"), "--frame-range", "0,7", "--scale", "3", "--save-as", join(outDir, `${id}.gif`)], { stdio: "ignore" });
    } catch {
      /* sem GIF: a folha basta */
    }
  }
}
if (rows.length) writeFileSync(join(outDir, "walk-sheet.png"), encodePng(sheet(rows)));
console.log(`\n${accepted} de ${Object.keys(WALKERS).length} com passos · saída em ${outDir}`);
