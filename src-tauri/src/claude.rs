//! O chat com o Claude passa pelo próprio Claude Code (`claude.exe`), logado
//! com a sua conta claude.ai (OAuth) — nenhuma chave de API no Digitama. Isso
//! também traz de graça os seus servidores MCP e os conectores do claude.ai que
//! o Claude Code já enxerga.
//!
//! Várias conversas ao mesmo tempo, cada uma com o seu processo vivo, em modo
//! stream-json nos dois sentidos:
//! cada mensagem (texto + print opcional) entra no stdin e cada linha do stdout
//! vira o evento `chat-event` na janela do chat. Mudou a persona, o modelo ou as
//! ferramentas? O processo é refeito com `--resume`, mantendo a conversa.
//!
//! Permissões: o processo roda com `--permission-prompts host
//! --permission-prompt-tool stdio`, então cada ferramenta que precisa de
//! aprovação chega como `control_request` (`can_use_tool`) no stdout, vira um
//! cartão no chat e só segue com a resposta (`control_response`) do seu clique.
//! Sem clique, nada é permitido.
//!
//! Com o provedor OpenCode, cada mensagem é um `opencode run --format json`
//! (mensagem pelo stdin, print com `-f`, conversa continuada com `--session`):
//! o OpenCode usa os provedores e o login que você configurou nele.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{PetState, SavedConv, Store};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// As conversas do chat, cada uma com o seu `claude.exe`: dá para trocar de
/// conversa (ou abrir outra) enquanto uma responde, como na extensão do VS Code.
#[derive(Default)]
pub struct Chat(Mutex<Chats>);

#[derive(Default)]
struct Chats {
    /// Na ordem das abas.
    convs: Vec<Conv>,
    next: u64,
    /// As conversas guardadas já foram trazidas do state.json.
    loaded: bool,
}

#[derive(Default)]
struct Conv {
    key: String,
    title: String,
    /// Pasta onde trabalha (escolhida por você); "" = a pasta do Digitama.
    cwd: String,
    /// A sessão do VS Code que esta conversa continua (como cópia).
    source: String,
    proc: Option<Proc>,
    session_id: Option<String>,
    /// A próxima abertura retoma `session_id` como cópia (`--fork-session`):
    /// uma sessão do VS Code continuada aqui sem mexer na original.
    fork_pending: bool,
    generation: u64,
    /// Respondendo agora (do envio até o `result` ou o fim do processo).
    busy: bool,
    /// Pedidos de permissão e perguntas esperando o seu clique (id → o pedido).
    permissions: HashMap<String, Value>,
    /// Muda no "Nova": eventos de um processo antigo não entram no registro.
    epoch: u64,
    /// O que a página precisa para redesenhar a conversa (trocar de aba,
    /// recarregar): ver `record`.
    log: VecDeque<Value>,
    /// OpenCode: a resposta em andamento, a sessão e a persona já enviada nela.
    oc_child: Option<Child>,
    oc_session: Option<String>,
    oc_persona: Option<String>,
}

const NEW_TITLE: &str = "Nova conversa";

struct Proc {
    child: Child,
    stdin: ChildStdin,
    signature: String,
}

/// Uma conversa como a página a mostra (lista das abas).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvInfo {
    pub key: String,
    pub title: String,
    pub cwd: String,
    pub source: String,
    pub busy: bool,
    /// Há pergunta ou permissão esperando você.
    pub waiting: bool,
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

fn signature(s: &PetState, cwd: &str, prompt: Option<&str>) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        s.model,
        s.allowed_tools,
        s.force_oauth,
        permission_mode(s),
        effort(s).unwrap_or_default(),
        cwd,
        s.chat_mcp_off.join(","),
        prompt.unwrap_or_default()
    )
}

/// Tira do ambiente o que identifica uma sessão do Claude Code: aberto de um
/// terminal do VS Code (o `tauri dev`), o Digitama herda `CLAUDECODE`, o id da
/// sessão, o socket de mensagens, `CLAUDE_EFFORT`… e o `claude.exe` dele se
/// apresentava como filho daquela sessão.
pub fn clean_env(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy();
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k.starts_with("CLAUDE_AGENT_SDK") || k == "CLAUDE_EFFORT" {
            cmd.env_remove(&key);
        }
    }
}

/// O `gh` (GitHub CLI), se estiver instalado.
pub fn find_gh() -> Option<PathBuf> {
    let from_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join("gh.exe")).find(|p| p.exists()));
    from_path.or_else(|| {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_default();
        Some(pf.join("GitHub CLI").join("gh.exe")).filter(|p| p.exists())
    })
}

