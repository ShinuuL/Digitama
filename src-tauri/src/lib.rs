//! Digitama — um pet pixelado inspirado em Digimon que vive na área de trabalho,
//! reage aos hooks do Claude Code, conversa com o Claude pelo Claude Code
//! logado (OAuth) e dança quando o Spotify está em foco.

mod claude;
mod github;
mod hooks_install;
mod media;
mod opencode;
mod pipe;
mod screen;
mod sessions;
mod sprites;
mod store;
mod winsys;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use store::{PetState, Store};

const HOOK_EXE: &str = "digitama-hook.exe";

/// Retângulos (x, y, largura, altura em px CSS) onde o pet aceita o mouse; fora
/// deles a janela transparente deixa o clique passar para o que está atrás.
#[derive(Default)]
struct Hit(Mutex<Vec<[f64; 4]>>);

/// Print esperando a janela do chat abrir.
#[derive(Default)]
struct Attach(Mutex<Option<Value>>);

/// A tela congelada do recorte estilo Lightshot, enquanto a janela está aberta.
#[derive(Default)]
struct Snip(Mutex<Option<Value>>);

/// Último sinal de vida da página do pet e quantas vezes o vigia já agiu desde
/// então. O processo do WebView2 pode cair sozinho (falta de memória, driver de
/// vídeo) e aí o pet some da tela sem o app fechar.
struct Alive(Mutex<(Instant, u32)>);

impl Default for Alive {
    fn default() -> Self {
        Self(Mutex::new((Instant::now(), 0)))
    }
}

/// Sem sinal da página por este tempo (ela manda a cada 10 s), o vigia age.
/// Folgado: o Chromium segura os timers de páginas escondidas por até 1 min.
const PET_SILENT: Duration = Duration::from_secs(150);

// ── Relay (digitama-hook.exe) ────────────────────────────────────────────────

fn hook_exe_path(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("digitama"));
    base.join("bin").join(HOOK_EXE)
}

/// Copia o relay para %LOCALAPPDATA%\…\bin a cada abertura: no app instalado
/// vem dos recursos; no `tauri dev`, do target/release ao lado.
fn ensure_hook_exe(app: &AppHandle) {
    let dest = hook_exe_path(app);
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(HOOK_EXE, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(HOOK_EXE));
            candidates.push(parent.join("../release").join(HOOK_EXE));
        }
    }
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        eprintln!("[digitama] {HOOK_EXE} não encontrado — rode `npm run hook`");
        return;
    };
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if !same {
        // Um hook pode estar rodando e segurando o arquivo: a cópia antiga serve.
        let _ = std::fs::copy(&src, &dest);
    }
}

/// Copia os sprites que vieram no instalador para a pasta do usuário — só o que
/// ainda não existe lá, para nunca sobrescrever um sprite trocado à mão.
fn install_bundled_sprites(app: &AppHandle) {
    let Ok(src) = app.path().resolve("sprites", tauri::path::BaseDirectory::Resource) else { return };
    let Ok(ids) = std::fs::read_dir(&src) else { return };
    let dest = sprites_dir(app);
    for id in ids.flatten().filter(|e| e.path().is_dir()) {
        let target = dest.join(id.file_name());
        let _ = std::fs::create_dir_all(&target);
        let Ok(files) = std::fs::read_dir(id.path()) else { continue };
        for f in files.flatten() {
            let to = target.join(f.file_name());
            if !to.exists() {
                let _ = std::fs::copy(f.path(), &to);
            }
        }
    }
}

// ── Janelas ──────────────────────────────────────────────────────────────────

