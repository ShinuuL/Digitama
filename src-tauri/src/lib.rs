//! Digitama — um pet pixelado inspirado em Digimon que vive na área de trabalho,
//! reage aos hooks do Claude Code, conversa com o Claude pelo Claude Code
//! logado (OAuth) e dança quando o Spotify está em foco.

mod claude;
mod hooks_install;
mod media;
mod opencode;
mod pipe;
mod screen;
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
        "chat" => ("chat.html", "Digitama — Chat com o Claude", 460.0, 680.0),
        "settings" => ("settings.html", "Digitama — Digivice", 980.0, 660.0),
        _ => return,
    };
    let built = WebviewWindowBuilder::new(app, name, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .min_inner_size(380.0, 420.0)
        .center()
        .build();
    match built {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("[digitama] não abri a janela {name}: {e}"),
    }
}

fn place_pet(app: &AppHandle) {
    let Some(win) = app.get_webview_window("pet") else { return };
    let saved = app.state::<Store>().get().pos;
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
/// salva a posição quando o pet fica parado depois de arrastado.
fn start_hit_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut accepting: Option<bool> = None;
        let mut last_pos: Option<(i32, i32)> = None;
        let mut moved_at: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(win) = app.get_webview_window("pet") else { continue };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) else { continue };
            if last_pos != Some((pos.x, pos.y)) {
                if last_pos.is_some() {
                    moved_at = Some(Instant::now());
                }
                last_pos = Some((pos.x, pos.y));
            }
            if moved_at.is_some_and(|t| t.elapsed() > Duration::from_millis(800)) {
                moved_at = None;
                app.state::<Store>().update_quiet(|s| s.pos = Some((pos.x, pos.y)));
            }
            let Some((cx, cy)) = winsys::cursor_pos() else { continue };
            let (lx, ly) = ((cx - pos.x) as f64 / scale, (cy - pos.y) as f64 / scale);
            let accept = app
                .state::<Hit>()
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|[x, y, w, h]| lx >= *x && ly >= *y && lx < x + w && ly < y + h);
            if accepting != Some(accept) {
                accepting = Some(accept);
                let _ = win.set_ignore_cursor_events(!accept);
                let _ = app.emit_to("pet", "pet-hover", accept);
            }
        }
    });
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

/// Recorte estilo Lightshot: congela o monitor do cursor (sem o pet e o chat)
/// e abre por cima dele uma janela sem bordas para selecionar e anotar.
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
            let _ = win.set_position(PhysicalPosition::new(x, y));
            let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
            let _ = app.emit_to("snip", "snip-load", ());
            return;
        }
        None => build_snip(&app),
    };
    match win {
        Ok(win) => {
            let _ = win.set_position(PhysicalPosition::new(x, y));
            let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        }
        Err(e) => eprintln!("[digitama] não abri a captura: {e}"),
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
async fn chat_send(app: AppHandle, text: String, image: Option<String>, persona: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || claude::send(&app, &text, image.as_deref(), persona.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn chat_stop(app: AppHandle) {
    claude::stop(&app);
}

#[tauri::command]
fn chat_reset(app: AppHandle) {
    claude::reset(&app);
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
/// Arquivos acima de 2 MB ou sem a assinatura PNG são ignorados.
#[tauri::command]
fn custom_sprites(app: AppHandle) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(entries) = std::fs::read_dir(sprites_dir(&app)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) else { continue };
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
    use std::io::Write;
    let path = app.state::<Store>().data_dir().join("digitama.log");
    // o log não cresce sem fim
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let text: String = message.chars().take(2000).collect();
        let _ = writeln!(f, "[{secs}] {}: {text}", window.label());
    }
}

#[tauri::command]
fn pet_visibility(app: AppHandle, visible: Option<bool>) {
    toggle_pet(&app, visible);
}

#[tauri::command]
fn quit(app: AppHandle) {
    claude::stop(&app);
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
                claude::stop(app);
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
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Store::load(&handle));
            ensure_hook_exe(&handle);
            place_pet(&handle);
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