/// Consultas do `gh` só de leitura, liberadas sem perguntar; o resto (criar PR,
/// comentar, fechar issue) passa pelo cartão de permissão.
const GH_READ_ONLY: &[&str] = &[
    "Bash(gh pr view *)",
    "Bash(gh pr list *)",
    "Bash(gh pr status *)",
    "Bash(gh pr checks *)",
    "Bash(gh pr diff *)",
    "Bash(gh issue view *)",
    "Bash(gh issue list *)",
    "Bash(gh repo view *)",
    "Bash(gh run list *)",
    "Bash(gh run view *)",
];

/// O esforço de pensamento escolhido no chat (`--effort`), se for um válido.
fn effort(s: &PetState) -> Option<&str> {
    let e = s.chat_effort.trim();
    ["low", "medium", "high", "xhigh", "max"].contains(&e).then_some(e)
}

/// Um anexo do chat: imagem ou PDF em base64, ou um arquivo de texto (o texto
/// colado grande também vira um).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// "image", "pdf" ou "text".
    pub kind: String,
    pub name: String,
    pub media_type: String,
    /// Base64 (imagem, PDF) ou o próprio texto.
    pub data: String,
}

const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Só os modos que ainda passam por você; nunca o que pula as permissões.
fn permission_mode(s: &PetState) -> &str {
    match s.chat_permission_mode.as_str() {
        m @ ("auto" | "acceptEdits" | "plan") => m,
        _ => "manual",
    }
}

// ── As conversas ─────────────────────────────────────────────────────────────

impl Chats {
    fn find(&mut self, key: &str) -> Option<&mut Conv> {
        self.convs.iter_mut().find(|c| c.key == key)
    }

    fn create(&mut self, cwd: &str) -> String {
        self.next += 1;
        let key = format!("c{}", self.next);
        self.convs.push(Conv { key: key.clone(), title: NEW_TITLE.into(), cwd: cwd.into(), ..Default::default() });
        key
    }

    fn infos(&self) -> Vec<ConvInfo> {
        self.convs
            .iter()
            .map(|c| ConvInfo {
                key: c.key.clone(),
                title: c.title.clone(),
                cwd: c.cwd.clone(),
                source: c.source.clone(),
                busy: c.busy,
                waiting: !c.permissions.is_empty(),
            })
            .collect()
    }
}

/// As conversas (na primeira vez, as guardadas no state.json voltam, cada uma
/// pronta para continuar a sua sessão na próxima mensagem).
fn chats(app: &AppHandle) -> std::sync::MutexGuard<'_, Chats> {
    let mut g = app.state::<Chat>().inner().0.lock().unwrap();
    if !g.loaded {
        g.loaded = true;
        for s in app.state::<Store>().get().chat_convs {
            let (session_id, fork_pending) = if crate::sessions::valid_id(&s.session) {
                (Some(s.session.clone()), false)
            } else if crate::sessions::valid_id(&s.source) {
                (Some(s.source.clone()), true)
            } else {
                (None, false)
            };
            let title = if s.title.trim().is_empty() { NEW_TITLE.to_string() } else { s.title };
            g.convs.push(Conv { key: s.key, title, cwd: s.cwd, source: s.source, session_id, fork_pending, ..Default::default() });
        }
        g.convs.retain(|c| !c.key.is_empty());
        g.next = g.convs.iter().filter_map(|c| c.key.trim_start_matches('c').parse::<u64>().ok()).max().unwrap_or(0);
        if g.convs.is_empty() {
            g.create("");
        }
    }
    g
}

/// Guarda as conversas abertas (para o app reabrir com elas).
fn save(app: &AppHandle, g: &Chats) {
    let list: Vec<SavedConv> = g
        .convs
        .iter()
        .map(|c| SavedConv {
            key: c.key.clone(),
            title: c.title.clone(),
            cwd: c.cwd.clone(),
            session: if c.fork_pending { String::new() } else { c.session_id.clone().unwrap_or_default() },
            source: c.source.clone(),
        })
        .collect();
    app.state::<Store>().update_quiet(|s| s.chat_convs = list);
}

/// Avisa a página (abas: título, trabalhando, esperando você) e o pet.
fn changed(app: &AppHandle, g: &Chats) {
    let _ = app.emit_to("chat", "chat-convs", g.infos());
    let _ = app.emit_to("pet", "chat-busy", g.convs.iter().any(|c| c.busy));
}

