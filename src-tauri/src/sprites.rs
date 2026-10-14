//! Os sprites reais (Digimon World DS / Digimon Story: parado, ataque e dano),
//! baixados do Wikimon para a pasta local de sprites na primeira abertura —
//! assim qualquer PC fica igual sem rodar script nenhum. Ficam só na máquina do
//! usuário (uso pessoal); nada disso vai para o instalador ou o repositório.
//!
//! A mesma lista está em scripts/fetch-sprites.mjs (para quem desenvolve).

use std::path::Path;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

const BASE: &str = "https://wikimon.net/Special:FilePath/";

/// id do app → arquivo do Wikimon por pose.
pub const SPRITES: &[(&str, &[(&str, &str)])] = &[
    ("botamon", &[("idle", "Botamon_dssm_battle.png"), ("attack", "Botamon_dssm_battle_attack.png"), ("hit", "Botamon_dssm_battle_hit.png")]),
    ("koromon", &[("idle", "Koromon_dst_battle.png"), ("attack", "Koromon_dst_battle_attack.png"), ("hit", "Koromon_dst_battle_hit.png")]),
    ("agumon", &[("idle", "Agumon_dsle_battle.png"), ("attack", "Agumon_dsle_battle_attack.png"), ("hit", "Agumon_dsle_battle_hit.png")]),
    ("greymon", &[("idle", "Greymon_dst_battle.png"), ("attack", "Greymon_dst_battle_attack.png"), ("hit", "Greymon_dst_battle_hit.png")]),
    ("metalgreymon", &[("idle", "Metalgreymon_dst_battle.png"), ("attack", "Metalgreymon_dst_battle_attack.png"), ("hit", "Metalgreymon_dst_battle_hit.png")]),
    ("wargreymon", &[("idle", "Spr_DS_Grey_War_Vaccine.png"), ("attack", "Wargreymon_dst_battle_attack.png"), ("hit", "Wargreymon_dst_battle_hit.png")]),
    ("jyarimon", &[("idle", "Jyarimon_battle_dtb.png")]),
    ("gigimon", &[("idle", "Gigimon_dssm_battle.png"), ("attack", "Gigimon_dssm_battle_attack.png"), ("hit", "Gigimon_dssm_battle_hit.png")]),
    ("guilmon", &[("idle", "Guilmon_dst_battle.png"), ("attack", "Guilmon_dst_battle_attack.png"), ("hit", "Guilmon_dst_battle_hit.png")]),
    ("growlmon", &[("idle", "Growmon_dst_battle.png"), ("attack", "Growmon_dst_battle_attack.png"), ("hit", "Growmon_dst_battle_hit.png")]),
    ("wargrowlmon", &[("idle", "Megalogrowmon_dst_battle.png"), ("attack", "Megalogrowmon_dst_battle_attack.png"), ("hit", "Megalogrowmon_dst_battle_hit.png")]),
    ("gallantmon", &[("idle", "Dukemon_dst_battle.png"), ("attack", "Dukemon_dst_battle_attack.png"), ("hit", "Dukemon_dst_battle_hit.png")]),
    ("dodomon", &[("idle", "Dodomon_re.png")]),
    ("dorimon", &[("idle", "Dorimon_dst_battle.png"), ("attack", "Dorimon_dst_battle_attack.png"), ("hit", "Dorimon_dst_battle_hit.png")]),
    ("dorumon", &[("idle", "Dorumon_dst_battle.png"), ("attack", "Dorumon_dst_battle_attack.png"), ("hit", "Dorumon_dst_battle_hit.png")]),
    ("dorugamon", &[("idle", "Dorugamon_dst_battle.png"), ("attack", "Dorugamon_dst_battle_attack.png"), ("hit", "Dorugamon_dst_battle_hit.png")]),
    ("doruguremon", &[("idle", "Doruguremon_dst_battle.png"), ("attack", "Doruguremon_dst_battle_attack.png"), ("hit", "Doruguremon_dst_battle_hit.png")]),
    ("alphamon", &[("idle", "Alphamon_battle_dst.png"), ("attack", "Alphamon_dst_battle_attack.png"), ("hit", "Alphamon_dst_battle_hit.png")]),
];

/// Falta algum arquivo? (o usuário pode ter apagado ou trocado um à mão)
pub fn missing(dir: &Path) -> usize {
    SPRITES
        .iter()
        .flat_map(|(id, poses)| poses.iter().map(move |(pose, _)| dir.join(id).join(format!("{pose}.png"))))
        .filter(|p| !p.exists())
        .count()
}

/// Baixa o que falta (ou tudo, com `force`), avisando o progresso com o evento
/// `sprites-progress` e, no fim, `sprites-ready` para as janelas recarregarem.
pub async fn download(app: &AppHandle, dir: &Path, force: bool) -> Result<(usize, usize), String> {
    let client = reqwest::Client::builder()
        .user_agent("Digitama/0.1 (pet de area de trabalho, uso pessoal)")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let total: usize = SPRITES.iter().map(|(_, p)| p.len()).sum();
    let (mut done, mut ok, mut failed) = (0usize, 0usize, 0usize);
    for (id, poses) in SPRITES {
        let folder = dir.join(id);
        let _ = std::fs::create_dir_all(&folder);
        for (pose, file) in *poses {
            done += 1;
            let dest = folder.join(format!("{pose}.png"));
            let _ = app.emit("sprites-progress", json!({ "done": done, "total": total, "current": format!("{id}/{pose}") }));
            if dest.exists() && !force {
                continue;
            }
            let bytes = async {
                let res = client.get(format!("{BASE}{file}")).send().await.map_err(|e| e.to_string())?;
                if !res.status().is_success() {
                    return Err(format!("HTTP {}", res.status()));
                }
                res.bytes().await.map_err(|e| e.to_string())
            }
            .await;
            match bytes {
                Ok(b) if b.starts_with(&[0x89, b'P', b'N', b'G']) => {
                    if std::fs::write(&dest, &b).is_ok() {
                        ok += 1;
                    } else {
                        failed += 1;
                    }
                }
                _ => failed += 1,
            }
        }
    }
    let _ = app.emit("sprites-ready", json!({ "downloaded": ok, "failed": failed }));
    Ok((ok, failed))
}
