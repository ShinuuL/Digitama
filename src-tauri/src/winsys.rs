//! O Win32 do app: identidade do usuário (pipe), cursor, processo em primeiro
//! plano (Spotify em foco) e trazer a janela do Claude para frente.
//!
//! `focus_vscode` é adaptado do `vscode_focus.rs` do Coucou (MIT, © Louis Raillé).

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONULL};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, SetWindowPos,
    ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, SW_RESTORE, WS_EX_TOPMOST,
};

// ── Identidade ───────────────────────────────────────────────────────────────

pub fn current_user_sid() -> Option<String> {
    unsafe { token_sid(GetCurrentProcess()) }
}

/// O processo `pid` roda como o mesmo usuário que nós? Na dúvida, não.
pub fn pid_is_same_user(pid: u32) -> bool {
    let Some(mine) = current_user_sid() else { return false };
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let theirs = token_sid(process);
        let _ = CloseHandle(process);
        theirs.as_deref() == Some(mine.as_str())
    }
}

pub fn pipe_client_pid(handle: std::os::windows::io::RawHandle) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(HANDLE(handle), &mut pid).ok()? };
    (pid != 0).then_some(pid)
}

unsafe fn token_sid(process: HANDLE) -> Option<String> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        let _ = CloseHandle(token);
        return None;
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok();
    let _ = CloseHandle(token);
    if !ok {
        return None;
    }
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
    let sid = text.to_string().ok();
    let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
    sid
}

// ── Cursor e primeiro plano ──────────────────────────────────────────────────

/// Posição do cursor em pixels físicos da tela.
pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// A janela em primeiro plano (0 = nenhuma).
pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// Nome do executável dono da janela, em minúsculas ("spotify.exe").
pub fn window_exe(raw: isize) -> Option<String> {
    unsafe {
        let hwnd = HWND(raw as *mut _);
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit(['\\', '/']).next().map(|s| s.to_lowercase())
    }
}

/// Abre o ditado do Windows (Win+H) no campo de texto em foco. É o clique no
/// 🎤 do chat que pede: o Windows só aceita a tecla do app em primeiro plano.
pub fn voice_typing() {
    const VK_LWIN: u8 = 0x5B;
    const VK_H: u8 = 0x48;
    unsafe {
        keybd_event(VK_LWIN, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_H, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_H, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
    }
}

/// O seletor de pasta do Windows (o mesmo do Explorer). `None` se cancelar.
pub fn pick_folder(owner: Option<isize>, title: &str) -> Option<std::path::PathBuf> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let picked = (|| -> windows::core::Result<Option<std::path::PathBuf>> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
            dialog.SetTitle(&HSTRING::from(title))?;
            if dialog.Show(owner.map(|h| HWND(h as *mut _))).is_err() {
                return Ok(None); // cancelou
            }
            let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = name.to_string().ok().map(std::path::PathBuf::from);
            CoTaskMemFree(Some(name.0 as *const _));
            Ok(path)
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        picked.ok().flatten()
    }
}

// ── A janela do pet ──────────────────────────────────────────────────────────
// Win32 direto pelo HWND, de qualquer thread. Os métodos da janela do Tauri
// esperam a thread principal a cada chamada; o laço do clique-através faz
// isso 30 vezes por segundo.

/// Posição e tamanho (pixels físicos) e escala de DPI da janela.
pub fn window_rect(raw: isize) -> Option<(i32, i32, i32, i32, f64)> {
    let hwnd = HWND(raw as *mut _);
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r).ok()? };
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top, scale))
}

pub fn window_visible(raw: isize) -> bool {
    unsafe { IsWindowVisible(HWND(raw as *mut _)).as_bool() }
}

/// O ponto (pixels físicos) está em algum monitor?
pub fn point_on_screen(x: i32, y: i32) -> bool {
    unsafe { !MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL).0.is_null() }
}

/// Devolve o "sempre por cima" se o Windows o tirou (sem ativar nem mover).
pub fn ensure_topmost(raw: isize) {
    let hwnd = HWND(raw as *mut _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOPMOST.0 == 0 {
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS;
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
        }
    }
}

// ── Trazer o chat do Claude para frente ──────────────────────────────────────

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<(HWND, String)>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return true.into();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]).to_lowercase();
    out.push((hwnd, title));
    true.into()
}

fn visible_windows() -> Vec<(HWND, String)> {
    let mut found: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

fn bring_to_front(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        // O Windows só deixa o app em primeiro plano passar o foco adiante. Um
        // Alt sintético libera um app em segundo plano a fazer isso uma vez.
        keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(hwnd).as_bool()
    }
}

/// Títulos do VS Code: "arquivo.ts - projeto - Visual Studio Code".
fn title_names(title: &str, folder: &str) -> bool {
    title.contains(&format!(" - {folder} - ")) || title.starts_with(&format!("{folder} - "))
}

/// Traz para frente a janela onde o Claude Code da sessão está: o VS Code com a
/// pasta do projeto aberta, senão qualquer VS Code/Cursor, senão um terminal.
pub fn focus_claude(cwd: Option<&str>) -> bool {
    let windows = visible_windows();
    let editors: Vec<&(HWND, String)> = windows
        .iter()
        .filter(|(_, t)| t.ends_with("visual studio code") || t.ends_with(" - cursor"))
        .collect();
    if let Some(p) = cwd {
        let folders: Vec<String> = std::path::Path::new(p)
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
                _ => None,
            })
            .collect();
        for folder in folders.iter().rev() {
            if let Some((hwnd, _)) = editors.iter().find(|(_, t)| title_names(t, folder)) {
                return bring_to_front(*hwnd);
            }
        }
    }
    if let Some((hwnd, _)) = editors.first() {
        return bring_to_front(*hwnd);
    }
    let terminal = windows
        .iter()
        .find(|(_, t)| t.contains("claude") || t.contains("windows powershell") || t.contains("terminal"));
    terminal.is_some_and(|(hwnd, _)| bring_to_front(*hwnd))
}
