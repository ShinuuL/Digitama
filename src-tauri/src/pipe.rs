//! Servidor do relay: o named pipe `\\.\pipe\digitama-<sid>`, uma instância por
//! conexão. Adaptado do `pipe.rs` do Coucou (MIT, © Louis Raillé).
//!
//! Cada evento de hook vira o evento `hook` na janela do pet. `PermissionRequest`
//! é o único que mantém a conexão aberta: espera a decisão do balão e a escreve
//! de volta — `allow`, `deny` ou `{"answers":{…}}` para um AskUserQuestion.
//!
//! O Claude Code nunca fica preso por nossa causa:
//!   * o relay dá 300 ms para conectar e sai limpo se o app estiver fechado;
//!   * só esperamos um humano depois que o pet *confirmou* que o balão está na
//!     tela (ACK_TIMEOUT);
//!   * passado o DECISION_TIMEOUT a conexão cai e o chat do Claude assume.
//!
//! Linhas com `digitama_rpc` vêm do servidor MCP (`digitama-hook --mcp`): print
//! da tela, falas e ataques. Só são atendidas se o cliente roda como o mesmo
//! usuário do Windows.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::store::Store;

/// Um pouco menos que os 110 s do relay, para respondermos sempre antes.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
const ACK_TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_PAYLOAD: usize = 1 << 20;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub enum Reply {
    Ack,
    Decision(String),
    Decline,
}

#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

