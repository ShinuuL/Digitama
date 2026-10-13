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
}

export interface Shot {
  png: string;
  width: number;
  height: number;
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
  chatSend: (text: string, image: string | null, persona: string | null) => invoke("chat_send", { text, image, persona }),
  chatStop: () => invoke("chat_stop"),
  chatReset: () => invoke("chat_reset"),
  chatTakeAttachment: () => invoke<Shot | null>("chat_take_attachment"),
  captureScreen: () => invoke<Shot>("capture_screen"),
  screenshotAndAsk: () => invoke("screenshot_and_ask"),
  /** Abre o recorte estilo Lightshot (tela congelada, seleção e anotações). */
  snipOpen: () => invoke("snip_open"),
  snipImage: () => invoke<Shot>("snip_image"),
  snipClose: () => invoke("snip_close"),
  savePng: (png: string) => invoke<string>("save_png", { png }),
  copyPng: (png: string) => invoke("copy_png", { png }),
  attachToChat: (png: string, width: number, height: number) => invoke("attach_to_chat", { png, width, height }),
  media: (action: "play-pause" | "next" | "previous") => invoke("media_control", { action }),
  hooksStatus: () => invoke<{ installed: boolean; settingsPath: string; hookPath: string; hookReady: boolean }>("hooks_status"),
  hooksPreview: (install: boolean) =>
    invoke<{ diff: string; settingsPath: string; fingerprint: string; changes: boolean }>("hooks_preview", { install }),
  hooksApply: (install: boolean, fingerprint: string) => invoke<string>("hooks_apply", { install, fingerprint }),
  claudeInfo: () => invoke<{ path: string | null; version: string | null }>("claude_info"),
  mcpCommand: () => invoke<string>("mcp_command"),
  mcpInstall: () => invoke<string>("mcp_install"),
  customSprites: () => invoke<Record<string, string>>("custom_sprites"),
  openSpritesFolder: () => invoke("open_sprites_folder"),
  petVisibility: (visible?: boolean) => invoke("pet_visibility", { visible: visible ?? null }),
  quit: () => invoke("quit"),
};