/// Um evento da conversa `key` para a página.
fn emit(app: &AppHandle, key: &str, mut v: Value) {
    v["digitama_conv"] = json!(key);
    let _ = app.emit_to("chat", "chat-event", v);
}

/// O título de uma conversa nova: o começo da primeira mensagem.
fn short_title(text: &str) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= 40 {
        one
    } else {
        format!("{}…", one.chars().take(40).collect::<String>().trim_end())
    }
}

pub fn list(app: &AppHandle) -> Vec<ConvInfo> {
    chats(app).infos()
}

/// Uma conversa nova trabalhando em `cwd` ("" = a pasta do Digitama).
pub fn create(app: &AppHandle, cwd: &str) -> String {
    let mut g = chats(app);
    let key = g.create(cwd);
    save(app, &g);
    changed(app, &g);
    key
}

/// Fecha a conversa (para o que ela estava fazendo). Sempre sobra uma.
pub fn close(app: &AppHandle, key: &str) {
    stop(app, key);
    let mut g = chats(app);
    g.convs.retain(|c| c.key != key);
    if g.convs.is_empty() {
        g.create("");
    }
    save(app, &g);
    changed(app, &g);
}

fn spawn(app: &AppHandle, s: &PetState, prompt: Option<&str>, c: &Conv, fork: bool) -> Result<Proc, String> {
    let exe = find_claude(&s.claude_path)
        .ok_or("Não achei o claude.exe. Instale o Claude Code e faça login (claude → /login), ou informe o caminho nas Configurações.")?;
    let dir = work_dir_for(app, &c.cwd);
    let _ = std::fs::create_dir_all(&dir);

    let mut cmd = Command::new(&exe);
    clean_env(&mut cmd);
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
    if let Some(e) = effort(s) {
        cmd.args(["--effort", e]);
    }
    let gh = find_gh().is_some();
    let mut allowed: Vec<&str> = s.allowed_tools.split(',').map(str::trim).filter(|t| !t.is_empty()).collect();
    if gh {
        allowed.extend(GH_READ_ONLY);
    }
    if !allowed.is_empty() {
        cmd.args(["--allowedTools", &allowed.join(",")]);
    }
    // MCPs desligados no chat: nenhuma ferramenta deles
    let off: Vec<String> = s.chat_mcp_off.iter().filter(|n| crate::sessions::valid_mcp(n)).map(|n| format!("mcp__{n}")).collect();
    if !off.is_empty() {
        cmd.args(["--disallowedTools", &off.join(",")]);
    }
    let mut extra: Vec<&str> = prompt.filter(|p| !p.trim().is_empty()).into_iter().collect();
    if gh {
        extra.push("O GitHub CLI (`gh`) está instalado e logado nesta máquina: use-o para PRs, issues e checks do CI quando ajudar.");
    }
    if !extra.is_empty() {
        cmd.args(["--append-system-prompt", &extra.join("\n\n")]);
    }
    cmd.args(["--permission-mode", permission_mode(s), "--permission-prompts", "host", "--permission-prompt-tool", "stdio"]);
    if let Some(id) = c.session_id.as_deref() {
        cmd.args(["--resume", id]);
        if fork {
            cmd.arg("--fork-session");
        }
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
    let (key, generation, epoch) = (c.key.clone(), c.generation, c.epoch);

    let out_app = app.clone();
    let out_key = key.clone();
    std::thread::spawn(move || {
        let (app, key) = (out_app, out_key);
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let kind = v.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
            {
                let mut g = chats(&app);
                let mut dirty = false;
                if let Some(c) = g.find(&key).filter(|c| c.generation == generation) {
                    if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                        if c.session_id.as_deref() != Some(id) {
                            c.session_id = Some(id.to_string());
                            dirty = true;
                        }
                    }
                    match kind.as_str() {
                        // pedido de permissão ou pergunta: guarda até o clique
                        "control_request" => {
                            if let (Some(id), Some(req)) = (v.get("request_id").and_then(Value::as_str), v.get("request")) {
                                c.permissions.insert(id.to_string(), req.clone());
                                let _ = app.emit_to("pet", "chat-ask", c.title.clone());
                            }
                        }
                        "control_cancel_request" => {
                            if let Some(id) = v.get("request_id").and_then(Value::as_str) {
                                c.permissions.remove(id);
                            }
                        }
                        "result" => c.busy = false,
                        _ => {}
                    }
                }
                if dirty {
                    save(&app, &g);
                }
                if matches!(kind.as_str(), "control_request" | "control_cancel_request" | "result") || dirty {
                    changed(&app, &g);
                }
            }
            // Os limites do plano chegam no rate_limit_event: viram o mesmo formato da barra de status.
            if kind == "rate_limit_event" {
                if let Some(limits) = usage_from_event(&v) {
                    *app.state::<crate::pipe::Usage>().0.lock().unwrap() = Some(limits.clone());
                    let _ = app.emit("usage", limits);
                }
            }
            record(&app, &key, epoch, &v);
            emit(&app, &key, v);
        }
        // Fim do processo: libera a vaga se ainda for o da vez.
        {
            let mut g = chats(&app);
            if let Some(c) = g.find(&key).filter(|c| c.generation == generation) {
                if let Some(mut p) = c.proc.take() {
                    let _ = p.child.wait();
                }
                c.busy = false;
                c.permissions.clear();
            }
            changed(&app, &g);
        }
        let exit = json!({ "type": "digitama_exit" });
        record(&app, &key, epoch, &exit);
        emit(&app, &key, exit);
    });

    let err_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() {
                emit(&err_app, &key, json!({ "type": "digitama_stderr", "text": line }));
            }
        }
    });

    Ok(Proc { child, stdin, signature: signature(s, &c.cwd, prompt) })
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

