// Ponte com o backend Rust (comandos Tauri) e tipos compartilhados.
import { invoke } from "@tauri-apps/api/core";
import type { LineId } from "./lore";

export interface PetState {
  line: LineId;
  nickname: string;
  xp: number;
  stageLock: number | null;
  currentName: string;
  currentStage: number;
  scale: number;
  sounds: boolean;
  personaChat: boolean;
  claudePath: string;
  allowedTools: string;
  model: string;
  forceOauth: boolean;
  printScreenKey: boolean;
  chatProvider: "claude" | "opencode";
  opencodePath: string;
  opencodeModel: string;
  onboarded: boolean;
  usageRefreshMin: number;
  chatPermissionMode: "manual" | "auto" | "acceptEdits" | "plan";
  chatEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  chatMcpOff: string[];
  pos: [number, number] | null;
  tasksDone: number;
  questionsAnswered: number;
}

export interface MediaState {
  playing: boolean;
  title: string;
  artist: string;
  source: string;
  isSpotify: boolean;
  spotifyFocused: boolean;
  /** Capa do álbum (data URL) ou "". */
  art: string;
}

/** Limites do plano do Claude, como a barra de status do Claude Code recebe. */
export interface UsageWindow {
  used_percentage?: number;
  resets_at?: number;
}
export interface Usage {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

/** Uma sessão do Claude Code aberta pela extensão do VS Code. */
export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  project: string;
  branch: string;
  /** Última gravação (ms desde 1970). */
  updated: number;
  /** "working", "waiting", "idle" (aberta) ou "" (fechada). */
  status: "working" | "waiting" | "idle" | "";
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

/** Uma conversa do chat (uma aba). */
export interface ConvInfo {
  key: string;
  title: string;
  /** Pasta onde trabalha ("" = a do Digitama). */
  cwd: string;
  /** A sessão do VS Code que ela continua. */
  source: string;
  busy: boolean;
  /** Há pergunta ou permissão esperando você. */
  waiting: boolean;
}

/** O que o chat tem na pasta de trabalho (do `init` do Claude Code). */
export interface Capabilities {
  cwd: string;
  slash_commands: string[] | null;
  mcp_servers: { name: string; status: string }[] | null;
  tools: string[] | null;
}

export interface GithubStatus {
  repo: string;
  url: string;
  branch: string;
  pr: {
    number: number;
    title: string;
    url: string;
    state: string;
    draft: boolean;
    review: string | null;
    checks: { ok: number; fail: number; wait: number };
  } | null;
  issues: { number: number; title: string; url: string }[];
}

/** Um anexo do chat: imagem ou PDF em base64, ou um arquivo de texto. */
export interface Attachment {
  kind: "image" | "pdf" | "text";
  name: string;
  mediaType: string;
  data: string;
}

export interface Shot {
  png: string;
  width: number;
  height: number;
  /** Captura: monitor do cursor [x, y, w, h] em pixels do print. */
  monitor?: [number, number, number, number] | null;
}

export const api = {
  state: () => invoke<PetState>("state_get"),
  patch: (patch: Partial<PetState>) => invoke<PetState>("state_set", { patch }),
  hitRegions: (rects: [number, number, number, number][]) => invoke("hit_regions", { rects }),
  hookAck: (requestId: string) => invoke("hook_ack", { requestId }),
  hookDecline: (requestId: string) => invoke("hook_decline", { requestId }),
  hookAnswer: (requestId: string, decision: "allow" | "deny") => invoke("hook_answer", { requestId, decision }),
  hookAnswerQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
    invoke("hook_answer_question", { requestId, answers }),
  focusClaude: (cwd?: string) => invoke<boolean>("focus_claude", { cwd: cwd ?? null }),
  openWindow: (name: "chat" | "settings") => invoke("open_window", { name }),
  // ── Chat: várias conversas, cada uma com o seu Claude Code ──
  chatList: () => invoke<ConvInfo[]>("chat_list"),
  /** Uma conversa nova em `path` (null = a pasta do Digitama); devolve a chave. */
  chatNew: (path: string | null) => invoke<string>("chat_new", { path }),
  chatClose: (conv: string) => invoke("chat_close", { conv }),
  chatSend: (conv: string, text: string, attachments: Attachment[], persona: string | null) =>
    invoke("chat_send", { conv, text, attachments, persona }),
  /** Abre o ditado do Windows (Win+H) no campo em foco. */
  dictate: () => invoke("dictate"),
  chatStop: (conv: string) => invoke("chat_stop", { conv }),
  chatReset: (conv: string) => invoke("chat_reset", { conv }),
  chatTakeAttachment: () => invoke<Shot | null>("chat_take_attachment"),
  /** Responde a um pedido de permissão ou a uma pergunta (`input` com as respostas). */
  chatPermission: (conv: string, requestId: string, allow: boolean, always: boolean, input?: Record<string, unknown>) =>
    invoke("chat_permission", { conv, requestId, allow, always, input: input ?? null }),
  /** Redesenhar uma conversa (trocar de aba, recarregar; a anterior, se o app reabriu). */
  chatHistory: (conv: string) =>
    invoke<{ events: Record<string, any>[]; pending: string[]; busy: boolean; previous: { recent: SessionMessage[] } | null }>("chat_history", {
      conv,
    }),
  sessionsList: () => invoke<SessionInfo[]>("sessions_list"),
  /** Uma conversa continua uma cópia da sessão (`reuse`: a aba atual, se vazia). */
  sessionContinue: (s: { id: string; title: string; project: string; cwd: string }, reuse: string | null) =>
    invoke<{ conv: string; recent: SessionMessage[] }>("session_continue", { id: s.id, title: s.title, project: s.project, cwd: s.cwd, reuse }),
  chatFolderPick: () => invoke<string | null>("chat_folder_pick"),
  chatCapabilities: (cwd: string) => invoke<Capabilities>("chat_capabilities", { cwd }),
  githubStatus: (cwd: string) => invoke<GithubStatus | null>("github_status", { cwd }),
  openUrl: (url: string) => invoke("open_url", { url }),
  captureScreen: () => invoke<Shot>("capture_screen"),
  screenshotAndAsk: () => invoke("screenshot_and_ask"),
  /** Abre o recorte estilo Lightshot (tela congelada, seleção e anotações). */
  snipOpen: () => invoke("snip_open"),
  snipImage: () => invoke<Shot>("snip_image"),
  snipClose: () => invoke("snip_close"),
  snipReady: () => invoke("snip_ready"),
  savePng: (png: string) => invoke<string>("save_png", { png }),
  copyPng: (png: string) => invoke("copy_png", { png }),
  attachToChat: (png: string, width: number, height: number) => invoke("attach_to_chat", { png, width, height }),
  media: (action: "play-pause" | "next" | "previous") => invoke("media_control", { action }),
  mediaSearch: (query: string) => invoke("media_search", { query }),
  mediaState: () => invoke<MediaState>("media_state"),
  hooksStatus: () => invoke<{ installed: boolean; settingsPath: string; hookPath: string; hookReady: boolean }>("hooks_status"),
  hooksPreview: (install: boolean) =>
    invoke<{ diff: string; settingsPath: string; fingerprint: string; changes: boolean }>("hooks_preview", { install }),
  hooksApply: (install: boolean, fingerprint: string) => invoke<string>("hooks_apply", { install, fingerprint }),
  claudeInfo: () => invoke<{ path: string | null; version: string | null }>("claude_info"),
  mcpCommand: () => invoke<string>("mcp_command"),
  mcpInstall: () => invoke<string>("mcp_install"),
  opencodeMcpCommand: () => invoke<string>("opencode_mcp_command"),
  opencodeMcpInstall: () => invoke<string>("opencode_mcp_install"),
  /** Sem `ids`, todos os sprites; com, só os desses Digimon. */
  customSprites: (ids?: string[]) => invoke<Record<string, string>>("custom_sprites", { ids: ids ?? null }),
  petAlive: () => invoke("pet_alive").catch(() => {}),
  openSpritesFolder: () => invoke("open_sprites_folder"),
  petVisibility: (visible?: boolean) => invoke("pet_visibility", { visible: visible ?? null }),
  quit: () => invoke("quit"),
  usageGet: () => invoke<Usage | null>("usage_get"),
  usageRefresh: () => invoke<Usage | null>("usage_refresh"),
  usageBarStatus: () => invoke<boolean>("usage_bar_status"),
  usageBarPreview: (install: boolean) =>
    invoke<{ diff: string; settingsPath: string; fingerprint: string; changes: boolean }>("usage_bar_preview", { install }),
  usageBarApply: (install: boolean, fingerprint: string) => invoke<string>("usage_bar_apply", { install, fingerprint }),
  logError: (message: string) => invoke("log_error", { message }).catch(() => {}),
  opencodeStatus: () =>
    invoke<{ installed: boolean; upToDate: boolean; foreign: boolean; path: string; found: string | null; version: string | null }>(
      "opencode_status",
    ),
  opencodePluginPreview: (install: boolean) => invoke<string>("opencode_plugin_preview", { install }),
  opencodePluginApply: (install: boolean) => invoke<string>("opencode_plugin_apply", { install }),
  opencodeModels: () => invoke<string[]>("opencode_models"),
  spritesDownload: (force: boolean) => invoke<{ downloaded: number; failed: number }>("sprites_download", { force }),
  spritesMissing: () => invoke<number>("sprites_missing"),
  autostartGet: () => invoke<boolean>("autostart_get"),
  autostartSet: (on: boolean) => invoke<boolean>("autostart_set", { on }),
};
