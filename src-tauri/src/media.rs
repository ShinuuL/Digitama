//! Música: o Spotify (ou outro player) pela API de sessões de mídia do Windows
//! (GlobalSystemMediaTransportControls) — sem conta, sem chave, sem rede. A
//! mesma API do painel de mídia do volume. Ideia vinda do `media.rs` do Coucou.
//!
//! Uma thread lê o estado a cada segundo e avisa o pet e o chat só quando algo muda:
//! tocando ou não, a faixa, e se o Spotify é a janela em foco (o pet dança com
//! notinhas quando é).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

#[derive(Serialize, Clone, PartialEq, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub playing: bool,
    pub title: String,
    pub artist: String,
    /// "Spotify", "Chrome"…
    pub source: String,
    pub is_spotify: bool,
    /// O Spotify é a janela em primeiro plano.
    pub spotify_focused: bool,
    /// A capa do álbum como data URL ("" sem capa). Lida só quando a faixa muda.
    pub art: String,
}

/// O último estado lido, para o chat que acabou de abrir.
#[derive(Default)]
pub struct Current(pub Mutex<MediaState>);

/// Capas maiores que isso ficam de fora (o normal é ~20–80 KB).
const MAX_ART: u64 = 1024 * 1024;

/// A capa da faixa (`Thumbnail` da sessão de mídia) como data URL.
fn read_art(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    use base64::Engine;
    use windows::Storage::Streams::DataReader;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ART {
        return None;
    }
    let kind = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    let got = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut buf = vec![0u8; got as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let kind = if kind.starts_with("image/") { kind } else { "image/jpeg".into() };
    Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

fn init_apartment() {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
}

/// A sessão do Spotify se houver; senão a que estiver tocando; senão a atual.
fn pick_session(manager: &Manager) -> windows::core::Result<Option<Session>> {
    let sessions: Vec<Session> = manager.GetSessions().map(|s| s.into_iter().collect()).unwrap_or_default();
    let playing = |s: &Session| {
        s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false)
    };
    if let Some(s) = sessions.iter().find(|s| session_id(s).contains("spotify")) {
        return Ok(Some(s.clone()));
    }
    if let Some(s) = sessions.iter().find(|s| playing(s)) {
        return Ok(Some(s.clone()));
    }
    Ok(manager.GetCurrentSession().ok())
}

fn session_id(s: &Session) -> String {
    s.SourceAppUserModelId().map(|h| h.to_string().to_lowercase()).unwrap_or_default()
}

fn source_name(app_id: &str) -> String {
    let id = app_id.to_lowercase();
    for (needle, name) in [
        ("spotify", "Spotify"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("zunemusic", "Media Player"),
        ("vlc", "VLC"),
    ] {
        if id.contains(needle) {
            return name.into();
        }
    }
    app_id.rsplit(['\\', '!']).next().unwrap_or(app_id).trim_end_matches(".exe").to_string()
}

/// De quanto em quanto tempo escolher a sessão de novo (um player abriu ou fechou).
const REPICK: Duration = Duration::from_secs(5);
/// Tocando, de quanto em quanto tempo reler título e artista (troca de faixa).
const PROPS_EVERY: Duration = Duration::from_secs(4);
/// Depois de um erro do serviço de mídia, quanto esperar para tentar de novo.
const RETRY: Duration = Duration::from_secs(10);

/// Guarda o gerenciador de sessões e a sessão escolhida entre uma leitura e
/// outra. Antes, um gerenciador novo (`RequestAsync`), a lista de sessões e o
/// título eram pedidos a cada segundo; por horas a fio, isso pesava no serviço
/// de mídia do Windows (o mesmo do painel de volume e da bandeja).
#[derive(Default)]
struct Reader {
    manager: Option<Manager>,
    session: Option<Session>,
    picked_at: Option<Instant>,
    props_at: Option<Instant>,
    retry_at: Option<Instant>,
    /// Janela em primeiro plano na última leitura, e se ela era o Spotify.
    foreground: (isize, bool),
    last: MediaState,
}

impl Reader {
    fn read(&mut self) -> MediaState {
        let spotify_focused = self.spotify_focused();
        if self.retry_at.is_some_and(|t| Instant::now() < t) {
            return MediaState { spotify_focused, ..Default::default() };
        }
        let state = self.read_session().unwrap_or_else(|_| {
            // o player fechou ou o serviço de mídia reiniciou: recomeça do zero
            *self = Self { foreground: self.foreground, retry_at: Some(Instant::now() + RETRY), ..Default::default() };
            MediaState::default()
        });
        MediaState { spotify_focused, ..state }
    }

    /// O nome do executável só é lido quando a janela em primeiro plano muda.
    fn spotify_focused(&mut self) -> bool {
        let hwnd = crate::winsys::foreground_window();
        if hwnd != self.foreground.0 {
            let is_spotify = crate::winsys::window_exe(hwnd).is_some_and(|exe| exe == "spotify.exe");
            self.foreground = (hwnd, is_spotify);
        }
        self.foreground.1
    }

    fn read_session(&mut self) -> windows::core::Result<MediaState> {
        let manager = match &self.manager {
            Some(m) => m.clone(),
            None => {
                let m = Manager::RequestAsync()?.get()?;
                self.manager = Some(m.clone());
                m
            }
        };
        if self.picked_at.is_none_or(|t| t.elapsed() > REPICK) {
            let picked = pick_session(&manager)?;
            if picked.as_ref().map(session_id) != self.session.as_ref().map(session_id) {
                self.props_at = None;
            }
            self.session = picked;
            self.picked_at = Some(Instant::now());
        }
        let Some(s) = self.session.clone() else {
            self.last = MediaState::default();
            return Ok(MediaState::default());
        };
        let app_id = s.SourceAppUserModelId()?.to_string();
        let mut state = MediaState {
            source: source_name(&app_id),
            is_spotify: app_id.to_lowercase().contains("spotify"),
            playing: s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing,
            ..Default::default()
        };
        // título e artista: ao trocar de sessão, ao tocar/pausar e, tocando, a cada poucos segundos
        let stale = self.props_at.is_none()
            || state.playing != self.last.playing
            || (state.playing && self.props_at.is_some_and(|t| t.elapsed() > PROPS_EVERY));
        if stale {
            if let Ok(props) = s.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
                state.title = props.Title().map(|h| h.to_string()).unwrap_or_default();
                state.artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
                // a capa só muda com a faixa
                let same = state.title == self.last.title && state.artist == self.last.artist && !self.last.art.is_empty();
                state.art = if same { self.last.art.clone() } else { read_art(&props).unwrap_or_default() };
            }
            self.props_at = Some(Instant::now());
        } else {
            state.title = self.last.title.clone();
            state.artist = self.last.artist.clone();
            state.art = self.last.art.clone();
        }
        self.last = state.clone();
        Ok(state)
    }
}

/// Lê a cada segundo e emite `media` para o pet quando o estado muda.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        init_apartment();
        let mut reader = Reader::default();
        let mut last = MediaState::default();
        let mut first = true;
        loop {
            let now = reader.read();
            if first || now != last {
                let _ = app.emit_to("pet", "media", &now);
                let _ = app.emit_to("chat", "media", &now);
                *app.state::<Current>().0.lock().unwrap() = now.clone();
                last = now;
                first = false;
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

/// `play-pause`, `next`, `previous`. Bloqueante: chame fora da thread principal.
pub fn control(action: &str) -> Result<(), String> {
    init_apartment();
    let manager = Manager::RequestAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
    let s = pick_session(&manager).map_err(|e| e.to_string())?.ok_or("nenhum player aberto")?;
    let op = match action {
        "play-pause" => s.TryTogglePlayPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "previous" => s.TrySkipPreviousAsync(),
        other => return Err(format!("ação desconhecida: {other}")),
    };
    op.and_then(|o| o.get()).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_de_origem() {
        assert_eq!(source_name("Spotify.exe"), "Spotify");
        assert_eq!(source_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(source_name("C:\\apps\\foo.exe"), "foo");
    }
}

#[cfg(test)]
mod real {
    /// Só na mão (`cargo test -p digitama capa_real -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn capa_real() {
        super::init_apartment();
        let s = super::Reader::default().read();
        println!("fonte={} tocando={} título? {} capa: {} bytes ({})", s.source, s.playing, !s.title.is_empty(), s.art.len(), s.art.split(';').next().unwrap_or(""));
    }
}