/// A mensagem do usuário em stream-json: imagens e PDFs primeiro, depois os
/// arquivos de texto (com o nome) e por fim o que você escreveu.
fn user_line(text: &str, attachments: &[Attachment]) -> String {
    let mut content = Vec::new();
    for a in attachments {
        match a.kind.as_str() {
            "image" if IMAGE_TYPES.contains(&a.media_type.as_str()) => content
                .push(json!({ "type": "image", "source": { "type": "base64", "media_type": a.media_type, "data": a.data } })),
            "pdf" => content.push(json!({
                "type": "document",
                "title": a.name,
                "source": { "type": "base64", "media_type": "application/pdf", "data": a.data },
            })),
            _ => {}
        }
    }
    for a in attachments.iter().filter(|a| a.kind == "text") {
        content.push(json!({ "type": "text", "text": format!("Arquivo anexado: {}\n```\n{}\n```", a.name, a.data) }));
    }
    content.push(json!({ "type": "text", "text": text }));
    let mut line = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string();
    line.push('\n');
    line
}

/// Envia uma mensagem na conversa `key`, pelo provedor escolhido (Claude Code ou OpenCode).
pub fn send(app: &AppHandle, key: &str, text: &str, attachments: &[Attachment], prompt: Option<&str>) -> Result<(), String> {
    let s = app.state::<Store>().get();
    if s.chat_provider == "opencode" {
        return send_opencode(app, &s, key, text, attachments, prompt);
    }
    let mut g = chats(app);
    let c = g.find(key).ok_or("Essa conversa foi fechada.")?;
    let wanted = signature(&s, &c.cwd, prompt);
    let stale = match c.proc.as_mut() {
        Some(p) => p.signature != wanted || matches!(p.child.try_wait(), Ok(Some(_))),
        None => true,
    };
    if stale {
        if let Some(mut old) = c.proc.take() {
            let _ = old.child.kill();
        }
        c.generation += 1;
        c.permissions.clear();
        let fork = std::mem::take(&mut c.fork_pending);
        let proc = spawn(app, &s, prompt, c, fork)?;
        c.proc = Some(proc);
    }
    push_log(c, user_event(text, attachments));
    if c.title == NEW_TITLE {
        c.title = short_title(text);
    }
    let line = user_line(text, attachments);
    let p = c.proc.as_mut().expect("processo do chat");
    p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).map_err(|e| format!("O Claude Code fechou: {e}"))?;
    c.busy = true;
    save(app, &g);
    changed(app, &g);
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

