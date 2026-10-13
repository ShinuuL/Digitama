// Chat com o Claude pelo Claude Code logado (OAuth): texto, print da tela e a
// persona do Digimon atual. Os eventos chegam do backend em stream-json.
import "./chat.css";
import { listen } from "@tauri-apps/api/event";
import { api, type PetState, type Shot } from "../shared/api";
import { STAGES, monFor, personaPrompt } from "../shared/lore";
import { drawMonFit, loadPacks } from "../pet/render";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

document.body.innerHTML = `
  <header>
    <canvas id="avatar" width="56" height="56"></canvas>
    <div class="who"><b id="name"></b><span id="status">pronto</span></div>
    <label class="toggle" title="O Claude responde no papel do seu Digimon"><input type="checkbox" id="persona" /> persona</label>
    <button id="reset" title="Começar uma conversa nova">Nova</button>
  </header>
  <div id="info"></div>
  <main id="log"></main>
  <footer>
    <div id="attach" class="hidden"><img id="thumb" alt="print" /><button id="unattach" title="Remover">✕</button></div>
    <textarea id="input" rows="3" placeholder="Pergunte ao Claude…  (Enter envia, Shift+Enter quebra linha)"></textarea>
    <div class="actions">
      <button id="shot" title="Tirar print da tela (o Digitama some na hora do print)">📷 Print</button>
      <span class="hint">Print Screen ou Ctrl+Alt+Shift+P</span>
      <button id="stop" class="hidden">■ Parar</button>
      <button id="send" class="primary">Enviar</button>
    </div>
  </footer>`;

let state: PetState;
let attachment: Shot | null = null;
let busy = false;
let current: { id: string; el: HTMLElement; text: string } | null = null;
const streamed = new Set<string>();
const toolChips = new Set<string>();
let stderrTail: string[] = [];

function mon() {
  return monFor(state.line, state.currentStage);
}

function paintHeader() {
  const m = mon();
  $("#name").textContent = state.nickname ? `${state.nickname} (${m.name})` : m.name;
  const c = $<HTMLCanvasElement>("#avatar");
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  drawMonFit(g, m.id, 28, 54, 52, 52);
  $<HTMLInputElement>("#persona").checked = state.personaChat;
}

function setBusy(on: boolean, status?: string) {
  busy = on;
  $("#send").classList.toggle("hidden", on);
  $("#stop").classList.toggle("hidden", !on);
  $("#status").textContent = status ?? (on ? `${mon().name} está pensando…` : "pronto");
}