fn open_window_impl(app: &AppHandle, name: &str) {
    eprintln!("[digitama] abrir janela {name}");
    if let Some(w) = app.get_webview_window(name) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let (url, title, w, h) = match name {
        "chat" => ("chat.html", "Digitama — Chat com o Claude", 780.0, 680.0),
        "settings" => ("settings.html", "Digitama — Digivice", 980.0, 660.0),
        _ => return,
    };
    let mut builder = WebviewWindowBuilder::new(app, name, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .min_inner_size(380.0, 420.0)
        .center();
    if name == "chat" {
        // arrastar arquivos para o chat: o soltar fica com a página, não com o Tauri
        builder = builder.disable_drag_drop_handler();
    }
    let built = builder.build();
    match built {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("[digitama] não abri a janela {name}: {e}"),
    }
}

/// Põe o pet na posição salva ou, sem ela (ou com `use_saved` falso), no canto
/// de baixo à direita do monitor principal.
fn place_pet(app: &AppHandle, use_saved: bool) {
    let Some(win) = app.get_webview_window("pet") else { return };
    let saved = app.state::<Store>().get().pos.filter(|_| use_saved);
    let on_screen = |(x, y): (i32, i32)| {
        win.available_monitors().unwrap_or_default().iter().any(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x - 100 && y >= p.y - 100 && x < p.x + s.width as i32 - 50 && y < p.y + s.height as i32 - 50
        })
    };
    let pos = saved.filter(|p| on_screen(*p)).or_else(|| {
        let m = win.primary_monitor().ok().flatten()?;
        let area = m.work_area();
        let size = win.outer_size().ok()?;
        Some((
            area.position.x + area.size.width as i32 - size.width as i32 - 24,
            area.position.y + area.size.height as i32 - size.height as i32,
        ))
    });
    if let Some((x, y)) = pos {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();
}

fn toggle_pet(app: &AppHandle, visible: Option<bool>) {
    let Some(win) = app.get_webview_window("pet") else { return };
    let now = win.is_visible().unwrap_or(true);
    let want = visible.unwrap_or(!now);
    let _ = if want { win.show() } else { win.hide() };
}

/// Clique-através: fora das regiões do pet a janela ignora o mouse. Também
/// salva a posição quando o pet fica parado depois de arrastado e, a cada
/// poucos segundos, cuida para ele não sumir (ver `keep_pet_alive`).
fn start_hit_poll(app: AppHandle) {
    std::thread::spawn(move || {
        // Daqui em diante só Win32 direto pelo HWND (ver `winsys`).
        let hwnd = loop {
            if let Some(h) = app.get_webview_window("pet").and_then(|w| w.hwnd().ok()) {
                break h.0 as isize;
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let mut accepting: Option<bool> = None;
        let mut last_pos: Option<(i32, i32)> = None;
        let mut moved_at: Option<Instant> = None;
        let mut last_tick = Instant::now();
        let mut last_check = Instant::now();
        let mut was_visible = false;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            // Uma volta muito atrasada é o PC saindo da suspensão: a página
            // também esteve parada, não está morta.
            if last_tick.elapsed() > Duration::from_secs(3) {
                pet_alive(app.state::<Alive>());
            }
            last_tick = Instant::now();
            let visible = winsys::window_visible(hwnd);
            if visible != was_visible {
                was_visible = visible;
                accepting = None;
                // escondida, a página fica com os timers presos: recomeça a contagem
                pet_alive(app.state::<Alive>());
            }
            if !visible {
                continue;
            }
            let Some((x, y, w, h, scale)) = winsys::window_rect(hwnd) else { continue };
            if last_pos != Some((x, y)) {
                if last_pos.is_some() {
                    moved_at = Some(Instant::now());
                }
                last_pos = Some((x, y));
            }
            if moved_at.is_some_and(|t| t.elapsed() > Duration::from_millis(800)) {
                moved_at = None;
                app.state::<Store>().update_quiet(|s| s.pos = Some((x, y)));
            }
            if last_check.elapsed() > Duration::from_secs(5) {
                last_check = Instant::now();
                keep_pet_alive(&app, hwnd, (x, y, w, h));
            }
            let Some((cx, cy)) = winsys::cursor_pos() else { continue };
            let (lx, ly) = ((cx - x) as f64 / scale, (cy - y) as f64 / scale);
            let accept = app
                .state::<Hit>()
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|[x, y, w, h]| lx >= *x && ly >= *y && lx < x + w && ly < y + h);
            if accepting != Some(accept) {
                accepting = Some(accept);
                if let Some(win) = app.get_webview_window("pet") {
                    let _ = win.set_ignore_cursor_events(!accept);
                }
                let _ = app.emit_to("pet", "pet-hover", accept);
            }
        }
    });
}

/// O que fazia o pet sumir com o app aberto por muito tempo:
///  * o Windows tira o "sempre por cima" (tela cheia, troca de usuário…);
///  * o monitor onde ele estava foi desligado ou mudou de resolução;
///  * o processo do WebView2 caiu e a janela ficou vazia — sem sinal da página
///    o vigia recarrega; se nem assim voltar, reinicia o app. Nunca com um
///    pedido de permissão esperando no balão.
fn keep_pet_alive(app: &AppHandle, hwnd: isize, (x, y, w, h): (i32, i32, i32, i32)) {
    winsys::ensure_topmost(hwnd);
    // o chão do pet (a faixa de baixo da janela) precisa estar em algum monitor
    let feet = y + h - h / 10;
    if ![w / 4, w / 2, w * 3 / 4].iter().any(|dx| winsys::point_on_screen(x + dx, feet)) {
        log_line(app, "vigia", "o pet estava fora das telas; voltou para o canto");
        place_pet(app, false);
    }
    let tries = {
        let alive = app.state::<Alive>();
        let mut guard = alive.0.lock().unwrap();
        if guard.0.elapsed() < PET_SILENT || !app.state::<pipe::Pending>().0.lock().unwrap().is_empty() {
            return;
        }
        *guard = (Instant::now(), guard.1 + 1);
        guard.1
    };
    if tries == 1 {
        log_line(app, "vigia", "a página do pet parou de responder; recarregando");
        if let Some(win) = app.get_webview_window("pet") {
            let _ = win.reload();
        }
    } else {
        log_line(app, "vigia", "a página do pet não voltou; reiniciando o Digitama");
        claude::stop_all(app);
        app.restart();
    }
}

// ── Print da tela ────────────────────────────────────────────────────────────

/// Esconde as janelas do Digitama, tira o print e as mostra de novo.
async fn capture_clean(app: &AppHandle, hide: &[&str]) -> Result<Value, String> {
    let mut hidden = Vec::new();
    for label in hide {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
                hidden.push(w);
            }
        }
    }
    if !hidden.is_empty() {
        tokio::time::sleep(Duration::from_millis(220)).await;
    }
    let shot = tauri::async_runtime::spawn_blocking(|| screen::capture(false))
        .await
        .map_err(|e| e.to_string())?;
    for w in hidden {
        let _ = w.show();
    }
    let s = shot?;
    let _ = app.emit_to("pet", "pet-flash", ());
    Ok(json!({ "png": s.png_base64, "width": s.width, "height": s.height }))
}

