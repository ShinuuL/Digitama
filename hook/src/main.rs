//! digitama-hook — o relay que o Claude Code executa a cada evento de hook, e o
//! servidor MCP (stdio) que deixa o Claude usar o pet.
//!
//! Adaptado do `coucou-hook` (MIT, © Louis Raillé).
//!
//! Modo relay (padrão): lê o JSON do hook no stdin e entrega ao Digitama pelo
//! named pipe `\\.\pipe\digitama-<sid>`.
//!
//! Regra de ouro: **nunca travar o Claude Code.**
//! * Pipe inexistente (Digitama fechado) → sai com 0 na hora, sem opinião.
//! * Tudo roda sob prazo controlado pela thread principal.
//! * Só `PermissionRequest` espera resposta (aprovar/responder pelo balão). Sem
//!   resposta, nada é impresso e o Claude Code pergunta no próprio chat.
//!
//! Modo MCP: `digitama-hook --mcp` — servidor MCP com as ferramentas
//! `screenshot`, `pet_say`, `pet_attack` e `pet_status`. Registre com
//! `claude mcp add digitama -- "<caminho>\digitama-hook.exe" --mcp`.

use std::io::{BufRead, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Map, Value};

mod reply;
mod statusline;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(not(windows))]
fn connect() -> Option<std::fs::File> {
    None
}

/// Prazo para conseguir a conexão com o pipe.
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Orçamento total de um evento que ninguém espera.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// Quanto tempo um pedido pode ficar no balão antes do chat assumir.
const DECISION_BUDGET: Duration = Duration::from_secs(110);
/// Prazo de uma chamada MCP (o print da tela pode levar um instante).
const RPC_BUDGET: Duration = Duration::from_secs(20);

/// Campos inúteis para o pet e potencialmente enormes.
const DROPPED_FIELDS: &[&str] = &["tool_response", "tool_output", "transcript_path"];
const MAX_FIELD_LEN: usize = 2_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--statusline") {
        statusline::run();
    }
    if args.iter().any(|a| a == "--mcp") {
        mcp::run();
        return;
    }
    let (agent, event_arg) = parse_args(&args);

    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);

    let Some(event) = prepare(&raw, &event_arg, &agent) else {
        std::process::exit(0);
    };

    let waits = event.name == "PermissionRequest";
    let budget = if waits { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    let (tx, rx) = mpsc::channel::<Option<String>>();
    let line = event.line.clone();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&line, waits));
    });

    let decision = rx.recv_timeout(budget).ok().flatten();
    if waits {
        if let Some(out) = decision.and_then(|d| reply::stdout_for(&agent, &d, event.question.as_ref())) {
            let mut stdout = std::io::stdout();
            let _ = writeln!(stdout, "{out}");
            let _ = stdout.flush();
        }
    }
    std::process::exit(0);
}

/// `[--agent <nome>] [<Evento>]`. Sem `--agent`, é o Claude Code.
fn parse_args(args: &[String]) -> (String, String) {
    let mut agent = String::new();
    let mut event = String::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--agent" {
            agent = it.next().cloned().unwrap_or_default().to_lowercase();
        } else if !a.starts_with("--") && event.is_empty() {
            event = a.clone();
        }
    }
    (agent, event)
}

struct Event {
    line: String,
    name: String,
    /// O AskUserQuestion como foi perguntado, inteiro (a resposta volta sobre ele).
    question: Option<Value>,
}

