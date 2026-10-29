// Chat do pet com o Claude Code logado (OAuth) ou com o OpenCode (qualquer
// provedor configurado nele): texto, anexos, print da tela e a persona do
// Digimon atual. Várias conversas ao mesmo tempo, cada uma com o seu Claude
// Code (dá para trocar enquanto uma responde); os eventos chegam do backend com
// a conversa de origem. À esquerda, as conversas e as sessões do Claude Code no
// VS Code, por projeto: clicar numa continua uma cópia dela aqui.
import "../shared/digivice.css";
import "./chat.css";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  type Attachment,
  type Capabilities,
  type ConvInfo,
  type MediaState,
  type PetState,
  type SessionInfo,
  type SessionMessage,
  type Shot,
  type Usage,
} from "../shared/api";
import { pct, resetText } from "../shared/usage";
import { STAGES, monFor, personaPrompt } from "../shared/lore";
import { drawMonFit, loadPacks } from "../pet/render";
import { ClaudeView } from "./claude-view";
import { bytesOf, fromFile, fromPaste, isBigPaste, sizeText } from "./attachments";
import { GithubCard, LOCAL_COMMANDS, McpPanel, Player, SlashMenu } from "./extras";
import { esc, md, mdMsg } from "./markdown";
import { follow, initScroll, toEnd } from "./scroll";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

document.body.innerHTML = `
  <aside id="side">
    <div class="side-head">
      <span class="dv-label">Conversas</span>
      <button id="conv-new" class="icon" title="Nova conversa (fora dos projetos)">＋</button>
    </div>
    <div id="convs"></div>
    <button id="folder" class="dv-btn mini" title="Começar uma conversa trabalhando numa pasta de projeto">📁 Nova conversa numa pasta…</button>
    <div class="side-head">
      <span class="dv-label">Sessões · VS Code</span>
      <button id="side-refresh" class="icon" title="Atualizar a lista">↻</button>
    </div>
    <input id="side-search" type="search" placeholder="Buscar sessão ou projeto…" />
    <div id="side-list"><div class="side-empty">Procurando sessões…</div></div>
  </aside>
  <section id="main">
    <header>
      <button id="side-toggle" class="icon" title="Mostrar/esconder as conversas e sessões">☰</button>
      <canvas id="avatar" width="56" height="56"></canvas>
      <div class="who"><b id="name"></b><span id="status">pronto</span></div>
      <div id="usage" class="chat-usage hidden"></div>
      <select id="provider" title="Quem responde">
        <option value="claude">Claude Code</option>
        <option value="opencode">OpenCode</option>
      </select>
      <button id="reset" class="dv-btn" title="Outra conversa, na mesma pasta desta">Nova</button>
    </header>
    <div id="info"></div>
    <main id="log"></main>
    <button id="jump" class="dv-btn mini hidden" title="Ir para o fim da conversa">↓ novas mensagens</button>
    <footer>
      <div id="attachments" class="hidden"></div>
      <textarea id="input" rows="3" placeholder="Pergunte…"></textarea>
      <div class="actions">
        <button id="file" class="icon" title="Anexar arquivos (imagens, PDF, texto) — ou arraste para cá">📎</button>
        <button id="shot" class="icon" title="Recortar a tela (Print Screen) e anexar">📷</button>
        <button id="mic" class="icon" title="Ditar a mensagem (ditado do Windows, Win+H)">🎤</button>
        <span class="claude-only">
          <select id="model" title="Modelo">
            <option value="">Modelo padrão</option>
            <option value="fable">Fable</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
          <select id="effort" title="Quanto o Claude pensa antes de responder">
            <option value="">Pensamento padrão</option>
            <option value="low">Pensa pouco</option>
            <option value="medium">Pensa médio</option>
            <option value="high">Pensa bastante</option>
            <option value="xhigh">Pensa muito</option>
            <option value="max">Pensa o máximo</option>
          </select>
          <select id="mode" title="Permissões do Claude Code no chat">
            <option value="manual">Perguntar</option>
            <option value="auto">Auto</option>
            <option value="acceptEdits">Aceitar edições</option>
            <option value="plan">Planejar</option>
          </select>
          <button id="mcp" class="icon wide" title="MCPs e conectores do Claude Code no chat">🔌<small id="mcp-count"></small></button>
        </span>
        <button id="theme" class="icon" title="Trocar o tema do chat">🎨</button>
        <label class="toggle" title="A IA responde no papel do seu Digimon"><input type="checkbox" id="persona" /> persona</label>
        <span class="grow"></span>
        <button id="stop" class="dv-btn warn hidden">■ Parar</button>
        <button id="send" class="dv-btn go">Enviar</button>
      </div>
      <input id="picker" type="file" multiple hidden />
    </footer>
  </section>
  <div id="drop" class="hidden"><div class="dv-banner">SOLTE PARA ANEXAR</div></div>`;