fn send_opencode(app: &AppHandle, s: &PetState, key: &str, text: &str, attachments: &[Attachment], prompt: Option<&str>) -> Result<(), String> {
    use base64::Engine;
    let exe = crate::opencode::find_opencode(&s.opencode_path).ok_or(
        "Não achei o OpenCode. Instale (npm i -g opencode-ai), configure um provedor (opencode auth login) ou informe o caminho no Digivice.",
    )?;

    let mut g = chats(app);
    let c = g.find(key).ok_or("Essa conversa foi fechada.")?;
    if let Some(child) = c.oc_child.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Err("O OpenCode ainda está respondendo a mensagem anterior.".into());
        }
    }
    let dir = work_dir_for(app, &c.cwd);
    let _ = std::fs::create_dir_all(&dir);

    let mut cmd = crate::opencode::command(&exe);
    cmd.args(["run", "--format", "json"]);
    if crate::opencode::valid_model(s.opencode_model.trim()) {
        cmd.args(["-m", s.opencode_model.trim()]);
    }
    if let Some(id) = c.oc_session.clone() {
        cmd.args(["--session", &id]);
    }
    // o `opencode run` recebe arquivos com -f: cada anexo vira um arquivo temporário
    let tmp = chat_dir(app);
    let _ = std::fs::create_dir_all(&tmp);
    let mut temp = Vec::new();
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    for (i, a) in attachments.iter().enumerate() {
        let bytes = if a.kind == "text" {
            a.data.clone().into_bytes()
        } else {
            base64::engine::general_purpose::STANDARD.decode(&a.data).map_err(|e| e.to_string())?
        };
        let safe: String = a.name.chars().map(|c| if c.is_alphanumeric() || ".-_".contains(c) { c } else { '_' }).take(60).collect();
        let path = tmp.join(format!("anexo-{ms}-{i}-{safe}"));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        cmd.arg("-f").arg(&path);
        temp.push(path);
    }
    let persona = prompt.filter(|p| c.oc_persona.as_deref() != Some(*p));
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
    c.generation += 1;
    let (generation, epoch) = (c.generation, c.epoch);
    push_log(c, user_event(text, attachments));
    if c.title == NEW_TITLE {
        c.title = short_title(text);
    }
    c.oc_persona = prompt.map(str::to_string);
    c.oc_child = Some(child);
    c.busy = true;
    save(app, &g);
    changed(app, &g);
    drop(g);

    let (err_app, err_key) = (app.clone(), key.to_string());
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                emit(&err_app, &err_key, json!({ "type": "digitama_stderr", "provider": "opencode", "text": line }));
            }
        }
    });
    let (out_app, out_key) = (app.clone(), key.to_string());
    std::thread::spawn(move || {
        let (app, key) = (out_app, out_key);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(mut v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = v.get("sessionID").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                let mut g = chats(&app);
                if let Some(c) = g.find(&key).filter(|c| c.generation == generation) {
                    c.oc_session = Some(id.to_string());
                }
            }
            v["provider"] = json!("opencode");
            record(&app, &key, epoch, &v);
            emit(&app, &key, v);
        }
        let code = {
            let mut g = chats(&app);
            let child = g.find(&key).filter(|c| c.generation == generation).and_then(|c| {
                c.busy = false;
                c.oc_child.take()
            });
            changed(&app, &g);
            drop(g);
            child.and_then(|mut c| c.wait().ok()).and_then(|st| st.code())
        };
        for path in temp {
            let _ = std::fs::remove_file(path);
        }
        let exit = json!({ "type": "digitama_exit", "provider": "opencode", "code": code });
        record(&app, &key, epoch, &exit);
        emit(&app, &key, exit);
    });
    Ok(())
}

/// Responde a um pedido de permissão (ou a uma pergunta) da conversa `key`.
/// `always` também grava a regra que o Claude Code sugeriu, nas configurações
/// locais da pasta da conversa. `input` substitui a entrada da ferramenta: é
/// assim que vão as respostas de um AskUserQuestion (`answers`).
pub fn answer_permission(app: &AppHandle, key: &str, request_id: &str, allow: bool, always: bool, input: Option<Value>) -> Result<(), String> {
    let mut g = chats(app);
    let c = g.find(key).ok_or("Essa conversa foi fechada.")?;
    let req = c.permissions.remove(request_id).ok_or("Esse pedido já foi respondido ou expirou.")?;
    let response = if allow {
        let original = req.get("input").cloned().unwrap_or_else(|| json!({}));
        let mut r = json!({ "behavior": "allow", "updatedInput": input.filter(Value::is_object).unwrap_or(original) });
        if always {
            if let Some(s) = req.get("permission_suggestions").filter(|s| s.as_array().is_some_and(|a| !a.is_empty())) {
                r["updatedPermissions"] = s.clone();
            }
        }
        r
    } else {
        json!({ "behavior": "deny", "message": "O usuário negou pelo chat do Digitama." })
    };
    let mut line = json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
    .to_string();
    line.push('\n');
    let p = c.proc.as_mut().ok_or("O Claude Code não está mais rodando.")?;
    let sent = p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).map_err(|e| format!("O Claude Code fechou: {e}"));
    changed(app, &g);
    sent
}