fn prepare(raw: &[u8], event_arg: &str, agent: &str) -> Option<Event> {
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    let mut payload = serde_json::from_slice::<Value>(raw).ok()?;
    let map = payload.as_object_mut()?;

    let name = map
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| event_arg.to_string());
    map.insert("hook_event_name".into(), Value::String(name.clone()));

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }
    if map.get("cwd").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert("cwd".into(), Value::String(cwd.to_string_lossy().into_owned()));
        }
    }
    // Qual agente mandou: vazio é o Claude Code (o pet mostra o nome no balão).
    let agent = if agent.is_empty() { "claude" } else { agent };
    map.insert("digitama_agent".into(), Value::String(agent.to_string()));
    // Sessões abertas pelo próprio chat do Digitama: o pet não comemora a si mesmo.
    if std::env::var("DIGITAMA_INTERNAL").is_ok_and(|v| v == "1") {
        map.insert("digitama_internal".into(), Value::Bool(true));
    }
    for (key, var) in [("term_program", "TERM_PROGRAM"), ("vscode_pid", "VSCODE_PID")] {
        if let Ok(v) = std::env::var(var) {
            map.insert(key.into(), Value::String(v));
        }
    }

    let question = (agent == "claude" && map.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion"))
        .then(|| map.get("tool_input").cloned())
        .flatten();

    truncate_strings(&mut payload);
    let mut line = payload.to_string();
    line.push('\n');
    Some(Event { line, name, question })
}

pub(crate) fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => cut(s, MAX_FIELD_LEN),
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

fn cut(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('…');
}

