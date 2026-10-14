//! Instala os hooks do Digitama no `%USERPROFILE%\.claude\settings.json`.
//!
//! Mesma regra do Coucou, seguida à risca: ler, mesclar sem tocar nos hooks de
//! mais ninguém, mostrar o diff, e só gravar depois do clique — com backup
//! datado ao lado e recusando gravar se o arquivo mudou depois da prévia.
//!
//! O comando é só o caminho do relay entre aspas, com barras normais, e o nome
//! do evento: no Windows o Claude Code roda hooks pelo Git Bash.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Map, Value};

/// Eventos que o pet usa, com o timeout gravado no settings.json.
/// PermissionRequest espera um humano: ganha o tempo da decisão + folga.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
];

const MARKER: &str = "digitama-hook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub settings_path: String,
    pub fingerprint: String,
    pub changes: bool,
}

pub fn settings_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join(".claude").join("settings.json")
}

fn read_bytes() -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(settings_path()) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Não consegui ler o settings.json: {e}")),
    }
}

fn parse(bytes: Option<&[u8]>) -> Result<Value, String> {
    let Some(b) = bytes else { return Ok(json!({})) };
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b);
    if b.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_slice(b).map_err(|e| format!("O settings.json não é um JSON válido ({e}) — nada foi alterado."))?;
    if !v.is_object() {
        return Err("O settings.json não é um objeto JSON — nada foi alterado.".into());
    }
    Ok(v)
}

/// FNV-1a 64: identifica os bytes que a prévia mostrou.
fn fingerprint(bytes: Option<&[u8]>) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes.unwrap_or(b"<sem arquivo>") {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn hook_command(exe: &str, event: &str) -> String {
    format!("\"{}\" {event}", exe.replace('\\', "/"))
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(|h| h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))))
}

fn merged(existing: &Value, exe: &str) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = match root.get("hooks") {
        None => Map::new(),
        Some(Value::Object(h)) => h.clone(),
        Some(_) => return Err("\"hooks\" no settings.json tem um tipo inesperado — nada foi alterado.".into()),
    };
    for (event, timeout) in HOOK_EVENTS {
        let mut list = match hooks.get(*event) {
            None => Vec::new(),
            Some(Value::Array(list)) => list.clone(),
            Some(_) => return Err(format!("\"hooks\".\"{event}\" tem um tipo inesperado — nada foi alterado.")),
        };
        list.retain(|e| !entry_is_ours(e));
        list.push(json!({ "hooks": [{ "type": "command", "command": hook_command(exe, event), "timeout": timeout }] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(root))
}

fn without_ours(existing: &Value) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let hooks = match root.get("hooks") {
        None => return Ok(Value::Object(root)),
        Some(Value::Object(h)) => h.clone(),
        Some(_) => return Err("\"hooks\" no settings.json tem um tipo inesperado — nada foi alterado.".into()),
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> = list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Ok(Value::Object(root))
}

fn pretty(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap_or_default();
    s.push('\n');
    s
}

/// Diff de linhas (LCS) com 2 linhas de contexto em volta de cada mudança.
pub fn line_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            ops.push(('+', b[j]));
            j += 1;
        } else {
            ops.push(('-', a[i]));
            i += 1;
        }
    }
    let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, (k, _))| *k != ' ').map(|(i, _)| i).collect();
    let keep = |idx: usize| changed.iter().any(|c| c.abs_diff(idx) <= 2);
    let mut out = String::new();
    let mut skipped = false;
    for (idx, (kind, text)) in ops.iter().enumerate() {
        if keep(idx) {
            if skipped {
                out.push_str("  …\n");
                skipped = false;
            }
            out.push_str(&format!("{kind} {text}\n"));
        } else {
            skipped = true;
        }
    }
    out
}

pub fn status(exe: &str) -> HookStatus {
    let installed = read_bytes()
        .ok()
        .flatten()
        .and_then(|b| parse(Some(&b)).ok())
        .and_then(|v| v.get("hooks").and_then(Value::as_object).cloned())
        .is_some_and(|hooks| hooks.values().filter_map(Value::as_array).flatten().any(entry_is_ours));
    HookStatus {
        installed,
        settings_path: settings_path().to_string_lossy().into_owned(),
        hook_ready: std::path::Path::new(exe).exists(),
        hook_path: exe.to_string(),
    }
}