initScroll($("#log"), $("#jump"));

/** Temas do chat (guardado só neste PC). */
const THEMES = [
  ["digivice", "Digivice"],
  ["noite", "Noite"],
  ["brasa", "Brasa"],
] as const;
function applyTheme(id: string) {
  document.body.dataset.theme = id;
  try {
    localStorage.setItem("digitama.chat.theme", id);
  } catch {
    /* tudo bem */
  }
}
try {
  applyTheme(localStorage.getItem("digitama.chat.theme") ?? "digivice");
} catch {
  applyTheme("digivice");
}
$("#theme").onclick = () => {
  const i = THEMES.findIndex(([id]) => id === document.body.dataset.theme);
  const [id, name] = THEMES[(i + 1) % THEMES.length];
  applyTheme(id);
  $("#theme").title = `Tema: ${name} (clique para trocar)`;
};

const player = new Player();
$("#usage").before(player.root);
const github = new GithubCard();
$("#info").after(github.root);
const slash = new SlashMenu($<HTMLTextAreaElement>("#input"));
$("footer").prepend(slash.root);
const mcp = new McpPanel();
$("footer").prepend(mcp.root);

let state: PetState;
let attachments: Attachment[] = [];
/** A conversa mostrada está respondendo. */
let busy = false;
let current: { id: string; el: HTMLElement; text: string } | null = null;
const toolChips = new Set<string>();
let stderrTail: string[] = [];
/** OpenCode: já apareceu um erro nesta resposta (não repetir no fim). */
let ocErrored = false;

/** As conversas abertas (abas) e a mostrada. */
let convs: ConvInfo[] = [];
let active = "";
const ACTIVE_KEY = "digitama.chat.active";

const PROVIDERS = { claude: "Claude Code", opencode: "OpenCode" } as const;
const providerName = () => PROVIDERS[state.chatProvider] ?? "Claude Code";

