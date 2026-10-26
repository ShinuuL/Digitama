//! As sessões do Claude Code abertas pela extensão do VS Code, para a faixa de
//! sessões do chat.
//!
//! * A lista vem dos transcritos em `~/.claude/projects/<pasta>/<id>.jsonl`: do
//!   começo do arquivo sai se é do VS Code (`entrypoint: "claude-vscode"`), a
//!   pasta e o branch; do fim, o título que o Claude Code dá à conversa. São
//!   centenas de MB, então só o começo e o fim são lidos, e um arquivo que
//!   cresceu é lido só do ponto onde parou.
//! * O estado ao vivo (trabalhando, esperando você) vem dos hooks (`pipe.rs`).
//! * "Continuar aqui" copia o transcrito para a pasta de projeto do chat do
//!   Digitama e o chat o retoma com `--fork-session`: uma cópia com todo o
//!   contexto, sem tocar na conversa que o VS Code está gravando.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Do começo do arquivo: o bastante para achar `entrypoint` e `cwd`.
const HEAD: u64 = 64 * 1024;
/// Do fim: o título mais recente (e as últimas mensagens, ×4).
const TAIL: u64 = 256 * 1024;
/// Uma sessão sem sinal dos hooks há mais que isso deixa de contar como ativa.
const LIVE_FOR: Duration = Duration::from_secs(45 * 60);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// Nome da pasta do projeto ("Digitama").
    pub project: String,
    pub branch: String,
    /// Última gravação no transcrito (ms desde 1970).
    pub updated: u64,
    /// "working", "waiting", "idle" (ativa, parada) ou "" (não está aberta).
    pub status: String,
}

#[derive(Clone, Default)]
struct Meta {
    len: u64,
    /// Já se sabe de onde a sessão veio (`entrypoint` encontrado).
    known: bool,
    vscode: bool,
    cwd: String,
    branch: String,
    title: String,
    prompt: String,
}

/// Metadados já lidos, por arquivo.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<PathBuf, Meta>>);

/// O que os hooks contaram de cada sessão: estado, pasta e quando.
#[derive(Default)]
pub struct Live(pub Mutex<HashMap<String, (String, String, Instant)>>);

/// Um evento de hook muda o estado ao vivo da sessão. `true` se mudou algo.
pub fn on_hook(live: &Live, payload: &Value) -> bool {
    let Some(id) = payload.get("session_id").and_then(Value::as_str) else { return false };
    if payload.get("digitama_internal").and_then(Value::as_bool) == Some(true) {
        return false; // o próprio chat do Digitama
    }
    let event = payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
    let status = match event {
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => "working",
        "PermissionRequest" => "waiting",
        "Notification" => {
            let kind = payload.get("notification_type").and_then(Value::as_str).unwrap_or_default();
            let msg = payload.get("message").and_then(Value::as_str).unwrap_or_default();
            if kind == "idle_prompt" || kind == "permission_prompt" || kind == "question" || msg.contains("waiting for your input") {
                "waiting"
            } else {
                return false;
            }
        }
        "SessionStart" | "Stop" | "StopFailure" => "idle",
        "SessionEnd" => {
            return live.0.lock().unwrap().remove(id).is_some();
        }
        _ => return false,
    };
    let mut map = live.0.lock().unwrap();
    let before = map.get(id).map(|(s, _, _)| s.clone());
    map.insert(id.to_string(), (status.to_string(), cwd, Instant::now()));
    before.as_deref() != Some(status)
}

pub fn projects_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join(".claude").join("projects")
}