fn plan(install: bool, exe: &str) -> Result<(Option<Vec<u8>>, String, String), String> {
    let bytes = read_bytes()?;
    let current = parse(bytes.as_deref())?;
    let next = if install { merged(&current, exe)? } else { without_ours(&current)? };
    let before = if bytes.is_some() { pretty(&current) } else { String::new() };
    Ok((bytes, before, pretty(&next)))
}

pub fn preview(install: bool, exe: &str) -> Result<HookPreview, String> {
    let (bytes, before, after) = plan(install, exe)?;
    Ok(HookPreview {
        changes: before != after,
        diff: line_diff(&before, &after),
        settings_path: settings_path().to_string_lossy().into_owned(),
        fingerprint: fingerprint(bytes.as_deref()),
    })
}

/// Grava depois do backup datado. Devolve o caminho do backup ("" sem arquivo).
pub fn apply(install: bool, exe: &str, expected: &str) -> Result<String, String> {
    let (bytes, _, after) = plan(install, exe)?;
    if fingerprint(bytes.as_deref()) != expected {
        return Err("O settings.json mudou desde a prévia. Abra a prévia de novo antes de gravar.".into());
    }
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut backup = String::new();
    if let Some(original) = &bytes {
        let b = path.with_file_name(format!("settings.json.digitama-{}.bak", stamp()));
        std::fs::write(&b, original).map_err(|e| format!("Não consegui criar o backup: {e} — nada foi alterado."))?;
        backup = b.to_string_lossy().into_owned();
    }
    let tmp = path.with_extension("json.digitama-tmp");
    std::fs::write(&tmp, after.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Não consegui gravar o settings.json: {e}")
    })?;
    Ok(backup)
}

// ── Barra de status: uso do plano do Claude ──────────────────────────────────
//
// O Claude Code passa os limites do plano (`rate_limits`) para o comando da barra
// de status. O relay toma o lugar desse comando e repassa os limites ao pet; a
// barra que você já tinha (a do Coucou, por exemplo) fica salva em
// `statusline-previous.json` ao lado do relay, e o relay continua rodando ela —
// então ela segue aparecendo igual. Remover devolve a anterior.

const PREVIOUS_FILE: &str = "statusline-previous.json";

fn previous_path(exe: &str) -> std::path::PathBuf {
    std::path::Path::new(exe).with_file_name(PREVIOUS_FILE)
}

fn status_line_is_ours(v: &Value) -> bool {
    v.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
}

pub fn status_line_installed(exe: &str) -> bool {
    let _ = exe;
    read_bytes()
        .ok()
        .flatten()
        .and_then(|b| parse(Some(&b)).ok())
        .and_then(|v| v.get("statusLine").cloned())
        .is_some_and(|sl| status_line_is_ours(&sl))
}

fn status_line_settings(current: &Value, install: bool, exe: &str, previous: Option<&Value>) -> Result<Value, String> {
    let mut root = current.as_object().cloned().unwrap_or_default();
    let existing = root.get("statusLine").cloned();
    if install && existing.as_ref().is_some_and(|v| !v.is_object()) {
        return Err("\"statusLine\" no settings.json tem um tipo inesperado — nada foi alterado.".into());
    }
    let next = if install {
        // troca só o comando: padding e afins continuam como estavam
        let mut sl = existing.filter(Value::is_object).unwrap_or_else(|| json!({}));
        let obj = sl.as_object_mut().expect("objeto");
        obj.entry("type").or_insert_with(|| json!("command"));
        obj.insert("command".into(), json!(format!("\"{}\" --statusline", exe.replace('\\', "/"))));
        Some(sl)
    } else if existing.as_ref().is_some_and(status_line_is_ours) {
        previous.cloned()
    } else {
        existing // já não é nosso: não mexe
    };
    match next {
        Some(v) => root.insert("statusLine".into(), v),
        None => root.remove("statusLine"),
    };
    Ok(Value::Object(root))
}

fn read_previous(exe: &str) -> Option<Value> {
    serde_json::from_slice::<Value>(&std::fs::read(previous_path(exe)).ok()?).ok().filter(Value::is_object)
}