/// Recorte estilo Lightshot: congela todas as telas (sem o pet e o chat) e abre
/// por cima delas uma janela sem bordas para selecionar e anotar.
async fn open_snip(app: AppHandle) {
    let mut hidden = Vec::new();
    for label in ["pet", "chat"] {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
                hidden.push(w);
            }
        }
    }
    if !hidden.is_empty() {
        tokio::time::sleep(Duration::from_millis(220)).await;
    }
    let shot = tauri::async_runtime::spawn_blocking(screen::capture_full)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    for w in &hidden {
        let _ = w.show();
    }
    let (shot, (x, y, w, h)) = match shot {
        Ok(v) => v,
        Err(e) => {
            let _ = app.emit_to("pet", "pet-say", format!("Não consegui tirar o print: {e}"));
            return;
        }
    };
    *app.state::<Snip>().0.lock().unwrap() =
        Some(json!({ "png": shot.png_base64, "width": shot.width, "height": shot.height }));
    // A janela já existe (pré-criada escondida): só reposiciona e avisa. A
    // própria página chama `snip_ready` para aparecer quando o print carregou.
    let win = match app.get_webview_window("snip") {
        Some(win) => {
            cover(&win, (x, y, w, h));
            let _ = app.emit_to("snip", "snip-load", ());
            return;
        }
        None => build_snip(&app),
    };
    match win {
        Ok(win) => cover(&win, (x, y, w, h)),
        Err(e) => eprintln!("[digitama] não abri a captura: {e}"),
    }
}