function mon() {
  return monFor(state.line, state.currentStage);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function folderName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function activeConv(): ConvInfo | undefined {
  return convs.find((c) => c.key === active);
}

/** Pasta da conversa mostrada ("" = a do Digitama). */
function activeCwd() {
  return activeConv()?.cwd ?? "";
}

function selectValue(sel: HTMLSelectElement, value: string) {
  // um valor configurado no Digivice que não está na lista entra como opção
  if (value && ![...sel.options].some((o) => o.value === value)) sel.append(new Option(value, value));
  sel.value = value;
}

function paintHeader() {
  const m = mon();
  $("#name").textContent = state.nickname ? `${state.nickname} (${m.name})` : m.name;
  $("#name").title = $("#name").textContent ?? "";
  const c = $<HTMLCanvasElement>("#avatar");
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  drawMonFit(g, m.id, 28, 54, 52, 52);
  $<HTMLInputElement>("#persona").checked = state.personaChat;
  $<HTMLSelectElement>("#provider").value = state.chatProvider;
  selectValue($<HTMLSelectElement>("#model"), state.model ?? "");
  selectValue($<HTMLSelectElement>("#effort"), state.chatEffort ?? "");
  $<HTMLSelectElement>("#mode").value = state.chatPermissionMode ?? "manual";
  $(".claude-only").classList.toggle("hidden", state.chatProvider !== "claude");
  slash.onlyLocal = state.chatProvider !== "claude";
  $<HTMLTextAreaElement>("#input").placeholder = `Pergunte ao ${providerName()}…  (Enter envia, Shift+Enter quebra linha)`;
}

function setBusy(on: boolean, status?: string) {
  busy = on;
  $("#send").classList.toggle("hidden", on);
  $("#stop").classList.toggle("hidden", !on);
  $("#status").textContent = status ?? (on ? `${mon().name} está pensando…` : "pronto");
}

/** A linha de informação: o provedor e onde a conversa trabalha. */
function paintInfo(extra = "") {
  const cwd = activeCwd();
  const where = cwd ? `trabalhando em ${folderName(cwd)}` : "fora dos projetos";
  $("#info").textContent = [providerName(), where, extra].filter(Boolean).join(" · ");
  $("#info").title = cwd || "O chat não mexe em nenhum projeto até você escolher uma pasta.";
}

// ── Uso do plano (5h e semana) ───────────────────────────────────────────────

let usage: Usage | null = null;
function paintUsage() {
  const box = $("#usage");
  const rows: [string, Usage["five_hour"], string][] = [
    ["5h", usage?.five_hour, ""],
    ["sem", usage?.seven_day, "sp"],
  ];
  const shown = rows.filter(([, w]) => pct(w) !== null);
  box.classList.toggle("hidden", !shown.length);
  box.replaceChildren(
    ...shown.map(([label, w, kind]) => {
      const p = pct(w) ?? 0;
      const row = el("div", "cu-row");
      const bar = el("div", `dv-bar ${kind} ${p >= 80 ? "danger" : ""}`);
      const fill = el("i");
      fill.style.width = `${p}%`;
      bar.append(fill);
      row.append(el("span", "cu-label", label), bar, el("span", "cu-val", `${Math.round(p)}%`));
      row.title = `${label === "5h" ? "Janela de 5 horas" : "Semana"}: ${Math.round(p)}% usado${resetText(w) ? ` · ${resetText(w)}` : ""}`;
      return row;
    }),
  );
}

// ── Mensagens ────────────────────────────────────────────────────────────────

function add(kind: "user" | "assistant" | "tool" | "error" | "note", html: string) {
  const e = el("div", `msg ${kind}`);
  e.innerHTML = html;
  $("#log").append(e);
  follow();
  return e;
}

function assistantBlock(id: string) {
  if (current?.id === id) return current;
  const e = add("assistant", "");
  current = { id, el: e, text: "" };
  return current;
}

function appendText(id: string, text: string) {
  const b = assistantBlock(id);
  b.text += text;
  b.el.innerHTML = mdMsg(b.text);
  follow();
}

function chip(id: string, name: string) {
  if (toolChips.has(id)) return;
  toolChips.add(id);
  const label = name.startsWith("mcp__") ? `🔌 ${name.split("__").slice(1).join(" · ")}` : `🔧 ${name}`;
  add("tool", esc(label));
}

type Ev = Record<string, any>;

/** Linhas do `opencode run --format json`: text, tool_use, step_*, error. */
function onOpencode(ev: Ev) {
  switch (ev.type) {
    case "text": {
      const part = ev.part ?? {};
      if (part.text) appendText(part.id ?? crypto.randomUUID(), part.text);
      current = null; // cada parte de texto do OpenCode chega inteira
      break;
    }
    case "tool_use": {
      const part = ev.part ?? {};
      chip(part.id ?? part.partID ?? crypto.randomUUID(), part.tool ?? "ferramenta");
      break;
    }
    case "error":
      ocErrored = true;
      add("error", esc(`Erro: ${ev.error?.message ?? ev.error?.data?.message ?? "desconhecido"}`));
      break;
    case "digitama_stderr":
      stderrTail = [...stderrTail, ev.text].slice(-8);
      break;
    case "digitama_exit": {
      if (ev.code && ev.code !== 0 && !ocErrored) {
        const tail = stderrTail.join("\n");
        const auth = /auth|login|api key|unauthorized|401/i.test(tail);
        add(
          "error",
          esc(auth ? "O OpenCode não tem um provedor configurado. Rode `opencode auth login` num terminal." : `O OpenCode terminou com erro.${tail ? "\n" + tail : ""}`),
        );
      }
      stderrTail = [];
      ocErrored = false;
      current = null;
      setBusy(false, "pronto");
      break;
    }
  }
}

/** Pensando, ferramentas, permissões e perguntas do Claude Code (src/chat/claude-view.ts). */
const view = new ClaudeView({
  log: $("#log"),
  md: mdMsg,
  status: (text) => {
    if (busy) $("#status").textContent = `${mon().name}: ${text}`;
  },
  answer: (requestId, allow, always, input) => api.chatPermission(active, requestId, allow, always, input),
});

const MODES: Record<PetState["chatPermissionMode"], string> = {
  manual: "pergunta antes de usar ferramentas",
  auto: "modo auto",
  acceptEdits: "aceita edições",
  plan: "só planeja",
};

function onEvent(ev: Ev) {
  // de outra conversa: a lista (chat-convs) já mostra o que ela está fazendo
  if (ev.digitama_conv && ev.digitama_conv !== active) return;
  if (ev.provider === "opencode") return onOpencode(ev);
  view.handle(ev);
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        const servers = (ev.mcp_servers ?? []) as { name: string; status: string }[];
        const ok = servers.filter((s) => s.status === "connected").map((s) => s.name);
        setCaps({ cwd: ev.cwd ?? "", slash_commands: ev.slash_commands, mcp_servers: ev.mcp_servers, tools: ev.tools });
        const mode = MODES[state.chatPermissionMode] ?? MODES.manual;
        paintInfo([ev.model ?? "modelo padrão", mode, ok.length ? `MCP: ${ok.join(", ")}` : ""].filter(Boolean).join(" · "));
      }
      break;
    case "result":
      current = null;
      void refreshGithub(); // um commit, um push ou um PR novo mudam o cartão
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

// ── Anexos ───────────────────────────────────────────────────────────────────

function renderAttachments() {
  const box = $("#attachments");
  box.classList.toggle("hidden", !attachments.length);
  box.replaceChildren(
    ...attachments.map((a, i) => {
      const c = el("div", `att ${a.kind}`);
      if (a.kind === "image") {
        const img = el("img");
        img.src = `data:${a.mediaType};base64,${a.data}`;
        c.append(img);
      } else {
        c.append(el("span", "att-icon", a.kind === "pdf" ? "PDF" : "TXT"));
      }
      const info = el("div", "att-info");
      info.append(el("b", undefined, a.name), el("small", undefined, sizeText(bytesOf(a))));
      c.append(info);
      if (a.kind === "text" && a.name.startsWith("colado-")) {
        // desfaz: o texto colado volta para a caixa
        const back = el("button", "att-btn", "↩");
        back.title = "Colar como texto na mensagem";
        back.onclick = () => {
          const input = $<HTMLTextAreaElement>("#input");
          input.setRangeText(a.data, input.selectionStart, input.selectionEnd, "end");
          attachments.splice(i, 1);
          renderAttachments();
          input.focus();
        };
        c.append(back);
      }
      const rm = el("button", "att-btn", "✕");
      rm.title = "Remover";
      rm.onclick = () => {
        attachments.splice(i, 1);
        renderAttachments();
      };
      c.append(rm);
      c.title = a.name;
      return c;
    }),
  );
}

async function addFiles(files: Iterable<File>) {
  for (const f of files) {
    try {
      attachments.push(await fromFile(f));
    } catch (e) {
      add("error", esc(e instanceof Error ? e.message : String(e)));
    }
  }
  renderAttachments();
}

function addShot(shot: Shot | null) {
  if (!shot) return;
  attachments.push({ kind: "image", name: `print-${shot.width}x${shot.height}.png`, mediaType: "image/png", data: shot.png });
  renderAttachments();
}

// ── Envio ────────────────────────────────────────────────────────────────────

/** Imagem em tamanho real por cima do chat; clique ou Esc fecham. */
function zoomShot(src: string) {
  const box = el("div", "zoom-shot");
  const img = el("img");
  img.src = src;
  box.append(img);
  const close = () => {
    box.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  box.onclick = close;
  window.addEventListener("keydown", onKey, true);
  document.body.append(box);
}

// miniaturas da conversa: clicar amplia
$("#log").addEventListener("click", (e) => {
  const t = e.target;
  if (t instanceof HTMLImageElement && t.classList.contains("shot")) zoomShot(t.src);
});

/** A sua mensagem na conversa (ao redesenhar, os anexos vêm só com o nome). */
function showUser(text: string, files: { kind: string; name: string; mediaType?: string; data?: string }[]) {
  const thumbs = files
    .map((a) =>
      a.kind === "image" && a.data ? `<img class="shot" src="data:${a.mediaType};base64,${a.data}" />` : `<span class="att-chip">📎 ${esc(a.name)}</span>`,
    )
    .join("");
  // anexos numa faixa própria; o texto vai embaixo, não ao lado
  add("user", thumbs ? `<div class="msg-atts">${thumbs}</div>${esc(text)}` : esc(text));
}

/** Comandos do Digitama no chat (/novo, /print…). */
function runLocal(c: string) {
  if (c === "novo") $("#reset").click();
  else if (c === "print") $("#shot").click();
  else if (c === "anexar") $("#file").click();
  else if (c === "parar") $("#stop").click();
}
slash.onLocal = runLocal;

async function send() {
  const input = $<HTMLTextAreaElement>("#input");
  let text = input.value.trim();
  const local = /^\/([\w-]+)$/.exec(text)?.[1];
  if (local && local in LOCAL_COMMANDS) {
    input.value = "";
    runLocal(local);
    return;
  }
  if (busy || (!text && !attachments.length)) return;
  const files = attachments;
  if (!text) text = files.some((a) => a.kind === "image") ? "O que você vê nesta imagem? Me ajude com o que estiver aberto." : "Veja o anexo.";
  showUser(text, files);
  input.value = "";
  attachments = [];
  renderAttachments();
  setBusy(true);
  if (state.chatProvider === "opencode") paintInfo(state.opencodeModel || "modelo padrão do OpenCode");
  const persona = state.personaChat ? personaPrompt(mon(), state.nickname) : null;
  try {
    await api.chatSend(active, text, files, persona);
  } catch (e) {
    add("error", esc(String(e)));
    setBusy(false);
  }
}

$("#send").onclick = () => void send();
// copiar: o bloco de código, ou a mensagem inteira (sem os botões)
$("#log").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".copy");
  if (!btn) return;
  e.stopPropagation();
  const code = btn.closest(".code")?.querySelector("pre");
  let text = code?.textContent ?? "";
  if (!code) {
    const msg = btn.closest(".msg")?.cloneNode(true) as HTMLElement | undefined;
    msg?.querySelectorAll(".copy").forEach((b) => b.remove());
    text = msg?.innerText.trim() ?? "";
  }
  void navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = "✓";
      btn.classList.add("done");
      window.setTimeout(() => {
        btn.textContent = "⧉";
        btn.classList.remove("done");
      }, 1200);
    },
    () => add("error", esc("Não consegui copiar para a área de transferência.")),
  );
});
// links das respostas abrem no navegador, não dentro do chat
$("#log").addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  void api.openUrl(a.href);
});
$("#stop").onclick = () => {
  void api.chatStop(active);
  setBusy(false, "interrompido");
};
function clearLog() {
  $("#log").replaceChildren();
  view.reset();
  toolChips.clear();
  current = null;
  stderrTail = [];
}
// "Nova": outra conversa, na mesma pasta desta
$("#reset").onclick = () => void newConversationIn(activeCwd() || null);