/// Os últimos limites do plano do Claude (`rate_limits` da barra de status).
#[derive(Default)]
pub struct Usage(pub Mutex<Option<Value>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn pipe_name() -> String {
    let key = crate::winsys::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\digitama-{key}")
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance: nunca servir por cima de um pipe que já tem dono.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("[digitama] não abri o pipe do relay: {err}");
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    eprintln!("[digitama] não reabri o pipe do relay: {err}");
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle(app: AppHandle, mut pipe: NamedPipeServer) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let read_line = async {
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) => return true,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                        return true;
                    }
                }
                Err(_) => return false,
            }
        }
    };
    // um cliente que conecta e não manda nada não segura a conexão para sempre
    if !matches!(tokio::time::timeout(READ_TIMEOUT, read_line).await, Ok(true)) {
        return;
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    if let Some(rpc) = payload.get("digitama_rpc").and_then(Value::as_str).map(str::to_string) {
        use std::os::windows::io::AsRawHandle;
        let trusted = crate::winsys::pipe_client_pid(pipe.as_raw_handle())
            .is_some_and(crate::winsys::pid_is_same_user);
        let answer = if trusted { serve_rpc(&app, &rpc, &payload).await } else { json!({ "ok": false, "error": "cliente recusado" }) };
        let _ = pipe.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = pipe.flush().await;
        drain_then_disconnect(pipe).await;
        return;
    }

    let event = payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default().to_string();
    // a faixa de sessões do chat acompanha o que cada sessão está fazendo
    if crate::sessions::on_hook(&app.state::<crate::sessions::Live>(), &payload) {
        let _ = app.emit_to("chat", "sessions-changed", ());
    }
    if event == "StatusLine" {
        // uso do plano do Claude (vem da barra de status): guarda e avisa as janelas
        if let Some(limits) = payload.get("rate_limits").cloned() {
            *app.state::<Usage>().0.lock().unwrap() = Some(limits.clone());
            let _ = app.emit("usage", limits);
        }
        let _ = pipe.disconnect();
        return;
    }
    if event != "PermissionRequest" {
        let _ = app.emit_to("pet", "hook", payload);
        let _ = pipe.disconnect();
        return;
    }
    // Do próprio chat do Digitama: a permissão é pedida no chat (control_request),
    // não no balão do pet. Sem resposta aqui, o Claude Code pergunta lá.
    if payload.get("digitama_internal").and_then(Value::as_bool) == Some(true) {
        let _ = pipe.disconnect();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    payload["request_id"] = json!(id);
    let _ = app.emit_to("pet", "hook", payload);

    let decision = wait_for_decision(&mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // Sem decisão: silêncio, e o Claude Code pergunta no próprio chat.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    drain_then_disconnect(pipe).await;
}

/// `DisconnectNamedPipe` descarta o que o cliente ainda não leu — um print de
/// 1 MB se perdia assim. Espera o relay fechar a ponta dele (a leitura dá 0 ou
/// erro) por até 5 s, e só então desconecta.
async fn drain_then_disconnect(mut pipe: NamedPipeServer) {
    let mut byte = [0u8; 1];
    let _ = tokio::time::timeout(Duration::from_secs(5), pipe.read(&mut byte)).await;
    let _ = pipe.disconnect();
}

async fn serve_rpc(app: &AppHandle, rpc: &str, payload: &Value) -> Value {
    match rpc {
        "screenshot" if payload.get("janela").is_some() || payload.get("janela_id").is_some() => {
            let payload = payload.clone();
            let res = tauri::async_runtime::spawn_blocking(move || window_shot(&payload)).await;
            match res {
                Ok(Ok(v)) => {
                    if v.get("png").is_some() {
                        let _ = app.emit_to("pet", "pet-flash", ());
                    }
                    v
                }
                Ok(Err(e)) => json!({ "ok": false, "error": e }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "screenshot" => {
            let all = payload.get("monitor").and_then(Value::as_str) == Some("all");
            let shot = tauri::async_runtime::spawn_blocking(move || crate::screen::capture(all)).await;
            match shot {
                Ok(Ok(s)) => {
                    let _ = app.emit_to("pet", "pet-flash", ());
                    json!({ "ok": true, "png": s.png_base64, "width": s.width, "height": s.height })
                }
                Ok(Err(e)) => json!({ "ok": false, "error": e }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "say" => {
            let text: String = payload.get("text").and_then(Value::as_str).unwrap_or_default().chars().take(280).collect();
            let _ = app.emit_to("pet", "pet-say", text);
            json!({ "ok": true })
        }
        "attack" => {
            let _ = app.emit_to("pet", "pet-attack", ());
            json!({ "ok": true })
        }
        "status" => {
            let s = app.state::<Store>().get();
            json!({
                "ok": true,
                "digimon": s.current_name,
                "apelido": s.nickname,
                "linha": s.line,
                "estagio": s.current_stage,
                "xp": s.xp,
                "tarefas_concluidas": s.tasks_done,
                "uso_claude": app.state::<Usage>().0.lock().unwrap().clone(),
            })
        }
        other => json!({ "ok": false, "error": format!("rpc desconhecido: {other}") }),
    }
}

/// Print de uma janela (ferramenta MCP `screenshot` com `janela`). Com mais de
/// uma janela pelo título, devolve a lista para o agente escolher pelo id.
/// Com `pasta` (caminho absoluto, já resolvido pelo relay), grava o PNG em
/// resolução cheia lá: o print vira a evidência da validação.
fn window_shot(payload: &Value) -> Result<Value, String> {
    use crate::screen;
    let hwnd = match payload.get("janela_id").and_then(Value::as_i64) {
        Some(id) => id as isize,
        None => {
            let query = payload.get("janela").and_then(Value::as_str).unwrap_or_default();
            if query.trim().is_empty() {
                return Err("informe parte do título da janela".into());
            }
            let found = screen::find_windows(query);
            match found.len() {
                0 => return Err(format!("nenhuma janela aberta com \"{query}\" no título")),
                1 => found[0].hwnd,
                _ => {
                    let list: Vec<Value> =
                        found.iter().map(|w| json!({ "janela_id": w.hwnd as i64, "titulo": w.title })).collect();
                    return Ok(json!({ "ok": true, "janelas": list }));
                }
            }
        }
    };
    let folder = payload.get("pasta").and_then(Value::as_str).filter(|s| !s.trim().is_empty());
    let shot = screen::capture_window(hwnd, folder.is_some())?;
    let mut saved = Value::Null;
    if let (Some(folder), Some(bytes)) = (folder, &shot.full_png) {
        let dir = std::path::PathBuf::from(folder);
        std::fs::create_dir_all(&dir).map_err(|e| format!("não criei a pasta {folder}: {e}"))?;
        let name = match payload.get("nome").and_then(Value::as_str).map(|n| screen::file_slug(n.trim_end_matches(".png"))) {
            Some(n) => format!("{n}.png"),
            None => format!("{}_{}.png", screen::local_stamp(), screen::file_slug(&shot.title)),
        };
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("não gravei {}: {e}", path.display()))?;
        saved = json!(path.to_string_lossy());
    }
    Ok(json!({
        "ok": true,
        "png": shot.shot.png_base64,
        "width": shot.shot.width,
        "height": shot.shot.height,
        "titulo": shot.title,
        "em_branco": shot.blank,
        "arquivo": saved,
    }))
}

async fn wait_for_decision(rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        Ok(Some(Reply::Decision(d))) => return Some(d),
        _ => return None,
    }
    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => Some(d),
        _ => None,
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    if let Some(tx) = sender {
        let _ = tx.try_send(reply);
    }
}

/// O balão está na tela: a espera longa pode começar.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Ninguém vai responder por aqui (outro balão ocupa o pet, ou "responder no chat").
pub fn decline(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Decline, false);
}

/// Permitir / Negar. Só uma palavra: o JSON do Claude Code é feito no relay.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = if decision == "allow" { "allow" } else { "deny" };
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// Respostas de um AskUserQuestion: texto da pergunta → rótulo (ou lista).
pub fn answer_question(app: &AppHandle, request_id: &str, answers: &serde_json::Map<String, Value>) {
    let line = json!({ "answers": answers }).to_string();
    send(app, request_id, Reply::Decision(line), false);
}
