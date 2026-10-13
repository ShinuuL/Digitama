// Baixa os sprites de batalha do Digimon World DS / Digimon Story (parado,
// ataque e dano) do Wikimon para a pasta local de sprites do Digitama:
//   %APPDATA%\br.com.mastersys.digitama\sprites\<id>\{idle,attack,hit}.png
//
// Uso pessoal: os sprites são © Bandai e ficam só na sua máquina, fora do
// repositório. Rode de novo para atualizar; arquivos existentes são mantidos
// (use --force para baixar tudo outra vez).
//
//   node scripts/fetch-sprites.mjs [--force]
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const BASE = "https://wikimon.net/Special:FilePath/";

/** id do app → arquivo do Wikimon por pose. */
const SPRITES = {
  botamon: { idle: "Botamon_dssm_battle.png", attack: "Botamon_dssm_battle_attack.png", hit: "Botamon_dssm_battle_hit.png" },
  koromon: { idle: "Koromon_dst_battle.png", attack: "Koromon_dst_battle_attack.png", hit: "Koromon_dst_battle_hit.png" },
  agumon: { idle: "Agumon_dsle_battle.png", attack: "Agumon_dsle_battle_attack.png", hit: "Agumon_dsle_battle_hit.png" },
  greymon: { idle: "Greymon_dst_battle.png", attack: "Greymon_dst_battle_attack.png", hit: "Greymon_dst_battle_hit.png" },
  metalgreymon: { idle: "Metalgreymon_dst_battle.png", attack: "Metalgreymon_dst_battle_attack.png", hit: "Metalgreymon_dst_battle_hit.png" },
  wargreymon: { idle: "Spr_DS_Grey_War_Vaccine.png", attack: "Wargreymon_dst_battle_attack.png", hit: "Wargreymon_dst_battle_hit.png" },
  jyarimon: { idle: "Jyarimon_battle_dtb.png" },
  gigimon: { idle: "Gigimon_dssm_battle.png", attack: "Gigimon_dssm_battle_attack.png", hit: "Gigimon_dssm_battle_hit.png" },
  guilmon: { idle: "Guilmon_dst_battle.png", attack: "Guilmon_dst_battle_attack.png", hit: "Guilmon_dst_battle_hit.png" },
  growlmon: { idle: "Growmon_dst_battle.png", attack: "Growmon_dst_battle_attack.png", hit: "Growmon_dst_battle_hit.png" },
  wargrowlmon: { idle: "Megalogrowmon_dst_battle.png", attack: "Megalogrowmon_dst_battle_attack.png", hit: "Megalogrowmon_dst_battle_hit.png" },
  gallantmon: { idle: "Dukemon_dst_battle.png", attack: "Dukemon_dst_battle_attack.png", hit: "Dukemon_dst_battle_hit.png" },
  dodomon: { idle: "Dodomon_re.png" },
  dorimon: { idle: "Dorimon_dst_battle.png", attack: "Dorimon_dst_battle_attack.png", hit: "Dorimon_dst_battle_hit.png" },
  dorumon: { idle: "Dorumon_dst_battle.png", attack: "Dorumon_dst_battle_attack.png", hit: "Dorumon_dst_battle_hit.png" },
  dorugamon: { idle: "Dorugamon_dst_battle.png", attack: "Dorugamon_dst_battle_attack.png", hit: "Dorugamon_dst_battle_hit.png" },
  doruguremon: { idle: "Doruguremon_dst_battle.png", attack: "Doruguremon_dst_battle_attack.png", hit: "Doruguremon_dst_battle_hit.png" },
  alphamon: { idle: "Alphamon_battle_dst.png", attack: "Alphamon_dst_battle_attack.png", hit: "Alphamon_dst_battle_hit.png" },
};

const force = process.argv.includes("--force");
const appdata = process.env.APPDATA;
if (!appdata) {
  console.error("APPDATA não definido — este script é para Windows.");
  process.exit(1);
}
const root = join(appdata, "br.com.mastersys.digitama", "sprites");

const exists = (p) => access(p).then(() => true, () => false);
let ok = 0, skipped = 0, failed = 0;

for (const [id, poses] of Object.entries(SPRITES)) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  for (const [pose, file] of Object.entries(poses)) {
    const dest = join(dir, `${pose}.png`);
    if (!force && (await exists(dest))) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(BASE + file, { headers: { "User-Agent": "Digitama/0.1 (pet pessoal)" }, redirect: "follow" });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.subarray(0, 4).toString("latin1") !== "\x89PNG") throw new Error(`HTTP ${res.status}`);
      await writeFile(dest, buf);
      ok++;
      console.log(`✓ ${id}/${pose}  ←  ${file}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${id}/${pose}  (${file}): ${e.message}`);
    }
  }
}
console.log(`\n${ok} baixados, ${skipped} já existiam, ${failed} falharam → ${root}`);
console.log("Reabra o Digitama (ou mude de Digimon) para carregar.");