/** Modelo, pensamento e permissões valem a partir da próxima mensagem (o Claude Code reabre com --resume). */
function setting<K extends "model" | "chatEffort" | "chatPermissionMode">(id: string, key: K, label: (v: PetState[K]) => string) {
  $<HTMLSelectElement>(id).onchange = (e) => {
    const value = (e.target as HTMLSelectElement).value as PetState[K];
    state[key] = value;
    void api.patch({ [key]: value } as Partial<PetState>);
    add("note", esc(`${label(value)} — vale a partir da próxima mensagem.`));
  };
}
setting("#model", "model", (v) => `Modelo: ${v || "padrão do Claude Code"}`);
setting("#effort", "chatEffort", (v) => `Pensamento: ${$<HTMLSelectElement>("#effort").selectedOptions[0]?.text ?? v}`);
setting("#mode", "chatPermissionMode", (v) => `Permissões: ${MODES[v]}`);

$<HTMLSelectElement>("#provider").onchange = async (e) => {
  const value = (e.target as HTMLSelectElement).value as PetState["chatProvider"];
  state.chatProvider = value;
  void api.patch({ chatProvider: value });
  paintHeader();
  // a conversa mostrada recomeça com o outro provedor
  await api.chatReset(active);
  clearLog();
  setBusy(false, `agora com ${providerName()}`);
  intro();
};
// O print abre o recorte (seleção + anotações, todas as telas); "Perguntar à IA" anexa aqui.
$("#shot").onclick = () => void api.snipOpen();
$("#file").onclick = () => $<HTMLInputElement>("#picker").click();
$<HTMLInputElement>("#picker").onchange = (e) => {
  const input = e.target as HTMLInputElement;
  void addFiles(input.files ?? []).then(() => (input.value = ""));
};
$("#mic").onclick = () => {
  // o ditado do Windows escreve no campo em foco
  $("#input").focus();
  window.setTimeout(() => void api.dictate(), 60);
};
$<HTMLInputElement>("#persona").onchange = (e) => {
  state.personaChat = (e.target as HTMLInputElement).checked;
  void api.patch({ personaChat: state.personaChat });
};
const inputBox = $<HTMLTextAreaElement>("#input");
inputBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
// colar: imagem vira anexo; texto com mais de 2 linhas vira um .txt
inputBox.addEventListener("paste", (e) => {
  const data = e.clipboardData;
  if (!data) return;
  if (data.files.length) {
    e.preventDefault();
    void addFiles(data.files);
    return;
  }
  const text = data.getData("text/plain");
  if (text && isBigPaste(text)) {
    e.preventDefault();
    attachments.push(fromPaste(text));
    renderAttachments();
  }
});
// arrastar e soltar arquivos em qualquer lugar do chat
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("#drop").classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#drop").classList.add("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop").classList.add("hidden");
  if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
});

