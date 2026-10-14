// Antes do `tauri build`: copia os sprites da pasta local (%APPDATA%) para
// src-tauri/bundled-sprites, que o instalador leva como recurso. Na primeira
// abertura o app copia de lá o que faltar na pasta de sprites do usuário.
// A pasta fica fora do git (sprites oficiais, uso pessoal).
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = join(process.env.APPDATA ?? "", "br.com.mastersys.digitama", "sprites");
const dest = join("src-tauri", "bundled-sprites");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
if (existsSync(src)) {
  cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith(".tmp") });
  console.log(`sprites empacotados: ${src} → ${dest}`);
} else {
  writeFileSync(join(dest, "LEIA.txt"), "Sem sprites locais no build: o app baixa do Wikimon na primeira abertura.\n");
  console.log("sem sprites locais; o instalador vai sem eles");
}