/// A pasta de projeto que o Claude Code usa para `cwd`: tudo que não é letra ou
/// número vira "-" (`C:\Users\x` → `C--Users-x`).
pub fn project_key(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Nome de servidor MCP como aparece nas ferramentas (`mcp__<nome>__…`).
pub fn valid_mcp(name: &str) -> bool {
    !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Ids de sessão são UUIDs: nada de caminhos vindos da página.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Campo de texto de uma linha JSON, sem montar o JSON se a linha não o tem.
fn field(line: &str, key: &str) -> Option<String> {
    if !line.contains(&format!("\"{key}\"")) {
        return None;
    }
    serde_json::from_str::<Value>(line).ok()?.get(key)?.as_str().map(str::to_string)
}

fn read_range(file: &mut File, from: u64, len: u64) -> String {
    let mut buf = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_ok() {
        let _ = file.take(len).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Lê (ou atualiza) os metadados de um transcrito.
fn meta(path: &Path, len: u64, old: Option<Meta>) -> Meta {
    let Ok(mut file) = File::open(path) else { return Meta { len, ..Default::default() } };
    let mut m = match old {
        // cresceu: o começo já foi lido; só o pedaço novo importa
        Some(old) if len >= old.len => old,
        _ => {
            let mut m = Meta::default();
            for line in read_range(&mut file, 0, HEAD).lines() {
                if m.cwd.is_empty() {
                    if let Some(c) = field(line, "cwd") {
                        m.cwd = c;
                    }
                }
                if let Some(e) = field(line, "entrypoint") {
                    m.known = true;
                    m.vscode = e == "claude-vscode";
                }
                // sem título do Claude Code (conversa curta): a primeira mensagem sua
                if m.prompt.is_empty() && line.contains("\"type\":\"user\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        if v.get("isMeta").and_then(Value::as_bool) != Some(true) {
                            m.prompt = v.get("message").and_then(|m| m.get("content")).map(visible_text).unwrap_or_default();
                        }
                    }
                }
                if !m.cwd.is_empty() && m.known && !m.prompt.is_empty() {
                    break;
                }
            }
            m
        }
    };
    // uma primeira mensagem enorme (print colado) esconde o `entrypoint` do começo
    if m.vscode || !m.known {
        let from = m.len.max(len.saturating_sub(TAIL));
        for line in read_range(&mut file, from, len - from).lines() {
            if !m.known {
                if let Some(e) = field(line, "entrypoint") {
                    m.known = true;
                    m.vscode = e == "claude-vscode";
                }
                if m.cwd.is_empty() {
                    m.cwd = field(line, "cwd").unwrap_or_default();
                }
            }
            if line.contains("\"ai-title\"") {
                if let Some(t) = field(line, "aiTitle") {
                    m.title = t;
                }
            } else if line.contains("\"last-prompt\"") {
                if let Some(p) = field(line, "lastPrompt") {
                    m.prompt = p;
                }
            }
            if let Some(b) = field(line, "gitBranch").filter(|b| !b.is_empty()) {
                m.branch = b;
            }
        }
    }
    m.len = len;
    m
}

/// `cwd` fica dentro de `dir`? (sem diferenciar maiúsculas nem `/` e `\`)
fn inside(cwd: &str, dir: &Path) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (c, d) = (norm(cwd), norm(&dir.to_string_lossy()));
    !d.is_empty() && (c == d || c.starts_with(&format!("{d}\\")))
}

/// As sessões do VS Code: as ativas (pelos hooks) e as gravadas nos últimos
/// `days` dias, das mais recentes para as mais antigas. As que rodam dentro de
/// `internal` (a pasta de dados do Digitama: o chat e a consulta de uso) ficam
/// de fora: aberto de um terminal do VS Code, o app passa a marca
/// `claude-vscode` para os `claude.exe` dele.
pub fn list(cache: &Cache, live: &Live, days: u64, internal: &Path) -> Vec<SessionInfo> {
    let since = SystemTime::now() - Duration::from_secs(days * 86_400);
    let live: HashMap<String, (String, String, Instant)> = live.0.lock().unwrap().clone();
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(projects_dir()) else { return out };
    let mut cache = cache.0.lock().unwrap();
    // As pastas de projeto do próprio Digitama (chat, uso) ficam de fora pelo
    // nome: as cópias do "Continuar aqui" vivem lá e guardam o `cwd` original.
    let own = project_key(internal).to_lowercase();
    for project in projects.flatten() {
        if project.file_name().to_string_lossy().to_lowercase().starts_with(&own) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            let Ok(info) = file.metadata() else { continue };
            let modified = info.modified().unwrap_or(UNIX_EPOCH);
            let fresh = live.get(&id).is_some_and(|(_, _, at)| at.elapsed() < LIVE_FOR);
            if modified < since && !fresh {
                continue;
            }
            let old = cache.get(&path).cloned();
            let m = if old.as_ref().is_some_and(|o| o.len == info.len()) {
                old.unwrap()
            } else {
                let m = meta(&path, info.len(), old);
                cache.insert(path.clone(), m.clone());
                m
            };
            if !m.vscode || inside(&m.cwd, internal) {
                continue;
            }
            let project_name = Path::new(&m.cwd).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let title = if !m.title.is_empty() {
                m.title.clone()
            } else if !m.prompt.is_empty() {
                m.prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
            } else {
                "(sem título)".into()
            };
            let status = if fresh { live.get(&id).map(|(s, _, _)| s.clone()).unwrap_or_default() } else { String::new() };
            out.push(SessionInfo { id, title, cwd: m.cwd.clone(), project: project_name, branch: m.branch.clone(), updated: millis(modified), status });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    // o mesmo id em duas pastas (cópia antiga, pasta renomeada): fica o mais recente
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    out
}

/// Onde está o transcrito original da sessão `id` (fora das pastas do
/// Digitama, onde ficam só as cópias).
pub fn find(id: &str, internal: &Path) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let own = project_key(internal).to_lowercase();
    std::fs::read_dir(projects_dir())
        .ok()?
        .flatten()
        .filter(|p| !p.file_name().to_string_lossy().to_lowercase().starts_with(&own))
        .map(|p| p.path().join(format!("{id}.jsonl")))
        .find(|p| p.is_file())
}

/// Até quanto de cada fala o histórico mostra.
const MAX_SHOWN: usize = 20_000;

#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub text: String,
}