/// Estica a janela do recorte sobre a área (pixels físicos). Duas vezes: com
/// monitores de escalas diferentes, mudar de monitor faz o Windows propor outro
/// tamanho (DPI novo); a segunda vez já acontece na escala final.
fn cover(win: &tauri::WebviewWindow, (x, y, w, h): (i32, i32, i32, i32)) {
    for _ in 0..2 {
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    }
}

/// A janela do recorte, escondida. Criada no início (em contexto assíncrono)
/// e reaproveitada: montar uma WebView a cada Print levava segundos.
fn build_snip(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(app, "snip", WebviewUrl::App("snip.html".into()))
        .title("Digitama — Captura")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
}

async fn screenshot_to_chat(app: AppHandle) {
    match capture_clean(&app, &["pet", "chat"]).await {
        Ok(shot) => {
            *app.state::<Attach>().0.lock().unwrap() = Some(shot);
            open_window_impl(&app, "chat");
            let _ = app.emit_to("chat", "chat-attach", ());
        }
        Err(e) => {
            let _ = app.emit_to("pet", "pet-say", format!("Não consegui tirar o print: {e}"));
        }
    }
}

// ── Comandos ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn state_get(store: State<Store>) -> PetState {
    store.get()
}

#[tauri::command]
fn state_set(app: AppHandle, store: State<Store>, patch: Value) -> Result<PetState, String> {
    store.patch(&app, &patch)
}

/// Sinal de vida da página do pet (a cada 10 s).
#[tauri::command]
fn pet_alive(alive: State<Alive>) {
    *alive.0.lock().unwrap() = (Instant::now(), 0);
}

#[tauri::command]
fn hit_regions(hit: State<Hit>, rects: Vec<[f64; 4]>) {
    *hit.0.lock().unwrap() = rects;
}

#[tauri::command]
fn hook_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

#[tauri::command]
fn hook_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

#[tauri::command]
fn hook_answer(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

#[tauri::command]
fn hook_answer_question(app: AppHandle, request_id: String, answers: Map<String, Value>) {
    pipe::answer_question(&app, &request_id, &answers);
}

#[tauri::command]
async fn focus_claude(cwd: Option<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || winsys::focus_claude(cwd.as_deref()))
        .await
        .unwrap_or(false)
}

/// Assíncrono de propósito: no Windows, criar uma webview dentro de um comando
/// síncrono ou de um handler trava a criação (wry #583).
#[tauri::command]
async fn open_window(app: AppHandle, name: String) {
    open_window_impl(&app, &name);
}

/// Abre uma janela a partir de um handler síncrono (bandeja, atalho, instância
/// única), passando a criação para o runtime assíncrono.
fn open_window_later(app: &AppHandle, name: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { open_window_impl(&app, name) });
}

