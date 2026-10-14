//! O estado do pet e as preferências, num JSON em %APPDATA%\br.com.mastersys.digitama.
//! Nenhum segredo vive aqui: o chat usa o login do próprio Claude Code (OAuth).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PetState {
    /// Linha evolutiva: "agumon", "gabumon" ou "patamon".
    pub line: String,
    pub nickname: String,
    pub xp: u64,
    /// Estágio mostrado, quando fixado nas configurações (0 = ovo … 6 = mega).
    pub stage_lock: Option<u8>,
    /// O que o pet mostra agora (escrito pelo pet, lido pelo `pet_status` do MCP).
    pub current_name: String,
    pub current_stage: u8,
    /// Tamanho do pixel (3–6).
    pub scale: u8,
    pub sounds: bool,
    /// O chat responde no papel do Digimon.
    pub persona_chat: bool,
    /// Caminho do claude.exe; vazio = detectar.
    pub claude_path: String,
    /// Ferramentas liberadas no chat (separadas por vírgula).
    pub allowed_tools: String,
    /// Modelo do chat; vazio = padrão do Claude Code.
    pub model: String,
    /// Remove ANTHROPIC_API_KEY do ambiente do chat, para usar o login OAuth.
    pub force_oauth: bool,
    /// Onde o pet estava (pixels físicos).
    pub pos: Option<(i32, i32)>,
    pub tasks_done: u64,
    pub questions_answered: u64,
    /// A tecla Print Screen abre o recorte (como o Lightshot). Vale ao reabrir.
    pub print_screen_key: bool,
    /// Quem responde no chat: "claude" (Claude Code) ou "opencode".
    pub chat_provider: String,
    /// Caminho do opencode.exe; vazio = detectar.
    pub opencode_path: String,
    /// Modelo do OpenCode (`provedor/modelo`); vazio = o padrão dele.
    pub opencode_model: String,
    /// Já passou pelos "Primeiros passos" do Digivice.
    pub onboarded: bool,
    /// A cada quantos minutos consultar o uso do Claude (0 = não consultar).
    pub usage_refresh_min: u32,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            line: "agumon".into(),
            nickname: String::new(),
            xp: 0,
            stage_lock: None,
            current_name: "Digitama".into(),
            current_stage: 0,
            scale: 4,
            sounds: true,
            persona_chat: true,
            claude_path: String::new(),
            allowed_tools: "Read,Glob,Grep,WebSearch,WebFetch".into(),
            model: String::new(),
            force_oauth: true,
            pos: None,
            tasks_done: 0,
            questions_answered: 0,
            print_screen_key: true,
            chat_provider: "claude".into(),
            opencode_path: String::new(),
            opencode_model: String::new(),
            onboarded: false,
            usage_refresh_min: 10,
        }
    }
}

pub struct Store {
    pub state: Mutex<PetState>,
    path: PathBuf,
}

impl Store {
    pub fn load(app: &AppHandle) -> Self {
        let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("digitama"));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("state.json");
        let state = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<PetState>(&b).ok())
            .unwrap_or_default();
        Self { state: Mutex::new(state), path }
    }

    pub fn get(&self) -> PetState {
        self.state.lock().unwrap().clone()
    }

    fn save(&self, state: &PetState) {
        let Ok(text) = serde_json::to_string_pretty(state) else { return };
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    /// Mescla `patch` (campos em camelCase) no estado, salva e avisa as janelas.
    pub fn patch(&self, app: &AppHandle, patch: &Value) -> Result<PetState, String> {
        let next = {
            let mut guard = self.state.lock().unwrap();
            let mut current = serde_json::to_value(&*guard).map_err(|e| e.to_string())?;
            if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    obj.insert(k.clone(), v.clone());
                }
            }
            let next: PetState = serde_json::from_value(current).map_err(|e| e.to_string())?;
            *guard = next.clone();
            next
        };
        self.save(&next);
        let _ = app.emit("state-changed", &next);
        Ok(next)
    }

    /// Mudança feita pelo próprio Rust (posição da janela): salva sem avisar.
    pub fn update_quiet(&self, change: impl FnOnce(&mut PetState)) {
        let next = {
            let mut guard = self.state.lock().unwrap();
            change(&mut guard);
            guard.clone()
        };
        self.save(&next);
    }

    pub fn data_dir(&self) -> PathBuf {
        self.path.parent().map(PathBuf::from).unwrap_or_default()
    }
}