// ── Conversas (abas) ─────────────────────────────────────────────────────────

function renderConvs() {
  $("#convs").replaceChildren(
    ...convs.map((c) => {
      const item = el("div", `conv${c.key === active ? " on" : ""}`);
      item.dataset.status = c.waiting ? "waiting" : c.busy ? "working" : "idle";
      const top = el("div", "sess-top");
      top.append(el("i", "dot"), el("b", "sess-title", c.title));
      const close = el("button", "conv-x", "✕");
      close.title = c.busy ? "Fechar (para o que ela está fazendo)" : "Fechar esta conversa";
      close.onclick = (e) => {
        e.stopPropagation();
        void api.chatClose(c.key);
      };
      top.append(close);
      const doing = c.waiting ? "esperando você" : c.busy ? "trabalhando" : "";
      item.append(top, el("div", "sess-meta", [c.cwd ? folderName(c.cwd) : "fora dos projetos", doing].filter(Boolean).join(" · ")));
      item.title = c.cwd || "Pasta do Digitama (fora dos projetos)";
      item.onclick = () => void switchTo(c.key);
      return item;
    }),
  );
}

/** Mostra a conversa `key` (a outra continua trabalhando, se estava). */
async function switchTo(key: string) {
  if (!convs.some((c) => c.key === key)) return;
  active = key;
  try {
    localStorage.setItem(ACTIVE_KEY, key);
  } catch {
    /* tudo bem */
  }
  renderConvs();
  renderSessions();
  clearLog();
  setBusy(false);
  paintInfo();
  if (!(await restore(key))) intro();
  toEnd();
  void refreshCaps();
  void refreshGithub();
  $("#input").focus();
}

