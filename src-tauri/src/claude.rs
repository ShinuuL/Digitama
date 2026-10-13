//! O chat com o Claude passa pelo próprio Claude Code (`claude.exe`), logado
//! com a sua conta claude.ai (OAuth) — nenhuma chave de API no Digitama. Isso
//! também traz de graça os seus servidores MCP e os conectores do claude.ai que
//! o Claude Code já enxerga.
//!
//! Um processo fica vivo por conversa, em modo stream-json nos dois sentidos:
//! cada mensagem (texto + print opcional) entra no stdin e cada linha do stdout
//! vira o evento `chat-event` na janela do chat. Mudou a persona, o modelo ou as
//! ferramentas? O processo é refeito com `--resume`, mantendo a conversa.

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

/// Envia uma mensagem, abrindo (ou refazendo) o processo se preciso.
pub fn send(app: &AppHandle, text: &str, image: Option<&str>, prompt: Option<&str>) -> Result<(), String> {
    let s = app.state::<Store>().get();
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

/// Interrompe a resposta atual (mata o processo) mas guarda a conversa.
pub fn stop(app: &AppHandle) {
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    inner.generation += 1;
    if let Some(mut p) = inner.proc.take() {
        let _ = p.child.kill();
    }
    let _ = app.emit_to("pet", "chat-busy", false);
}

/// Nova conversa.
pub fn reset(app: &AppHandle) {
    stop(app);
    app.state::<Chat>().0.lock().unwrap().session_id = None;
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
}