/// Conecta, envia e — se `waits` — espera uma linha de resposta.
pub(crate) fn talk(payload: &str, waits: bool) -> Option<String> {
    let mut pipe = connect()?;
    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();
    if !waits {
        return None;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

/// Uma chamada ao app com prazo: `None` se o Digitama não respondeu.
fn rpc(request: Value) -> Option<Value> {
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let mut line = request.to_string();
    line.push('\n');
    std::thread::spawn(move || {
        let _ = tx.send(talk(&line, true));
    });
    let answer = rx.recv_timeout(RPC_BUDGET).ok().flatten()?;
    serde_json::from_str(&answer).ok()
}

mod mcp {
    //! Servidor MCP mínimo: JSON-RPC 2.0, uma mensagem por linha no stdio.
    use super::*;

    const PROTOCOL: &str = "2025-06-18";

    fn tools() -> Value {
        json!([
            {
                "name": "screenshot",
                "description": "Tira um print da tela do usuário (o monitor onde está o cursor, ou todos) e devolve a imagem. Use quando o usuário pedir para você olhar a tela dele.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "monitor": { "type": "string", "enum": ["cursor", "all"], "description": "cursor = só o monitor do mouse (padrão); all = todos os monitores" }
                    }
                }
            },
            {
                "name": "pet_say",
                "description": "Faz o Digimon do usuário (o pet Digitama na área de trabalho) mostrar um balão com uma mensagem curta.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "text": { "type": "string", "description": "Mensagem curta (até ~140 caracteres)" } },
                    "required": ["text"]
                }
            },
            {
                "name": "pet_attack",
                "description": "Faz o Digimon do usuário soltar o ataque especial dele (comemoração).",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "pet_status",
                "description": "Diz qual Digimon o usuário tem, o estágio e a experiência.",
                "inputSchema": { "type": "object", "properties": {} }
            }
        ])
    }

    pub fn run() {
        let stdin = std::io::stdin();
        let mut out = std::io::stdout();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = msg.get("id").cloned() else { continue }; // notificação
            let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let reply = match method {
                "initialize" => Ok(json!({
                    "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "digitama", "version": env!("CARGO_PKG_VERSION") }
                })),
                "ping" => Ok(json!({})),
                "tools/list" => Ok(json!({ "tools": tools() })),
                "tools/call" => Ok(call(&params)),
                _ => Err(json!({ "code": -32601, "message": format!("método desconhecido: {method}") })),
            };
            let mut resp = Map::new();
            resp.insert("jsonrpc".into(), json!("2.0"));
            resp.insert("id".into(), id);
            match reply {
                Ok(r) => resp.insert("result".into(), r),
                Err(e) => resp.insert("error".into(), e),
            };
            let _ = writeln!(out, "{}", Value::Object(resp));
            let _ = out.flush();
        }
    }

    fn text(t: impl Into<String>, error: bool) -> Value {
        json!({ "content": [{ "type": "text", "text": t.into() }], "isError": error })
    }

    const OFFLINE: &str = "O Digitama não está aberto (ou não respondeu). Abra o app Digitama e tente de novo.";

    fn call(params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        match name {
            "screenshot" => {
                let monitor = args.get("monitor").and_then(Value::as_str).unwrap_or("cursor");
                match rpc(json!({ "digitama_rpc": "screenshot", "monitor": monitor })) {
                    Some(r) if r.get("ok") == Some(&json!(true)) => {
                        let data = r.get("png").and_then(Value::as_str).unwrap_or_default();
                        let w = r.get("width").and_then(Value::as_u64).unwrap_or(0);
                        let h = r.get("height").and_then(Value::as_u64).unwrap_or(0);
                        json!({ "content": [
                            { "type": "image", "data": data, "mimeType": "image/png" },
                            { "type": "text", "text": format!("Print da tela ({w}×{h}).") }
                        ]})
                    }
                    Some(r) => text(r.get("error").and_then(Value::as_str).unwrap_or("Falha no print."), true),
                    None => text(OFFLINE, true),
                }
            }
            "pet_say" => {
                let t = args.get("text").and_then(Value::as_str).unwrap_or_default();
                match rpc(json!({ "digitama_rpc": "say", "text": t })) {
                    Some(_) => text("Mensagem mostrada no balão do pet.", false),
                    None => text(OFFLINE, true),
                }
            }
            "pet_attack" => match rpc(json!({ "digitama_rpc": "attack" })) {
                Some(_) => text("Ataque disparado!", false),
                None => text(OFFLINE, true),
            },
            "pet_status" => match rpc(json!({ "digitama_rpc": "status" })) {
                Some(r) => text(r.to_string(), false),
                None => text(OFFLINE, true),
            },
            _ => text(format!("Ferramenta desconhecida: {name}"), true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn um_payload_normal_passa_e_campos_pesados_somem() {
        let ev = prepare(br#"{"hook_event_name":"Stop","cwd":"C:/p","tool_response":"x"}"#, "", "").unwrap();
        let v: Value = serde_json::from_str(ev.line.trim()).unwrap();
        assert_eq!(ev.name, "Stop");
        assert_eq!(v["digitama_agent"], "claude");
        assert!(v.get("tool_response").is_none());
        assert_eq!(v["cwd"], "C:/p");
    }

    #[test]
    fn a_pergunta_fica_inteira_so_para_ask_user_question() {
        let long = "x".repeat(3000);
        let raw = format!(r#"{{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{{"questions":[{{"question":"{long}"}}]}}}}"#);
        let ev = prepare(raw.as_bytes(), "", "").unwrap();
        assert_eq!(ev.question.unwrap()["questions"][0]["question"].as_str().unwrap().len(), 3000);
        let ev = prepare(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#, "", "").unwrap();
        assert!(ev.question.is_none());
        // só o Claude Code tem AskUserQuestion
        let ev = prepare(raw.as_bytes(), "", "opencode").unwrap();
        assert!(ev.question.is_none());
    }

    #[test]
    fn lixo_nao_e_repassado_e_bom_nao_atrapalha() {
        assert!(prepare(b"nada", "", "").is_none());
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"hook_event_name":"Stop"}"#);
        assert!(prepare(&bom, "", "").is_some());
    }

    #[test]
    fn argumentos_com_e_sem_agente() {
        let a = |v: &[&str]| parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(a(&["Stop"]), ("".into(), "Stop".into()));
        assert_eq!(a(&["--agent", "OpenCode", "PermissionRequest"]), ("opencode".into(), "PermissionRequest".into()));
        assert_eq!(a(&["--agent", "opencode"]), ("opencode".into(), "".into()));
        let ev = prepare(br#"{"hook_event_name":"Stop"}"#, "", "opencode").unwrap();
        let v: Value = serde_json::from_str(ev.line.trim()).unwrap();
        assert_eq!(v["digitama_agent"], "opencode");
    }
}