pub fn status_line_preview(install: bool, exe: &str) -> Result<HookPreview, String> {
    let bytes = read_bytes()?;
    let current = parse(bytes.as_deref())?;
    let next = status_line_settings(&current, install, exe, read_previous(exe).as_ref())?;
    let before = if bytes.is_some() { pretty(&current) } else { String::new() };
    let after = pretty(&next);
    Ok(HookPreview {
        changes: before != after,
        diff: line_diff(&before, &after),
        settings_path: settings_path().to_string_lossy().into_owned(),
        fingerprint: fingerprint(bytes.as_deref()),
    })
}

pub fn status_line_apply(install: bool, exe: &str, expected: &str) -> Result<String, String> {
    let bytes = read_bytes()?;
    if fingerprint(bytes.as_deref()) != expected {
        return Err("O settings.json mudou desde a prévia. Abra a prévia de novo antes de gravar.".into());
    }
    let current = parse(bytes.as_deref())?;
    let previous = read_previous(exe);
    // Instalando por cima de uma barra que não é nossa: guarda ela ao lado do relay.
    if install {
        if let Some(own) = current.get("statusLine").filter(|v| v.is_object() && !status_line_is_ours(v)) {
            std::fs::write(previous_path(exe), serde_json::to_string_pretty(own).unwrap_or_default())
                .map_err(|e| format!("Não consegui guardar a sua barra de status atual: {e} — nada foi alterado."))?;
        }
    }
    let next = status_line_settings(&current, install, exe, previous.as_ref())?;
    let path = settings_path();
    let mut backup = String::new();
    if let Some(original) = &bytes {
        let b = path.with_file_name(format!("settings.json.digitama-{}.bak", stamp()));
        std::fs::write(&b, original).map_err(|e| format!("Não consegui criar o backup: {e} — nada foi alterado."))?;
        backup = b.to_string_lossy().into_owned();
    }
    let tmp = path.with_extension("json.digitama-tmp");
    std::fs::write(&tmp, pretty(&next).as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Não consegui gravar o settings.json: {e}")
    })?;
    if !install {
        let _ = std::fs::remove_file(previous_path(exe));
    }
    Ok(backup)
}

/// AAAAMMDD-HHMMSS em UTC, sem dependências.
fn stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant, civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\eu\AppData\Local\digitama\bin\digitama-hook.exe";

    #[test]
    fn mesclar_preserva_o_resto_e_remover_volta_ao_original() {
        let existing = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "outro.exe" }] }] }
        });
        let after = merged(&existing, EXE).unwrap();
        assert_eq!(after["model"], "opus");
        let stop = after["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert!(stop.iter().any(entry_is_ours));
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().starts_with("\"C:/Users/"));
        let twice = merged(&after, EXE).unwrap();
        assert_eq!(twice["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(without_ours(&after).unwrap(), existing);
    }

    #[test]
    fn tipos_inesperados_sao_recusados() {
        assert!(merged(&json!({ "hooks": "x" }), EXE).is_err());
        assert!(merged(&json!({ "hooks": { "Stop": {} } }), EXE).is_err());
        assert!(parse(Some(b"[1]")).is_err());
        assert!(parse(Some(b"{ quebrado")).is_err());
        assert_eq!(parse(Some(b"\xEF\xBB\xBF{}")).unwrap(), json!({}));
    }

    #[test]
    fn barra_de_status_troca_so_o_comando_e_volta_a_anterior() {
        let coucou = json!({ "type": "command", "command": "\"C:/x/coucou-hook.exe\" --statusline", "padding": 1 });
        let cur = json!({ "model": "opus", "statusLine": coucou });
        let ours = status_line_settings(&cur, true, EXE, None).unwrap();
        assert!(status_line_is_ours(&ours["statusLine"]));
        assert_eq!(ours["statusLine"]["padding"], 1);
        assert_eq!(ours["model"], "opus");
        // remover devolve exatamente a do Coucou
        let back = status_line_settings(&ours, false, EXE, Some(&coucou)).unwrap();
        assert_eq!(back["statusLine"], coucou);
        // sem anterior, a chave some
        assert!(status_line_settings(&ours, false, EXE, None).unwrap().get("statusLine").is_none());
        // uma barra que não é nossa nunca é removida
        assert_eq!(status_line_settings(&cur, false, EXE, None).unwrap()["statusLine"], coucou);
    }

    #[test]
    fn diff_marca_so_o_que_mudou() {
        let d = line_diff("a\nb\nc\n", "a\nb\nx\nc\n");
        assert!(d.contains("+ x"));
        assert!(!d.contains("- "));
        assert_eq!(stamp().len(), 15);
    }
}