#[tauri::command]
async fn chat_send(app: AppHandle, conv: String, text: String, attachments: Vec<claude::Attachment>, persona: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || claude::send(&app, &conv, &text, &attachments, persona.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Escolhe a pasta de um projeto (o seletor do Windows, por cima do chat).
#[tauri::command]
async fn chat_folder_pick(app: AppHandle) -> Option<String> {
    let owner = app.get_webview_window("chat").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    tauri::async_runtime::spawn_blocking(move || winsys::pick_folder(owner, "Escolha a pasta do projeto"))
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

/// As conversas abertas no chat (as abas).
#[tauri::command]
fn chat_list(app: AppHandle) -> Vec<claude::ConvInfo> {
    claude::list(&app)
}

/// Uma conversa nova trabalhando em `path` (`None` = a pasta do Digitama).
#[tauri::command]
fn chat_new(app: AppHandle, path: Option<String>) -> Result<String, String> {
    let path = path.unwrap_or_default();
    if !path.is_empty() && !PathBuf::from(&path).is_dir() {
        return Err(format!("Pasta não encontrada: {path}"));
    }
    Ok(claude::create(&app, &path))
}

#[tauri::command]
fn chat_close(app: AppHandle, conv: String) {
    claude::close(&app, &conv);
}

/// Comandos de barra, MCPs e ferramentas que o chat tem na pasta `cwd`.
#[tauri::command]
async fn chat_capabilities(app: AppHandle, cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || claude::capabilities(&app, &cwd)).await.map_err(|e| e.to_string())?
}

/// O cartão do GitHub da pasta `cwd` (null se não for um repositório).
#[tauri::command]
async fn github_status(app: AppHandle, cwd: String) -> Value {
    let dir = claude::work_dir_for(&app, &cwd);
    tauri::async_runtime::spawn_blocking(move || github::status(&dir)).await.unwrap_or(Value::Null)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    github::open(&url)
}

/// Uma conversa, para a página redesenhar ao trocar de aba ou recarregar.
#[tauri::command]
fn chat_history(app: AppHandle, conv: String) -> Value {
    claude::history(&app, &conv)
}

/// Responde a um pedido de permissão ou a uma pergunta (`input` com as respostas).
#[tauri::command]
fn chat_permission(app: AppHandle, conv: String, request_id: String, allow: bool, always: bool, input: Option<Value>) -> Result<(), String> {
    claude::answer_permission(&app, &conv, &request_id, allow, always, input)
}

/// O ditado do Windows (Win+H) no campo em foco: o chat foca a caixa de texto
/// antes de chamar.
#[tauri::command]
fn dictate() {
    winsys::voice_typing();
}

#[tauri::command]
fn chat_stop(app: AppHandle, conv: String) {
    claude::stop(&app, &conv);
}

#[tauri::command]
fn chat_reset(app: AppHandle, conv: String) {
    claude::reset(&app, &conv);
}

/// As sessões do Claude Code no VS Code: ativas e dos últimos 7 dias.
#[tauri::command]
async fn sessions_list(app: AppHandle) -> Vec<sessions::SessionInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let internal = app.state::<Store>().data_dir();
        sessions::list(&app.state::<sessions::Cache>(), &app.state::<sessions::Live>(), 7, &internal)
    })
    .await
    .unwrap_or_default()
}

/// "Continuar aqui": uma conversa do chat continua uma cópia da sessão `id`
/// (a que já a continua, a `reuse` se estiver vazia, ou uma nova). Devolve a
/// conversa e as últimas falas da sessão.
#[tauri::command]
async fn session_continue(app: AppHandle, id: String, title: String, project: String, cwd: String, reuse: Option<String>) -> Result<Value, String> {
    if !sessions::valid_id(&id) {
        return Err("id de sessão inválido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let internal = app.state::<Store>().data_dir();
        let path = sessions::find(&id, &internal).ok_or("Sessão não encontrada.")?;
        let recent = sessions::tail(&path, 6);
        // A conversa trabalha na pasta da sessão, onde o transcrito já está (o
        // --fork-session o acha lá). Sem a pasta, uma cópia vai para a do chat.
        let folder = PathBuf::from(&cwd);
        let same_project = path
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&sessions::project_key(&folder)));
        let work = if folder.is_dir() && same_project {
            cwd.clone()
        } else {
            sessions::copy_for_chat(&path, &id, &claude::chat_dir(&app))?;
            String::new()
        };
        let shown = json!({ "type": "digitama_continue", "id": id, "title": title, "project": project, "recent": recent });
        let key = claude::continue_session(&app, &id, &work, &title, reuse.as_deref(), shown);
        Ok(json!({ "conv": key, "recent": recent }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn chat_take_attachment(attach: State<Attach>) -> Option<Value> {
    attach.0.lock().unwrap().take()
}

#[tauri::command]
async fn capture_screen(app: AppHandle) -> Result<Value, String> {
    capture_clean(&app, &["pet", "chat"]).await
}

#[tauri::command]
async fn screenshot_and_ask(app: AppHandle) {
    screenshot_to_chat(app).await;
}

#[tauri::command]
async fn snip_open(app: AppHandle) {
    open_snip(app).await;
}

#[tauri::command]
fn snip_image(snip: State<Snip>) -> Option<Value> {
    snip.0.lock().unwrap().clone()
}

#[tauri::command]
fn snip_close(app: AppHandle) {
    app.state::<Snip>().0.lock().unwrap().take();
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.hide();
    }
}

/// O print novo já está desenhado na página: mostra a janela.
#[tauri::command]
fn snip_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("pet", "pet-flash", ());
    }
}

fn decode_b64(png: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(png.trim()).map_err(|e| e.to_string())?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("não é um PNG".into());
    }
    Ok(bytes)
}

