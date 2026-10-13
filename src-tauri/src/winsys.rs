//! O Win32 do app: identidade do usuário (pipe), cursor, processo em primeiro
//! plano (Spotify em foco) e trazer a janela do Claude para frente.
//!
//! `focus_vscode` é adaptado do `vscode_focus.rs` do Coucou (MIT, © Louis Raillé).

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, HWND, LPARAM, POINT};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
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

/// Nome do executável da janela em primeiro plano, em minúsculas ("spotify.exe").
pub fn foreground_exe() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
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