/// Interrompe a resposta da conversa (mata o processo) mas guarda a conversa.
pub fn stop(app: &AppHandle, key: &str) {
    let mut g = chats(app);
    if let Some(c) = g.find(key) {
        c.generation += 1;
        c.permissions.clear();
        c.busy = false;
        if let Some(mut p) = c.proc.take() {
            let _ = p.child.kill();
        }
        if let Some(mut ch) = c.oc_child.take() {
            let _ = ch.kill();
        }
    }
    changed(app, &g);
}

/// Para todas (o app vai fechar ou reiniciar).
pub fn stop_all(app: &AppHandle) {
    let keys: Vec<String> = chats(app).convs.iter().map(|c| c.key.clone()).collect();
    for k in keys {
        stop(app, &k);
    }
}

/// Recomeça a conversa do zero (nos dois provedores), na mesma pasta.
pub fn reset(app: &AppHandle, key: &str) {
    stop(app, key);
    let mut g = chats(app);
    if let Some(c) = g.find(key) {
        c.session_id = None;
        c.fork_pending = false;
        c.oc_session = None;
        c.oc_persona = None;
        c.epoch += 1;
        c.log.clear();
        c.title = NEW_TITLE.into();
        c.source.clear();
    }
    save(app, &g);
    changed(app, &g);
}

/// Continua (como cópia) a sessão `id` do VS Code numa conversa: a que já a
/// continua, a `reuse` se ela ainda está vazia, ou uma nova. Devolve a chave.
pub fn continue_session(app: &AppHandle, id: &str, cwd: &str, title: &str, reuse: Option<&str>, shown: Value) -> String {
    let mut g = chats(app);
    if let Some(c) = g.convs.iter().find(|c| c.source == id) {
        return c.key.clone();
    }
    let empty = reuse.and_then(|k| g.convs.iter().find(|c| c.key == k)).is_some_and(|c| {
        c.log.is_empty() && c.session_id.is_none() && c.proc.is_none() && c.oc_session.is_none() && c.title == NEW_TITLE
    });
    let key = match reuse.filter(|_| empty) {
        Some(k) => k.to_string(),
        None => g.create(cwd),
    };
    if let Some(c) = g.find(&key) {
        c.cwd = cwd.to_string();
        c.title = title.to_string();
        c.source = id.to_string();
        c.session_id = Some(id.to_string());
        c.fork_pending = true;
        push_log(c, shown);
    }
    save(app, &g);
    changed(app, &g);
    key
}

// ── Registro da conversa (para a página se redesenhar) ──────────────────────

const LOG_MAX: usize = 3000;
/// Saída de ferramenta guardada no registro (a da tela é a mesma, já cortada).
const RESULT_MAX: usize = 8000;

/// Entra no registro o que redesenha a conversa: o init, as mensagens inteiras
/// (não os pedaços do streaming), os resultados, as permissões e o fim.
fn keep(v: &Value) -> bool {
    match v.get("type").and_then(Value::as_str) {
        Some("stream_event" | "rate_limit_event" | "digitama_stderr") => false,
        Some("system") => matches!(v.get("subtype").and_then(Value::as_str), Some("init" | "permission_denied")),
        _ => true,
    }
}

fn cut(s: &str) -> String {
    if s.len() <= RESULT_MAX {
        return s.to_string();
    }
    let mut end = RESULT_MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &s[..end])
}