// ── Markdown mínimo e seguro (tudo é escapado antes) ─────────────────────────

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function md(src: string): string {
  const parts = src.split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf("\n");
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        return `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
      }
      return esc(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");
    })
    .join("");
}

// ── Mensagens ────────────────────────────────────────────────────────────────

function add(kind: "user" | "assistant" | "tool" | "error" | "note", html: string) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = html;
  $("#log").append(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

function assistantBlock(id: string) {
  if (current?.id === id) return current;
  const el = add("assistant", "");
  current = { id, el, text: "" };
  return current;
}

function appendText(id: string, text: string) {
  const b = assistantBlock(id);
  b.text += text;
  b.el.innerHTML = md(b.text);
  b.el.scrollIntoView({ block: "end" });
}

function chip(id: string, name: string) {
  if (toolChips.has(id)) return;
  toolChips.add(id);
  const label = name.startsWith("mcp__") ? `🔌 ${name.split("__").slice(1).join(" · ")}` : `🔧 ${name}`;
  add("tool", esc(label));
}

type Ev = Record<string, any>;

function onEvent(ev: Ev) {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        const servers = (ev.mcp_servers ?? []) as { name: string; status: string }[];
        const ok = servers.filter((s) => s.status === "connected").map((s) => s.name);
        $("#info").textContent = `Claude Code · ${ev.model ?? "modelo padrão"}${ok.length ? ` · MCP: ${ok.join(", ")}` : ""}`;
      }
      break;
    case "stream_event": {
      const e = ev.event ?? {};
      if (e.type === "message_start") assistantBlock(e.message?.id ?? crypto.randomUUID());
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use") chip(e.content_block.id, e.content_block.name);
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && current) {
        streamed.add(current.id);
        appendText(current.id, e.delta.text);
      }
      break;
    }
    case "assistant": {
      const m = ev.message ?? {};
      for (const block of m.content ?? []) {
        if (block.type === "text" && !streamed.has(m.id)) appendText(m.id, block.text);
        if (block.type === "tool_use") chip(block.id, block.name);
      }
      break;
    }
    case "result":
      current = null;
      if (ev.is_error) add("error", esc(`Erro: ${ev.result ?? ev.subtype ?? "desconhecido"}`));
      setBusy(false, ev.duration_ms ? `pronto · ${(ev.duration_ms / 1000).toFixed(1)}s` : "pronto");
      stderrTail = [];
      break;
    case "digitama_stderr":
      stderrTail = [...stderrTail, ev.text].slice(-8);
      break;
    case "digitama_exit":
      if (busy) {
        const tail = stderrTail.join("\n");
        const login = /login|auth|401|credential/i.test(tail);
        add(
          "error",
          esc(login ? "O Claude Code não está logado. Abra um terminal, rode `claude` e use /login com a sua conta." : `O Claude Code fechou.${tail ? "\n" + tail : ""}`),
        );
        setBusy(false);
      }
      current = null;
      break;
  }
}

// ── Envio ────────────────────────────────────────────────────────────────────

function setAttachment(shot: Shot | null) {
  attachment = shot;
  $("#attach").classList.toggle("hidden", !shot);
  if (shot) $<HTMLImageElement>("#thumb").src = `data:image/png;base64,${shot.png}`;
}

async function send() {
  const input = $<HTMLTextAreaElement>("#input");
  let text = input.value.trim();
  if (busy || (!text && !attachment)) return;
  if (!text) text = "O que você vê neste print da minha tela? Me ajude com o que estiver aberto.";
  const img = attachment;
  add("user", `${img ? `<img class="shot" src="data:image/png;base64,${img.png}" />` : ""}${esc(text)}`);
  input.value = "";
  setAttachment(null);
  setBusy(true);
  const persona = state.personaChat ? personaPrompt(mon(), state.nickname) : null;
  try {
    await api.chatSend(text, img?.png ?? null, persona);
  } catch (e) {
    add("error", esc(String(e)));
    setBusy(false);
  }
}

$("#send").onclick = () => void send();
$("#stop").onclick = () => {
  void api.chatStop();
  setBusy(false, "interrompido");
};
$("#reset").onclick = () => {
  void api.chatReset();
  $("#log").replaceChildren();
  streamed.clear();
  toolChips.clear();
  current = null;
  setBusy(false, "nova conversa");
};
// O print abre o recorte (seleção + anotações); "Perguntar ao Claude" anexa aqui.
$("#shot").onclick = () => void api.snipOpen();
$("#unattach").onclick = () => setAttachment(null);
$<HTMLInputElement>("#persona").onchange = (e) => {
  state.personaChat = (e.target as HTMLInputElement).checked;
  void api.patch({ personaChat: state.personaChat });
};
$<HTMLTextAreaElement>("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

async function boot() {
  state = await api.state();
  try {
    await loadPacks(await api.customSprites());
  } catch {
    /* sem sprites reais */
  }
  paintHeader();
  await listen<Ev>("chat-event", (e) => onEvent(e.payload));
  await listen<PetState>("state-changed", (e) => {
    state = e.payload;
    paintHeader();
  });
  await listen("chat-attach", async () => setAttachment((await api.chatTakeAttachment()) ?? attachment));
  const pending = await api.chatTakeAttachment();
  if (pending) setAttachment(pending);
  const m = mon();
  add("note", esc(`${m.name} (${STAGES[m.stage]}) está aqui. O chat usa o seu Claude Code logado — sem chave de API — com os mesmos servidores MCP e conectores.`));
  $("#input").focus();
}

void boot();