/** Uma conversa nova trabalhando em `path` (null = a pasta do Digitama). */
async function newConversationIn(path: string | null) {
  let key: string;
  try {
    key = await api.chatNew(path);
  } catch (e) {
    add("error", esc(String(e)));
    return;
  }
  if (state.chatProvider !== "claude" && path) {
    state.chatProvider = "claude";
    void api.patch({ chatProvider: "claude" });
    paintHeader();
  }
  convs = await api.chatList();
  await switchTo(key);
}

$("#conv-new").onclick = () => void newConversationIn(null);
$("#folder").onclick = async () => {
  const path = await api.chatFolderPick();
  if (path) void newConversationIn(path);
};

// ── Sessões do VS Code, por projeto ──────────────────────────────────────────

let sessions: SessionInfo[] = [];

const STATUS: Record<SessionInfo["status"], string> = {
  working: "trabalhando",
  waiting: "esperando você",
  idle: "aberta",
  "": "",
};

function ago(ms: number) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

/** Projetos abertos na lista (os outros ficam recolhidos). */
const GROUPS_KEY = "digitama.chat.groups";
let openGroups: Set<string> | null = null;
try {
  const saved = localStorage.getItem(GROUPS_KEY);
  if (saved) openGroups = new Set(JSON.parse(saved) as string[]);
} catch {
  /* sem armazenamento: o padrão vale */
}
function saveGroups() {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...(openGroups ?? [])]));
  } catch {
    /* tudo bem */
  }
}

function sessionItem(s: SessionInfo, showProject: boolean) {
  const conv = convs.find((c) => c.source === s.id);
  const item = el("div", `sess${conv ? " here" : ""}${conv?.key === active ? " on" : ""}`);
  item.dataset.status = s.status;
  const top = el("div", "sess-top");
  top.append(el("i", "dot"), el("b", "sess-title", s.title));
  const open = el("button", "sess-vscode", "VS Code");
  open.title = "Trazer a janela do VS Code desta sessão para frente";
  open.onclick = (e) => {
    e.stopPropagation();
    void api.focusClaude(s.cwd);
  };
  top.append(open);
  const meta = [showProject ? s.project : "", s.branch, s.status ? STATUS[s.status] : ago(s.updated)].filter(Boolean).join(" · ");
  item.append(top, el("div", "sess-meta", meta));
  item.title = conv
    ? `${s.title}\nJá está aberta numa conversa do chat: clique para ir até ela`
    : `${s.title}\n${s.cwd}\nClique para continuar aqui (uma cópia; a do VS Code não muda)`;
  item.onclick = () => void (conv ? switchTo(conv.key) : continueHere(s));
  return item;
}

