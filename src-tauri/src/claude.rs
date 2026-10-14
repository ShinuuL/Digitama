//! O chat com o Claude passa pelo próprio Claude Code (`claude.exe`), logado
//! com a sua conta claude.ai (OAuth) — nenhuma chave de API no Digitama. Isso
//! também traz de graça os seus servidores MCP e os conectores do claude.ai que
//! o Claude Code já enxerga.
//!
//! Um processo fica vivo por conversa, em modo stream-json nos dois sentidos:
//! cada mensagem (texto + print opcional) entra no stdin e cada linha do stdout
//! vira o evento `chat-event` na janela do chat. Mudou a persona, o modelo ou as
//! ferramentas? O processo é refeito com `--resume`, mantendo a conversa.
//!
//! Com o provedor OpenCode, cada mensagem é um `opencode run --format json`
//! (mensagem pelo stdin, print com `-f`, conversa continuada com `--session`):
//! o OpenCode usa os provedores e o login que você configurou nele.

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{PetState, Store};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct Chat(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    proc: Option<Proc>,
    session_id: Option<String>,
    generation: u64,
    /// OpenCode: a resposta em andamento, a sessão e a persona já enviada nela.
    oc_child: Option<Child>,
    oc_session: Option<String>,
    oc_persona: Option<String>,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    signature: String,
}

/// Onde está o claude.exe: o caminho configurado, o PATH, o instalador nativo
/// (~/.local/bin) ou o pacote npm.
pub fn find_claude(custom: &str) -> Option<PathBuf> {
    if !custom.trim().is_empty() {
        let p = PathBuf::from(custom.trim());
        return p.exists().then_some(p);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
    [
        home.join(".local").join("bin").join("claude.exe"),
        appdata.join("npm").join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

fn signature(s: &PetState, prompt: Option<&str>) -> String {
    format!("{}|{}|{}|{}", s.model, s.allowed_tools, s.force_oauth, prompt.unwrap_or_default())
}

fn spawn(app: &AppHandle, s: &PetState, prompt: Option<&str>, resume: Option<&str>, generation: u64) -> Result<Proc, String> {
    let exe = find_claude(&s.claude_path)
        .ok_or("Não achei o claude.exe. Instale o Claude Code e faça login (claude → /login), ou informe o caminho nas Configurações.")?;
    let dir = app.state::<Store>().data_dir().join("chat");
    let _ = std::fs::create_dir_all(&dir);

    let mut cmd = Command::new(&exe);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]);
    if !s.model.trim().is_empty() {
        cmd.args(["--model", s.model.trim()]);
    }
    if !s.allowed_tools.trim().is_empty() {
        cmd.args(["--allowedTools", s.allowed_tools.trim()]);
    }
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        cmd.args(["--append-system-prompt", p]);
    }
    if let Some(id) = resume {
        cmd.args(["--resume", id]);
    }
    cmd.current_dir(&dir)
        .env("DIGITAMA_INTERNAL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if s.force_oauth {
        // Com uma chave no ambiente o Claude Code a usaria no lugar da assinatura.
        cmd.env_remove("ANTHROPIC_API_KEY").env_remove("ANTHROPIC_AUTH_TOKEN");
    }

    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o Claude Code: {e}"))?;
    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let stderr = child.stderr.take().ok_or("sem stderr")?;

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                let chat = out_app.state::<Chat>();
                let mut inner = chat.0.lock().unwrap();
                if inner.generation == generation {
                    inner.session_id = Some(id.to_string());
                }
            }
            // Os limites do plano chegam no rate_limit_event: viram o mesmo formato da barra de status.
            if v.get("type").and_then(Value::as_str) == Some("rate_limit_event") {
                if let Some(limits) = usage_from_event(&v) {
                    *out_app.state::<crate::pipe::Usage>().0.lock().unwrap() = Some(limits.clone());
                    let _ = out_app.emit("usage", limits);
                }
            }
            if v.get("type").and_then(Value::as_str) == Some("result") {
                let _ = out_app.emit_to("pet", "chat-busy", false);
            }
            let _ = out_app.emit_to("chat", "chat-event", v);
        }
        // Fim do processo: libera a vaga se ainda for o da vez.
        let chat = out_app.state::<Chat>();
        let mut inner = chat.0.lock().unwrap();
        if inner.generation == generation {
            if let Some(mut p) = inner.proc.take() {
                let _ = p.child.wait();
            }
        }
        drop(inner);
        let _ = out_app.emit_to("pet", "chat-busy", false);
        let _ = out_app.emit_to("chat", "chat-event", json!({ "type": "digitama_exit" }));
    });

    let err_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() {
                let _ = err_app.emit_to("chat", "chat-event", json!({ "type": "digitama_stderr", "text": line }));
            }
        }
    });

    Ok(Proc { child, stdin, signature: signature(s, prompt) })
}

