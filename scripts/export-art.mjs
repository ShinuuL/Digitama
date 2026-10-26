// Gera os módulos das artes do app a partir dos .aseprite, com o Aseprite em
// modo de linha de comando:
//   art/fx    → src/pet/art.gen.ts      (efeitos, rachaduras do ovo, bola de fogo, explosão)
//   art/icons → src/shared/icons.gen.ts (ícones do Digivice e da captura)
// As artes são nossas; os sprites do DS não passam aqui.
//
//   node scripts/export-art.mjs [caminho-do-aseprite]
//
// Sem argumento, usa ASEPRITE do ambiente, o Aseprite compilado em
// C:\DEV\Tools\aseprite ou o `aseprite` do PATH.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const candidates = [process.argv[2], process.env.ASEPRITE, "C:/DEV/Tools/aseprite/build/bin/aseprite.exe"].filter(Boolean);
const exe = candidates.find((p) => existsSync(p)) ?? "aseprite";

for (const [label, out] of [
  ["fx", join(root, "src", "pet", "art.gen.ts")],
  ["icons", join(root, "src", "shared", "icons.gen.ts")],
]) {
  const log = execFileSync(
    exe,
    [
      "-b",
      "--script-param", `dir=${join(root, "art", label)}`,
      "--script-param", `out=${out}`,
      "--script-param", `label=${label}`,
      "--script", join(root, "scripts", "export-art.lua"),
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(log);
}