function renderSessions() {
  const list = $("#side-list");
  const q = $<HTMLInputElement>("#side-search").value.trim().toLowerCase();
  const shown = sessions.filter((s) => !q || `${s.title} ${s.project} ${s.branch}`.toLowerCase().includes(q));
  const parts: HTMLElement[] = [];
  const live = shown.filter((s) => s.status);
  if (live.length) parts.push(el("div", "dv-label side-group", "Agora"), ...live.map((s) => sessionItem(s, true)));
  // as outras, por pasta de projeto, na ordem da mais recente
  const byProject = new Map<string, SessionInfo[]>();
  for (const s of shown.filter((s) => !s.status)) {
    const key = s.project || "(sem pasta)";
    byProject.set(key, [...(byProject.get(key) ?? []), s]);
  }
  // na primeira vez, só o projeto mais recente fica aberto
  openGroups ??= new Set([...byProject.keys()].slice(0, 1));
  if (byProject.size) parts.push(el("div", "dv-label side-group", "Últimos 7 dias"));
  for (const [project, list] of byProject) {
    const open = !!q || openGroups.has(project);
    const head = el("button", `proj${open ? " open" : ""}`);
    head.append(el("i", "chev", open ? "▾" : "▸"), el("b", undefined, project), el("small", undefined, String(list.length)));
    head.title = list[0]?.cwd ?? project;
    const cwd = list[0]?.cwd;
    if (cwd) {
      const plus = el("span", "proj-new", "＋");
      plus.title = `Nova conversa trabalhando em ${cwd}`;
      plus.onclick = (e) => {
        e.stopPropagation();
        void newConversationIn(cwd);
      };
      head.append(plus);
    }
    head.onclick = () => {
      if (openGroups!.has(project)) openGroups!.delete(project);
      else openGroups!.add(project);
      saveGroups();
      renderSessions();
    };
    parts.push(head);
    if (open) parts.push(...list.map((s) => sessionItem(s, false)));
  }
  if (!parts.length) parts.push(el("div", "side-empty", q ? "Nenhuma sessão com esse nome." : "Nenhuma sessão do VS Code nos últimos 7 dias."));
  list.replaceChildren(...parts);
}

let loadingSessions = false;
async function refreshSessions() {
  if (loadingSessions) return;
  loadingSessions = true;
  try {
    sessions = await api.sessionsList();
    renderSessions();
  } catch (e) {
    $("#side-list").replaceChildren(el("div", "side-empty", `Não consegui ler as sessões: ${e}`));
  } finally {
    loadingSessions = false;
  }
}

/** Continua uma cópia da sessão do VS Code numa conversa (sempre pelo Claude Code). */
async function continueHere(s: SessionInfo) {
  let r: { conv: string; recent: SessionMessage[] };
  try {
    r = await api.sessionContinue(s, active);
  } catch (e) {
    add("error", esc(String(e)));
    return;
  }
  if (state.chatProvider !== "claude") {
    state.chatProvider = "claude";
    void api.patch({ chatProvider: "claude" });
    paintHeader();
  }
  convs = await api.chatList();
  await switchTo(r.conv);
}

// ── Comandos, MCPs e GitHub (da pasta da conversa) ───────────────────────────

const CAPS_KEY = "digitama.chat.caps";
function setCaps(c: Capabilities) {
  slash.set(c.slash_commands);
  mcp.set(c, state.chatMcpOff ?? []);
  const { on, total } = mcp.summary;
  $("#mcp-count").textContent = total ? ` ${on}/${total}` : "";
  try {
    const all = JSON.parse(localStorage.getItem(CAPS_KEY) ?? "{}") as Record<string, Capabilities>;
    all[activeCwd() || "-"] = c;
    localStorage.setItem(CAPS_KEY, JSON.stringify(all));
  } catch {
    /* sem cache: busca de novo na próxima vez */
  }
}

/** Comandos e MCPs da pasta: o que estava guardado aparece já, o atual chega em seguida. */
async function refreshCaps() {
  const cwd = activeCwd();
  try {
    const cached = (JSON.parse(localStorage.getItem(CAPS_KEY) ?? "{}") as Record<string, Capabilities>)[cwd || "-"];
    if (cached) setCaps(cached);
  } catch {
    /* sem cache */
  }
  try {
    const caps = await api.chatCapabilities(cwd);
    if (activeCwd() === cwd) setCaps(caps);
  } catch {
    /* sem o Claude Code: fica o que havia */
  }
}

mcp.onChange = (off) => {
  state.chatMcpOff = off;
  void api.patch({ chatMcpOff: off });
  const { on, total } = mcp.summary;
  $("#mcp-count").textContent = total ? ` ${on}/${total}` : "";
};
$("#mcp").onclick = () => mcp.toggle();

let githubBusy = false;
async function refreshGithub() {
  if (githubBusy) return;
  githubBusy = true;
  const cwd = activeCwd();
  try {
    const status = state.chatProvider === "claude" && cwd ? await api.githubStatus(cwd) : null;
    if (activeCwd() === cwd) github.show(status);
  } catch {
    github.show(null);
  } finally {
    githubBusy = false;
  }
}

function showRecent(recent: SessionMessage[]) {
  for (const m of recent) {
    const e = add(m.role, m.role === "assistant" ? mdMsg(m.text) : md(m.text));
    e.classList.add("hist");
    e.title = "Clique para ver inteira";
    e.onclick = () => e.classList.toggle("open");
  }
}

function showContinue(s: { title: string; project: string }, recent: SessionMessage[]) {
  add("note", esc(`Continuando uma cópia de “${s.title}” (${s.project}). A conversa no VS Code não muda; a primeira resposta aqui já tem todo o contexto dela.`));
  showRecent(recent);
  if (recent.length) add("note", esc("— daqui em diante, no Digitama —"));
}