/// Texto visível de um conteúdo de mensagem: os blocos de texto, sem os
/// anexos automáticos da IDE (`<ide_…>`, `<system-reminder>`…).
fn visible_text(content: &Value) -> String {
    let parts: Vec<String> = match content {
        Value::String(s) => vec![s.clone()],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
            .collect(),
        _ => vec![],
    };
    parts.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && !p.starts_with('<')).collect::<Vec<_>>().join("\n")
}

/// As últimas `n` falas (sua e do Claude) da sessão, para mostrar de onde a
/// conversa continua. Uma fala enorme é cortada em `MAX_SHOWN` caracteres, com
/// aviso (só na tela: o Claude recebe a conversa inteira).
pub fn tail(path: &Path, n: usize) -> Vec<Message> {
    let Ok(mut file) = File::open(path) else { return vec![] };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let text = read_range(&mut file, len.saturating_sub(TAIL * 4), TAIL * 4);
    let mut out: Vec<Message> = Vec::new();
    for line in text.lines() {
        let role = if line.starts_with("{\"type\":\"user\"") || line.contains("\"type\":\"user\"") {
            "user"
        } else if line.contains("\"type\":\"assistant\"") {
            "assistant"
        } else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some(role)
            || v.get("isMeta").and_then(Value::as_bool) == Some(true)
            || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else { continue };
        let text = visible_text(content);
        if text.is_empty() {
            continue;
        }
        let text = if text.chars().count() > MAX_SHOWN {
            let cut: String = text.chars().take(MAX_SHOWN).collect();
            format!("{cut}

*(…continua — a fala inteira está na sessão)*")
        } else {
            text
        };
        // respostas em várias partes: junta as seguidas do Claude
        match out.last_mut() {
            Some(last) if last.role == role && role == "assistant" => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => out.push(Message { role: role.into(), text }),
        }
    }
    let skip = out.len().saturating_sub(n);
    out.into_iter().skip(skip).collect()
}

/// Copia o transcrito para a pasta de projeto do chat do Digitama (`chat_dir`),
/// onde o `claude --resume <id> --fork-session` do chat o encontra.
pub fn copy_for_chat(src: &Path, id: &str, chat_dir: &Path) -> Result<(), String> {
    let dest_dir = projects_dir().join(project_key(chat_dir));
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{id}.jsonl"));
    if src != dest {
        std::fs::copy(src, &dest).map_err(|e| format!("Não consegui copiar a sessão: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasta_de_projeto_como_o_claude_code() {
        assert_eq!(
            project_key(Path::new(r"C:\Users\MASTERSYS\AppData\Roaming\br.com.mastersys.digitama\chat")),
            "C--Users-MASTERSYS-AppData-Roaming-br-com-mastersys-digitama-chat"
        );
        assert_eq!(project_key(Path::new(r"c:\DEV\Dev\Digitama")), "c--DEV-Dev-Digitama");
    }

    #[test]
    fn sessoes_do_proprio_digitama_ficam_de_fora() {
        let data = Path::new(r"C:\Users\x\AppData\Roaming\br.com.mastersys.digitama");
        assert!(inside(r"C:\Users\x\AppData\Roaming\br.com.mastersys.digitama\chat", data));
        assert!(inside(r"c:/users/x/appdata/roaming/br.com.mastersys.digitama/usage", data));
        assert!(!inside(r"C:\Users\x\AppData\Roaming\br.com.mastersys.digitama-outro", data));
        assert!(!inside(r"c:\DEV\Dev\Digitama", data));
    }

    #[test]
    fn id_de_sessao_nao_aceita_caminho() {
        assert!(valid_id("8ef8fca3-abb1-44db-8f13-7a0c828a6b87"));
        assert!(!valid_id("..\\..\\x"));
        assert!(!valid_id(""));
    }

    #[test]
    fn texto_visivel_ignora_anexos_da_ide() {
        let content = serde_json::json!([
            { "type": "text", "text": "<ide_opened_file>a.ts</ide_opened_file>" },
            { "type": "text", "text": "corrige o bug" },
            { "type": "tool_result", "content": "x" }
        ]);
        assert_eq!(visible_text(&content), "corrige o bug");
    }

    #[test]
    fn hooks_mudam_o_estado_ao_vivo() {
        let live = Live::default();
        let ev = |name: &str| serde_json::json!({ "session_id": "abc", "hook_event_name": name, "cwd": "c:\\x" });
        assert!(on_hook(&live, &ev("UserPromptSubmit")));
        assert!(!on_hook(&live, &ev("PostToolUse")));
        assert!(on_hook(&live, &ev("PermissionRequest")));
        assert_eq!(live.0.lock().unwrap()["abc"].0, "waiting");
        assert!(on_hook(&live, &ev("SessionEnd")));
        assert!(live.0.lock().unwrap().is_empty());
        let internal = serde_json::json!({ "session_id": "z", "hook_event_name": "Stop", "digitama_internal": true });
        assert!(!on_hook(&live, &internal));
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// Só na mão (`cargo test -p digitama lista_real -- --ignored --nocapture`):
    /// mede a listagem nos transcritos desta máquina, sem mostrar conteúdo.
    #[test]
    #[ignore]
    fn lista_real() {
        let (cache, live) = (Cache::default(), Live::default());
        let t = Instant::now();
        let appdata = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("br.com.mastersys.digitama");
        let first = list(&cache, &live, 7, &appdata);
        let cold = t.elapsed();
        let t = Instant::now();
        let again = list(&cache, &live, 7, &appdata);
        let warm = t.elapsed();
        let titled = first.iter().filter(|s| s.title != "(sem título)").count();
        let projects: std::collections::HashSet<_> = first.iter().map(|s| s.project.clone()).collect();
        println!("{} sessões do VS Code ({} com título, {} projetos) · frio {:?} · com cache {:?}", first.len(), titled, projects.len(), cold, warm);
        assert_eq!(first.len(), again.len());
        if let Some(s) = first.first() {
            let msgs = tail(&find(&s.id, &appdata).unwrap(), 6);
            println!("última sessão: {} falas no fim (papéis: {:?})", msgs.len(), msgs.iter().map(|m| m.role.as_str()).collect::<Vec<_>>());
        }
    }
}
