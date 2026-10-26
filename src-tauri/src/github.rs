//! O cartão do GitHub no chat: o repositório da pasta de trabalho, o branch, o
//! PR dele (com os checks do CI) e as issues atribuídas a você. Tudo pelo `gh`
//! já logado na máquina, só leitura, sem guardar token nenhum.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Roda um comando (gh ou git) na pasta e devolve o stdout, se deu certo.
fn run(exe: &Path, dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(exe);
    crate::claude::clean_env(&mut cmd);
    let out = cmd
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn json_of(exe: &Path, dir: &Path, args: &[&str]) -> Option<Value> {
    serde_json::from_str(&run(exe, dir, args)?).ok()
}

/// Os checks do CI do PR: quantos passaram, falharam e estão rodando.
fn checks(rollup: Option<&Value>) -> Value {
    let (mut ok, mut fail, mut wait) = (0, 0, 0);
    for c in rollup.and_then(Value::as_array).into_iter().flatten() {
        let state = c.get("conclusion").or_else(|| c.get("state")).and_then(Value::as_str).unwrap_or_default().to_uppercase();
        match state.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => ok += 1,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => fail += 1,
            _ => wait += 1,
        }
    }
    json!({ "ok": ok, "fail": fail, "wait": wait })
}

/// O status do GitHub da pasta, ou `null` se ela não é um repositório do
/// GitHub (ou o `gh` não está instalado).
pub fn status(dir: &Path) -> Value {
    let Some(gh) = crate::claude::find_gh() else { return Value::Null };
    let Some(repo) = json_of(&gh, dir, &["repo", "view", "--json", "nameWithOwner,url"]) else { return Value::Null };
    let git = Path::new("git");
    let branch = run(git, dir, &["branch", "--show-current"]).unwrap_or_default();
    let pr = json_of(&gh, dir, &["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"]).map(|p| {
        json!({
            "number": p.get("number"),
            "title": p.get("title"),
            "url": p.get("url"),
            "state": p.get("state"),
            "draft": p.get("isDraft"),
            "review": p.get("reviewDecision"),
            "checks": checks(p.get("statusCheckRollup")),
        })
    });
    let issues = json_of(&gh, dir, &["issue", "list", "--assignee", "@me", "--state", "open", "--limit", "5", "--json", "number,title,url"])
        .unwrap_or_else(|| json!([]));
    json!({ "repo": repo.get("nameWithOwner"), "url": repo.get("url"), "branch": branch, "pr": pr, "issues": issues })
}

/// Abre um link https no navegador (cartão do GitHub, links das respostas).
/// O explorer.exe recebe o endereço como argumento, sem passar por um shell.
pub fn open(url: &str) -> Result<(), String> {
    let ok = url.starts_with("https://") && url.len() < 2048 && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"');
    if !ok {
        return Err("endereço não permitido".into());
    }
    Command::new("explorer.exe").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conta_os_checks_do_ci() {
        let rollup = json!([
            { "conclusion": "SUCCESS" }, { "conclusion": "FAILURE" }, { "state": "PENDING" }, { "conclusion": "SKIPPED" }
        ]);
        assert_eq!(checks(Some(&rollup)), json!({ "ok": 2, "fail": 1, "wait": 1 }));
    }

    #[test]
    fn so_abre_links_https_sem_truque() {
        assert!(open("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(open("javascript:alert(1)").is_err());
        assert!(open("https://github.com/a/b\" & calc").is_err());
        assert!(open("https://x.com/a b").is_err());
    }
}
