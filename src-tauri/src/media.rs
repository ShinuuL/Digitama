//! Música: o Spotify (ou outro player) pela API de sessões de mídia do Windows
//! (GlobalSystemMediaTransportControls) — sem conta, sem chave, sem rede. A
//! mesma API do painel de mídia do volume. Ideia vinda do `media.rs` do Coucou.
//!
//! Uma thread lê o estado a cada segundo e avisa o pet só quando algo muda:
//! tocando ou não, a faixa, e se o Spotify é a janela em foco (o pet dança com
//! notinhas quando é).

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
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
}

fn init_apartment() {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
}

/// A sessão do Spotify se houver; senão a que estiver tocando; senão a atual.
fn pick_session() -> windows::core::Result<Option<Session>> {
    let manager = Manager::RequestAsync()?.get()?;
    let sessions: Vec<Session> = manager.GetSessions().map(|s| s.into_iter().collect()).unwrap_or_default();
    let id = |s: &Session| s.SourceAppUserModelId().map(|h| h.to_string().to_lowercase()).unwrap_or_default();
    let playing = |s: &Session| {
        s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false)
    };
    if let Some(s) = sessions.iter().find(|s| id(s).contains("spotify")) {
        return Ok(Some(s.clone()));
    }
    if let Some(s) = sessions.iter().find(|s| playing(s)) {
        return Ok(Some(s.clone()));
    }
    Ok(manager.GetCurrentSession().ok())
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

fn read() -> MediaState {
    let focused = crate::winsys::foreground_exe().is_some_and(|exe| exe == "spotify.exe");
    let mut state = MediaState { spotify_focused: focused, ..Default::default() };
    let Ok(Some(s)) = pick_session() else { return state };
    let app_id = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
    state.source = source_name(&app_id);
    state.is_spotify = app_id.to_lowercase().contains("spotify");
    state.playing = s
        .GetPlaybackInfo()
        .and_then(|i| i.PlaybackStatus())
        .map(|st| st == Status::Playing)
        .unwrap_or(false);
    if let Ok(props) = s.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
        state.title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        state.artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    }
    state
}

/// Lê a cada segundo e emite `media` para o pet quando o estado muda.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        init_apartment();
        let mut last = MediaState::default();
        let mut first = true;
        loop {
            let now = read();
            if first || now != last {
                let _ = app.emit_to("pet", "media", &now);
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
    let s = pick_session().map_err(|e| e.to_string())?.ok_or("nenhum player aberto")?;
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