/// Saídas de ferramenta grandes ficam cortadas no registro.
fn slim(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("tool_use_result");
    }
    if let Some(blocks) = v.pointer_mut("/message/content").and_then(Value::as_array_mut) {
        for b in blocks.iter_mut().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            match b.get_mut("content") {
                Some(Value::String(s)) => *s = cut(s),
                Some(Value::Array(parts)) => {
                    for p in parts.iter_mut() {
                        if let Some(Value::String(t)) = p.get_mut("text") {
                            *t = cut(t);
                        }
                        if p.get("type").and_then(Value::as_str) == Some("image") {
                            *p = json!({ "type": "text", "text": "[imagem]" });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    v
}

fn push_log(c: &mut Conv, v: Value) {
    c.log.push_back(v);
    while c.log.len() > LOG_MAX {
        c.log.pop_front();
    }
}

fn record(app: &AppHandle, key: &str, epoch: u64, v: &Value) {
    if !keep(v) {
        return;
    }
    let mut g = chats(app);
    if let Some(c) = g.find(key).filter(|c| c.epoch == epoch) {
        push_log(c, slim(v));
    }
}

/// A sua mensagem no registro (dos anexos, só o tipo e o nome).
fn user_event(text: &str, attachments: &[Attachment]) -> Value {
    let files: Vec<Value> = attachments.iter().map(|a| json!({ "kind": a.kind, "name": a.name })).collect();
    json!({ "type": "digitama_user", "text": text, "files": files })
}

/// Tudo para a página redesenhar a conversa `key`: o registro, os pedidos ainda
/// sem resposta, se está respondendo e, se o app acabou de reabrir, o fim da
/// conversa anterior (que a próxima mensagem continua).
pub fn history(app: &AppHandle, key: &str) -> Value {
    let mut g = chats(app);
    let Some(c) = g.find(key) else { return json!({ "events": [], "pending": [], "busy": false, "previous": null }) };
    let pending: Vec<String> = c.permissions.keys().cloned().collect();
    let mut previous = Value::Null;
    if c.log.is_empty() && !c.fork_pending {
        if let Some(id) = c.session_id.as_deref().filter(|id| crate::sessions::valid_id(id)) {
            let file = crate::sessions::projects_dir()
                .join(crate::sessions::project_key(&work_dir_for(app, &c.cwd)))
                .join(format!("{id}.jsonl"));
            if file.is_file() {
                previous = json!({ "recent": crate::sessions::tail(&file, 6) });
            }
        }
    }
    json!({ "events": c.log, "pending": pending, "busy": c.busy, "previous": previous })
}

/// A pasta do chat do Digitama (fora dos seus projetos).
pub fn chat_dir(app: &AppHandle) -> PathBuf {
    app.state::<Store>().data_dir().join("chat")
}

/// Onde uma conversa trabalha: a pasta de projeto que você escolheu, ou a do Digitama.
pub fn work_dir_for(app: &AppHandle, cwd: &str) -> PathBuf {
    let p = PathBuf::from(cwd.trim());
    if !cwd.trim().is_empty() && p.is_dir() { p } else { chat_dir(app) }
}

/// Comandos de barra, MCPs (com o estado) e ferramentas que o chat teria na
/// pasta `cwd`, sem gastar nada: um `claude -p` que não grava sessão recebe
/// `/context` (respondido localmente) e é fechado assim que manda o `init`.
pub fn capabilities(app: &AppHandle, cwd: &str) -> Result<Value, String> {
    let s = app.state::<Store>().get();
    let exe = find_claude(&s.claude_path).ok_or("claude.exe não encontrado")?;
    let dir = work_dir_for(app, cwd);
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = Command::new(exe);
    clean_env(&mut cmd);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .current_dir(&dir)
        .env("DIGITAMA_INTERNAL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    if s.force_oauth {
        cmd.env_remove("ANTHROPIC_API_KEY").env_remove("ANTHROPIC_AUTH_TOKEN");
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let line = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "/context" }] } });
        let _ = stdin.write_all(format!("{line}\n").as_bytes());
    }
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("type").and_then(Value::as_str) == Some("system") && v.get("subtype").and_then(Value::as_str) == Some("init") {
                    let _ = tx.send(v);
                    return;
                }
            }
        }
    });
    let init = rx.recv_timeout(std::time::Duration::from_secs(45));
    let _ = child.kill();
    let _ = child.wait();
    let init = init.map_err(|_| "o Claude Code não respondeu".to_string())?;
    Ok(json!({
        "cwd": dir.to_string_lossy(),
        "slash_commands": init.get("slash_commands"),
        "mcp_servers": init.get("mcp_servers"),
        "tools": init.get("tools"),
    }))
}

