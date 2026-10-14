// Depois do `tauri build`: copia o instalador mais novo para release/
// com um nome fixo, substituindo o anterior (sempre um só .exe lá).
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const nsis = "target/release/bundle/nsis";
const exes = readdirSync(nsis)
  .filter((f) => f.endsWith("-setup.exe"))
  .map((f) => ({ f, t: statSync(join(nsis, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (!exes.length) {
  console.error(`Nenhum instalador em ${nsis}`);
  process.exit(1);
}
mkdirSync("release", { recursive: true });
for (const old of readdirSync("release")) if (old.endsWith(".exe")) rmSync(join("release", old));
const dest = join("release", "Digitama-setup.exe");
copyFileSync(join(nsis, exes[0].f), dest);
console.log(`${exes[0].f} → ${dest}`);