/**
 * Redesenha a conversa `key` com o que o backend guardou: ao trocar de aba,
 * ou quando a página recarrega sozinha (o Vite no `tauri dev`, o WebView2 que
 * caiu). Voltam a conversa, os cartões e as perguntas e permissões pendentes.
 * Se foi o app que reabriu, mostra o fim da conversa anterior, que continua.
 */
async function restore(key: string): Promise<boolean> {
  let h: Awaited<ReturnType<typeof api.chatHistory>>;
  try {
    h = await api.chatHistory(key);
  } catch {
    return false;
  }
  if (key !== active) return true; // trocou de novo enquanto carregava
  if (h.events.length) {
    for (const ev of h.events) {
      if (ev.type === "digitama_user") {
        showUser(ev.text ?? "", ev.files ?? []);
        setBusy(true);
      } else if (ev.type === "digitama_continue") {
        showContinue(ev as { title: string; project: string }, (ev.recent ?? []) as SessionMessage[]);
      } else {
        onEvent(ev);
      }
    }
    view.settle(new Set(h.pending));
    setBusy(h.busy, h.busy ? undefined : "pronto");
    return true;
  }
  if (h.previous?.recent.length) {
    add("note", esc("O Digitama foi reaberto. Esta é a conversa de antes; a próxima mensagem continua dela."));
    showRecent(h.previous.recent);
    add("note", esc("— daqui em diante —"));
    return true;
  }
  return false;
}

let sideOpen = window.innerWidth >= 620;
try {
  const saved = localStorage.getItem("digitama.chat.side");
  if (saved) sideOpen = saved === "1";
} catch {
  /* sem armazenamento: fica o padrão */
}
document.body.classList.toggle("side-closed", !sideOpen);
$("#side-toggle").onclick = () => {
  sideOpen = !sideOpen;
  document.body.classList.toggle("side-closed", !sideOpen);
  try {
    localStorage.setItem("digitama.chat.side", sideOpen ? "1" : "0");
  } catch {
    /* tudo bem */
  }
};
$("#side-refresh").onclick = () => void refreshSessions();
$("#side-search").oninput = () => renderSessions();

async function boot() {
  state = await api.state();
  try {
    await loadPacks(await api.customSprites());
  } catch {
    /* sem sprites reais */
  }
  paintHeader();
  await listen<Ev>("chat-event", (e) => onEvent(e.payload));
  // a lista de conversas mudou (título, trabalhando, esperando você, fechada)
  await listen<ConvInfo[]>("chat-convs", (e) => {
    convs = e.payload;
    const me = activeConv();
    if (!me && convs.length) {
      void switchTo(convs[0].key);
      return;
    }
    if (me?.busy && !busy) setBusy(true);
    renderConvs();
    renderSessions();
  });
  await listen<PetState>("state-changed", (e) => {
    state = e.payload;
    paintHeader();
  });
  await listen("chat-attach", async () => addShot(await api.chatTakeAttachment()));
  addShot(await api.chatTakeAttachment());
  await listen<Usage>("usage", (e) => {
    usage = e.payload;
    paintUsage();
  });
  try {
    usage = await api.usageGet();
    paintUsage();
  } catch {
    /* ainda sem uso */
  }
  await listen<MediaState>("media", (e) => player.show(e.payload));
  api.mediaState().then((m) => player.show(m), () => {});
  convs = await api.chatList();
  let saved = "";
  try {
    saved = localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    /* sem armazenamento */
  }
  await switchTo(convs.some((c) => c.key === saved) ? saved : convs[0]?.key ?? "");
  window.setInterval(() => {
    if (document.visibilityState === "visible" && !busy) void refreshGithub();
  }, 120_000);
  void refreshSessions();
  let refreshTimer: number | undefined;
  await listen("sessions-changed", () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void refreshSessions(), 400);
  });
  window.addEventListener("focus", () => void refreshSessions());
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshSessions();
  }, 60_000);
}

function intro() {
  const m = mon();
  const cwd = activeCwd();
  const how =
    state.chatProvider === "opencode"
      ? "O chat usa o seu OpenCode, com os provedores e modelos configurados nele (troque o modelo no Digivice → Chat)."
      : cwd
        ? `Esta conversa trabalha em ${cwd}: o Claude lê o CLAUDE.md da pasta e pede permissão antes de mudar qualquer coisa (conforme o modo de permissões).`
        : "O chat usa o seu Claude Code logado — sem chave de API — com os mesmos servidores MCP e conectores.";
  paintInfo();
  add("note", esc(`${m.name} (${STAGES[m.stage]}) está aqui. ${how}`));
}

void boot();