/// `rate_limit_info.unifiedWindows` (0..1) → `{five_hour: {used_percentage, resets_at}, …}`.
fn usage_from_event(v: &Value) -> Option<Value> {
    let windows = v.get("rate_limit_info")?.get("unifiedWindows")?.as_object()?;
    let mut out = serde_json::Map::new();
    for (name, w) in windows {
        let util = w.get("utilization").and_then(Value::as_f64)?;
        out.insert(name.clone(), json!({ "used_percentage": (util * 1000.0).round() / 10.0, "resets_at": w.get("resetsAt") }));
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

fn user_line(text: &str, image_png_b64: Option<&str>) -> String {
    let mut content = Vec::new();
    if let Some(img) = image_png_b64.filter(|i| !i.is_empty()) {
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": img } }));
    }
    content.push(json!({ "type": "text", "text": text }));
    let mut line = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string();
    line.push('\n');
    line
}

/// Envia uma mensagem pelo provedor escolhido (Claude Code ou OpenCode).
pub fn send(app: &AppHandle, text: &str, image: Option<&str>, prompt: Option<&str>) -> Result<(), String> {
    let s = app.state::<Store>().get();
    if s.chat_provider == "opencode" {
        return send_opencode(app, &s, text, image, prompt);
    }
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    let wanted = signature(&s, prompt);
    let stale = match inner.proc.as_mut() {
        Some(p) => p.signature != wanted || matches!(p.child.try_wait(), Ok(Some(_))),
        None => true,
    };
    if stale {
        if let Some(mut old) = inner.proc.take() {
            let _ = old.child.kill();
        }
        inner.generation += 1;
        let resume = inner.session_id.clone();
        inner.proc = Some(spawn(app, &s, prompt, resume.as_deref(), inner.generation)?);
    }
    let line = user_line(text, image);
    let p = inner.proc.as_mut().expect("processo do chat");
    p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).map_err(|e| format!("O Claude Code fechou: {e}"))?;
    drop(inner);
    let _ = app.emit_to("pet", "chat-busy", true);
    Ok(())
}

/// O texto que vai para o OpenCode: a persona entra na primeira mensagem da
/// conversa (ou quando muda), já que o `opencode run` não tem prompt de sistema.
fn opencode_message(text: &str, persona: Option<&str>) -> String {
    match persona.filter(|p| !p.trim().is_empty()) {
        Some(p) => format!("Instruções de persona para toda esta conversa (siga sem mencioná-las):\n{p}\n\n---\n\n{text}"),
        None => text.to_string(),
    }
}

fn send_opencode(app: &AppHandle, s: &PetState, text: &str, image: Option<&str>, prompt: Option<&str>) -> Result<(), String> {
    use base64::Engine;
    let exe = crate::opencode::find_opencode(&s.opencode_path).ok_or(
        "Não achei o OpenCode. Instale (npm i -g opencode-ai), configure um provedor (opencode auth login) ou informe o caminho no Digivice.",
    )?;
    let dir = app.state::<Store>().data_dir().join("chat");
    let _ = std::fs::create_dir_all(&dir);

    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    if let Some(child) = inner.oc_child.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Err("O OpenCode ainda está respondendo a mensagem anterior.".into());
        }
    }

    let mut cmd = crate::opencode::command(&exe);
    cmd.args(["run", "--format", "json"]);
    if crate::opencode::valid_model(s.opencode_model.trim()) {
        cmd.args(["-m", s.opencode_model.trim()]);
    }
    if let Some(id) = inner.oc_session.clone() {
        cmd.args(["--session", &id]);
    }
    let mut temp = None;
    if let Some(img) = image.filter(|i| !i.is_empty()) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(img).map_err(|e| e.to_string())?;
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = dir.join(format!("print-{ms}.png"));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        cmd.arg("-f").arg(&path);
        temp = Some(path);
    }
    let persona = prompt.filter(|p| inner.oc_persona.as_deref() != Some(*p));
    let message = opencode_message(text, persona);

    cmd.current_dir(&dir)
        .env("DIGITAMA_INTERNAL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o OpenCode: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(message.as_bytes());
    } // o stdin fecha aqui: o OpenCode lê a mensagem inteira
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let stderr = child.stderr.take().ok_or("sem stderr")?;
    inner.generation += 1;
    let generation = inner.generation;
    inner.oc_persona = prompt.map(str::to_string);
    inner.oc_child = Some(child);
    drop(inner);
    let _ = app.emit_to("pet", "chat-busy", true);

    let err_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = err_app.emit_to("chat", "chat-event", json!({ "type": "digitama_stderr", "provider": "opencode", "text": line }));
            }
        }
    });
    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(mut v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = v.get("sessionID").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                let chat = out_app.state::<Chat>();
                let mut inner = chat.0.lock().unwrap();
                if inner.generation == generation {
                    inner.oc_session = Some(id.to_string());
                }
            }
            v["provider"] = json!("opencode");
            let _ = out_app.emit_to("chat", "chat-event", v);
        }
        let code = {
            let chat = out_app.state::<Chat>();
            let mut inner = chat.0.lock().unwrap();
            let child = if inner.generation == generation { inner.oc_child.take() } else { None };
            drop(inner);
            child.and_then(|mut c| c.wait().ok()).and_then(|st| st.code())
        };
        if let Some(path) = temp {
            let _ = std::fs::remove_file(path);
        }
        let _ = out_app.emit_to("pet", "chat-busy", false);
        let _ = out_app.emit_to("chat", "chat-event", json!({ "type": "digitama_exit", "provider": "opencode", "code": code }));
    });
    Ok(())
}