/// Salva em Imagens/Digitama e devolve o caminho.
#[tauri::command]
fn save_png(png: String) -> Result<String, String> {
    let bytes = decode_b64(&png)?;
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let dir = home.join("Pictures").join("Digitama");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("Digitama_{ms}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn copy_png(png: String) -> Result<(), String> {
    let bytes = decode_b64(&png)?;
    tauri::async_runtime::spawn_blocking(move || screen::copy_png_to_clipboard(&bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// Recorte pronto → anexo no chat do Claude.
#[tauri::command]
async fn attach_to_chat(app: AppHandle, png: String, width: u32, height: u32) {
    *app.state::<Attach>().0.lock().unwrap() = Some(json!({ "png": png, "width": width, "height": height }));
    open_window_impl(&app, "chat");
    let _ = app.emit_to("chat", "chat-attach", ());
}

#[tauri::command]
fn media_state(current: State<media::Current>) -> media::MediaState {
    current.0.lock().unwrap().clone()
}

#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn hooks_status(app: AppHandle) -> hooks_install::HookStatus {
    hooks_install::status(&hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
fn hooks_preview(app: AppHandle, install: bool) -> Result<hooks_install::HookPreview, String> {
    hooks_install::preview(install, &hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
fn hooks_apply(app: AppHandle, install: bool, fingerprint: String) -> Result<String, String> {
    hooks_install::apply(install, &hook_exe_path(&app).to_string_lossy(), &fingerprint)
}

/// Consulta o uso do Claude de tempos em tempos (Digivice → Agentes).
fn start_usage_poll(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            let minutes = app.state::<Store>().get().usage_refresh_min;
            if minutes > 0 {
                refresh_usage(&app);
            }
            std::thread::sleep(Duration::from_secs(60 * u64::from(minutes.max(1))));
        }
    });
}

fn refresh_usage(app: &AppHandle) -> Option<Value> {
    let u = claude::poll_usage(app)?;
    *app.state::<pipe::Usage>().0.lock().unwrap() = Some(u.clone());
    let _ = app.emit("usage", u.clone());
    Some(u)
}

#[tauri::command]
async fn usage_refresh(app: AppHandle) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || refresh_usage(&app)).await.ok().flatten()
}

#[tauri::command]
fn usage_get(usage: State<pipe::Usage>) -> Option<Value> {
    usage.0.lock().unwrap().clone()
}

#[tauri::command]
fn usage_bar_status(app: AppHandle) -> bool {
    hooks_install::status_line_installed(&hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
fn usage_bar_preview(app: AppHandle, install: bool) -> Result<hooks_install::HookPreview, String> {
    hooks_install::status_line_preview(install, &hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
fn usage_bar_apply(app: AppHandle, install: bool, fingerprint: String) -> Result<String, String> {
    hooks_install::status_line_apply(install, &hook_exe_path(&app).to_string_lossy(), &fingerprint)
}

#[tauri::command]
async fn claude_info(store: State<'_, Store>) -> Result<Value, String> {
    let custom = store.get().claude_path;
    let path = claude::find_claude(&custom).map(|p| claude::path_display(&p));
    let version = tauri::async_runtime::spawn_blocking(move || claude::run_cli(&custom, &["--version"]).ok())
        .await
        .ok()
        .flatten();
    Ok(json!({ "path": path, "version": version }))
}

/// A linha de comando que registra o servidor MCP do pet no Claude Code.
fn mcp_args(app: &AppHandle) -> Vec<String> {
    vec![
        "mcp".into(),
        "add".into(),
        "--scope".into(),
        "user".into(),
        "digitama".into(),
        "--".into(),
        hook_exe_path(app).to_string_lossy().into_owned(),
        "--mcp".into(),
    ]
}

#[tauri::command]
fn mcp_command(app: AppHandle) -> String {
    let args = mcp_args(&app);
    let shown: Vec<String> = args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect();
    format!("claude {}", shown.join(" "))
}

#[tauri::command]
async fn mcp_install(app: AppHandle) -> Result<String, String> {
    let custom = app.state::<Store>().get().claude_path;
    let args = mcp_args(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        claude::run_cli(&custom, &refs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pasta onde o usuário pode colocar PNGs próprios (`<id-do-digimon>.png`).
fn sprites_dir(app: &AppHandle) -> PathBuf {
    app.state::<Store>().data_dir().join("sprites")
}

/// Os PNGs da pasta de sprites como data URLs: `<id>.png` vira a chave `id`
/// (pose parada), e `<id>/<pose>.png` vira `id/pose` (idle, attack, hit…).
/// Com `ids`, só os desses Digimon (o pet pede só os da linha atual).
/// Arquivos acima de 2 MB ou sem a assinatura PNG são ignorados.
#[tauri::command]
fn custom_sprites(app: AppHandle, ids: Option<Vec<String>>) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(entries) = std::fs::read_dir(sprites_dir(&app)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) else { continue };
        if ids.as_ref().is_some_and(|ids| !ids.iter().any(|id| id.eq_ignore_ascii_case(&name))) {
            continue;
        }
        if path.is_dir() {
            let Ok(poses) = std::fs::read_dir(&path) else { continue };
            for pose in poses.flatten() {
                let p = pose.path();
                if let (Some(pose_name), Some(data)) = (p.file_stem().and_then(|s| s.to_str()), png_data_url(&p)) {
                    out.insert(format!("{name}/{}", pose_name.to_lowercase()), Value::String(data));
                }
            }
        } else if let Some(data) = png_data_url(&path) {
            out.insert(name, Value::String(data));
        }
    }
    out
}

fn png_data_url(path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) != Some(true) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return None;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
fn open_sprites_folder(app: AppHandle) -> Result<(), String> {
    let dir = sprites_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe").arg(&dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

#[tauri::command]
async fn opencode_status(app: AppHandle) -> Result<opencode::PluginStatus, String> {
    let hook = hook_exe_path(&app).to_string_lossy().into_owned();
    let custom = app.state::<Store>().get().opencode_path;
    tauri::async_runtime::spawn_blocking(move || opencode::status(&hook, &custom))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn opencode_plugin_preview(app: AppHandle, install: bool) -> Result<String, String> {
    opencode::preview(install, &hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
fn opencode_plugin_apply(app: AppHandle, install: bool) -> Result<String, String> {
    opencode::apply(install, &hook_exe_path(&app).to_string_lossy())
}

#[tauri::command]
async fn opencode_models(app: AppHandle) -> Result<Vec<String>, String> {
    let custom = app.state::<Store>().get().opencode_path;
    tauri::async_runtime::spawn_blocking(move || opencode::models(&custom))
        .await
        .map_err(|e| e.to_string())?
}

// ── Sprites e inicialização ──────────────────────────────────────────────────

#[tauri::command]
async fn sprites_download(app: AppHandle, force: bool) -> Result<Value, String> {
    let dir = sprites_dir(&app);
    let (ok, failed) = sprites::download(&app, &dir, force).await?;
    Ok(json!({ "downloaded": ok, "failed": failed }))
}

#[tauri::command]
fn sprites_missing(app: AppHandle) -> usize {
    sprites::missing(&sprites_dir(&app))
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, on: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    let result = if on { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| e.to_string())?;
    Ok(launcher.is_enabled().unwrap_or(on))
}

/// Erros do frontend (ex.: o laço de desenho do pet) vão para digitama.log.
#[tauri::command]
fn log_error(app: AppHandle, window: tauri::Window, message: String) {
    log_line(&app, window.label(), &message);
}

fn log_line(app: &AppHandle, origin: &str, message: &str) {
    use std::io::Write;
    let path = app.state::<Store>().data_dir().join("digitama.log");
    // o log não cresce sem fim
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let text: String = message.chars().take(2000).collect();
        let _ = writeln!(f, "[{secs}] {origin}: {text}");
    }
}

#[tauri::command]
fn pet_visibility(app: AppHandle, visible: Option<bool>) {
    toggle_pet(&app, visible);
}

#[tauri::command]
fn quit(app: AppHandle) {
    claude::stop_all(&app);
    app.exit(0);
}

// ── Bandeja e atalhos ────────────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "chat", "Conversar com o Claude  (Ctrl+Alt+Shift+D)", true, None::<&str>)?,
            &MenuItem::with_id(app, "shot", "Capturar tela  (Print Screen / Ctrl+Alt+Shift+P)", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle", "Mostrar / esconder o pet", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Configurações…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("digitama")
        .tooltip("Digitama")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "chat" => open_window_later(app, "chat"),
            "shot" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { open_snip(app).await });
            }
            "toggle" => toggle_pet(app, None),
            "settings" => open_window_later(app, "settings"),
            "quit" => {
                claude::stop_all(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn chat_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT), Code::KeyD)
}

/// A tecla Print Screen sozinha, como no Lightshot (opcional nas configurações).
fn print_screen_shortcut() -> Shortcut {
    Shortcut::new(None, Code::PrintScreen)
}

fn shot_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT), Code::KeyP)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_pet(app, Some(true));
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &chat_shortcut() {
                        open_window_later(app, "chat");
                    } else if shortcut == &shot_shortcut() || shortcut == &print_screen_shortcut() {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move { open_snip(app).await });
                    }
                })
                .build(),
        )
        .manage(pipe::Pending::default())
        .manage(pipe::Usage::default())
        .manage(claude::Chat::default())
        .manage(Hit::default())
        .manage(Attach::default())
        .manage(Snip::default())
        .manage(Alive::default())
        .manage(media::Current::default())
        .manage(sessions::Cache::default())
        .manage(sessions::Live::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Store::load(&handle));
            ensure_hook_exe(&handle);
            place_pet(&handle, true);
            pipe::start(handle.clone());
            media::start(handle.clone());
            start_usage_poll(handle.clone());
            start_hit_poll(handle.clone());
            if let Err(e) = build_tray(&handle) {
                eprintln!("[digitama] bandeja: {e}");
            }
            // Primeira vez nesta máquina: abre os "Primeiros passos" do Digivice e
            // já baixa os sprites que faltam, em segundo plano.
            if !handle.state::<Store>().get().onboarded {
                open_window_later(&handle, "settings");
            }
            install_bundled_sprites(&handle);
            {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if app.get_webview_window("snip").is_none() {
                        if let Err(e) = build_snip(&app) {
                            eprintln!("[digitama] não pré-criei a captura: {e}");
                        }
                    }
                });
            }
            if sprites::missing(&sprites_dir(&handle)) > 0 {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let dir = sprites_dir(&app);
                    if let Err(e) = sprites::download(&app, &dir, false).await {
                        eprintln!("[digitama] sprites: {e}");
                    }
                });
            }
            let mut shortcuts = vec![chat_shortcut(), shot_shortcut()];
            if handle.state::<Store>().get().print_screen_key {
                shortcuts.push(print_screen_shortcut());
            }
            for s in shortcuts {
                if let Err(e) = handle.global_shortcut().register(s) {
                    eprintln!("[digitama] atalho em uso: {e}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar o chat só esconde: a conversa continua de onde parou.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "chat" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            state_get,
            state_set,
            hit_regions,
            pet_alive,
            hook_ack,
            hook_decline,
            hook_answer,
            hook_answer_question,
            focus_claude,
            open_window,
            chat_send,
            chat_stop,
            chat_reset,
            chat_take_attachment,
            chat_permission,
            chat_history,
            chat_folder_pick,
            chat_list,
            chat_new,
            chat_close,
            chat_capabilities,
            github_status,
            open_url,
            dictate,
            sessions_list,
            session_continue,
            capture_screen,
            screenshot_and_ask,
            snip_open,
            snip_image,
            snip_close,
            snip_ready,
            save_png,
            copy_png,
            attach_to_chat,
            media_control,
            media_state,
            hooks_status,
            hooks_preview,
            hooks_apply,
            claude_info,
            mcp_command,
            mcp_install,
            custom_sprites,
            usage_get,
            usage_refresh,
            usage_bar_status,
            usage_bar_preview,
            usage_bar_apply,
            log_error,
            opencode_status,
            opencode_plugin_preview,
            opencode_plugin_apply,
            opencode_models,
            sprites_download,
            sprites_missing,
            autostart_get,
            autostart_set,
            open_sprites_folder,
            pet_visibility,
            quit,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Digitama");
}
