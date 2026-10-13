//! O pouco de Win32 que o relay precisa: quem somos e quem está do outro lado
//! do pipe. Adaptado do `coucou-hook` (MIT, © Louis Raillé).
//!
//! Named pipes vivem num namespace da máquina toda, então qualquer conta pode
//! criar `\\.\pipe\digitama-<nome>` primeiro. Duas defesas: o nome leva o SID, e
//! depois de conectar conferimos que o servidor roda como o mesmo usuário.

use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::CONNECT_TIMEOUT;

const ERROR_PIPE_BUSY: i32 = 231;

fn pipe_path() -> String {
    let key = current_user_sid().unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\digitama-{key}")
}

/// Abre o pipe. Só tenta de novo enquanto o servidor está ocupado.
pub fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = HANDLE(file.as_raw_handle());
                return pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

pub fn current_user_sid() -> Option<String> {
    unsafe { token_sid(GetCurrentProcess()) }
}

/// Falha ao responder conta como "não é nosso": recusar custa um evento,
/// confiar poderia entregar o conteúdo das ferramentas a outra conta.
fn pipe_server_is_same_user(handle: HANDLE) -> bool {
    let Some(mine) = current_user_sid() else { return false };
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeServerProcessId(handle, &mut pid).is_err() || pid == 0 {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let theirs = token_sid(process);
        let _ = CloseHandle(process);
        theirs.as_deref() == Some(mine.as_str())
    }
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