/// Interrompe a resposta atual (mata o processo) mas guarda a conversa.
pub fn stop(app: &AppHandle) {
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    inner.generation += 1;
    if let Some(mut p) = inner.proc.take() {
        let _ = p.child.kill();
    }
    if let Some(mut c) = inner.oc_child.take() {
        let _ = c.kill();
    }
    let _ = app.emit_to("pet", "chat-busy", false);
}

/// Nova conversa (nos dois provedores).
pub fn reset(app: &AppHandle) {
    stop(app);
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    inner.session_id = None;
    inner.oc_session = None;
    inner.oc_persona = None;
}

/// Roda o claude.exe com argumentos fixos (sem shell) e devolve stdout+stderr.
pub fn run_cli(custom: &str, args: &[&str]) -> Result<String, String> {
    let exe = find_claude(custom).ok_or("claude.exe não encontrado")?;
    let out = Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn path_display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mensagem_com_print_leva_a_imagem_antes_do_texto() {
        let line = user_line("o que é isso?", Some("AAAA"));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["text"], "o que é isso?");
        let only_text: Value = serde_json::from_str(user_line("oi", None).trim()).unwrap();
        assert_eq!(only_text["message"]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn uso_vem_do_rate_limit_event() {
        let ev = json!({"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.46,"resetsAt":1791993000},"seven_day":{"utilization":0.26,"resetsAt":1792501200}}}});
        let u = usage_from_event(&ev).unwrap();
        assert_eq!(u["five_hour"]["used_percentage"], 46.0);
        assert_eq!(u["seven_day"]["resets_at"], 1792501200);
        assert!(usage_from_event(&json!({"type":"x"})).is_none());
    }

    #[test]
    fn persona_do_opencode_vai_na_mensagem() {
        assert_eq!(opencode_message("oi", None), "oi");
        let m = opencode_message("oi", Some("Você é o Agumon."));
        assert!(m.starts_with("Instruções de persona"));
        assert!(m.contains("Você é o Agumon."));
        assert!(m.ends_with("oi"));
    }
}