/// Consulta o uso do plano: uma chamada mínima (Haiku, prompt de sistema curto,
/// sem ferramentas, sem MCP, sem configurações do usuário) só para receber o
/// `rate_limit_event`. Custa ~1–2 mil tokens do Haiku.
pub fn poll_usage(app: &AppHandle) -> Option<Value> {
    let s = app.state::<Store>().get();
    let exe = find_claude(&s.claude_path)?;
    let dir = app.state::<Store>().data_dir().join("usage");
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = Command::new(exe);
    clean_env(&mut cmd);
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--system-prompt",
        "Responda apenas: ok",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
    ])
    .current_dir(&dir)
    .env("DIGITAMA_INTERNAL", "1")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW);
    if s.force_oauth {
        cmd.env_remove("ANTHROPIC_API_KEY").env_remove("ANTHROPIC_AUTH_TOKEN");
    }
    let mut child = cmd.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"ok");
    }
    let stdout = child.stdout.take()?;
    // Lê numa thread à parte: se o claude.exe travar calado, o prazo ainda vale
    // (antes a leitura esperava para sempre e a consulta nunca mais rodava).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(u) = serde_json::from_str::<Value>(&line).ok().as_ref().and_then(usage_from_event) {
                let _ = tx.send(u);
                return;
            }
        }
    });
    let found = rx.recv_timeout(std::time::Duration::from_secs(60)).ok();
    let _ = child.kill();
    let _ = child.wait();
    found
}

/// Roda o claude.exe com argumentos fixos (sem shell) e devolve stdout+stderr.
pub fn run_cli(custom: &str, args: &[&str]) -> Result<String, String> {
    let exe = find_claude(custom).ok_or("claude.exe não encontrado")?;
    let mut cmd = Command::new(exe);
    clean_env(&mut cmd);
    let out = cmd
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
        let print = Attachment { kind: "image".into(), name: "print.png".into(), media_type: "image/png".into(), data: "AAAA".into() };
        let line = user_line("o que é isso?", &[print]);
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["text"], "o que é isso?");
        let only_text: Value = serde_json::from_str(user_line("oi", &[]).trim()).unwrap();
        assert_eq!(only_text["message"]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn titulo_da_conversa_e_o_comeco_da_primeira_mensagem() {
        assert_eq!(short_title("  valide os\nchamados 76661 e 76517 "), "valide os chamados 76661 e 76517");
        let long = short_title(&"palavra ".repeat(20));
        assert!(long.ends_with('…') && long.chars().count() <= 41);
    }

    #[test]
    fn conversas_novas_tem_chaves_diferentes_e_aparecem_na_lista() {
        let mut g = Chats::default();
        let a = g.create("");
        let b = g.create(r"c:\DEV\Loja");
        assert_ne!(a, b);
        let infos = g.infos();
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[1].cwd, r"c:\DEV\Loja");
        assert!(!infos[0].busy && !infos[0].waiting);
        g.find(&a).unwrap().permissions.insert("r1".into(), json!({}));
        assert!(g.infos()[0].waiting, "pergunta pendente aparece como esperando você");
    }

    #[test]
    fn registro_guarda_o_que_redesenha_e_corta_saidas_grandes() {
        assert!(!keep(&json!({ "type": "stream_event", "event": {} })));
        assert!(!keep(&json!({ "type": "system", "subtype": "thinking_tokens" })));
        assert!(keep(&json!({ "type": "system", "subtype": "init" })));
        assert!(keep(&json!({ "type": "control_request", "request_id": "r" })));
        let big = "ã".repeat(RESULT_MAX); // 2 bytes cada: o corte não pode partir um caractere
        let ev = json!({ "type": "user", "tool_use_result": { "stdout": "x" }, "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t", "content": big }
        ] } });
        let s = slim(&ev);
        assert!(s.get("tool_use_result").is_none());
        let out = s["message"]["content"][0]["content"].as_str().unwrap();
        assert!(out.len() <= RESULT_MAX + 8 && out.ends_with('…'));
    }

    #[test]
    fn anexos_viram_documento_e_texto_com_nome() {
        let pdf = Attachment { kind: "pdf".into(), name: "nota.pdf".into(), media_type: "application/pdf".into(), data: "JVBE".into() };
        let txt = Attachment { kind: "text".into(), name: "colado-1.txt".into(), media_type: "text/plain".into(), data: "linha 1\nlinha 2".into() };
        let svg = Attachment { kind: "image".into(), name: "x.svg".into(), media_type: "image/svg+xml".into(), data: "PHN2".into() };
        let v: Value = serde_json::from_str(user_line("veja", &[txt, pdf, svg]).trim()).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "document");
        assert_eq!(content[0]["title"], "nota.pdf");
        assert!(content[1]["text"].as_str().unwrap().starts_with("Arquivo anexado: colado-1.txt\n```\nlinha 1"));
        assert_eq!(content[2]["text"], "veja");
        assert_eq!(content.len(), 3, "imagem de tipo não aceito pela API fica de fora");
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
