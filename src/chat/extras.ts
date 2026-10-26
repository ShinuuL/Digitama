// Peças do chat em volta da conversa: o player do Spotify no cabeçalho, o menu
// de comandos de barra (/watch:watch…), o painel de MCPs e o cartão do GitHub.
import { api, type Capabilities, type GithubStatus, type MediaState } from "../shared/api";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ── Player (Spotify ou o player que estiver tocando) ─────────────────────────

export class Player {
  readonly root = el("div", "player hidden");
  private art = el("img", "pl-art");
  private title = el("b");
  private artist = el("small");
  private toggle = el("button", "pl-btn", "⏯");

  constructor() {
    const info = el("div", "pl-info");
    info.append(this.title, this.artist);
    const controls = el("div", "pl-ctrl");
    for (const [label, action] of [["⏮", "previous"], ["", "play-pause"], ["⏭", "next"]] as const) {
      const b = action === "play-pause" ? this.toggle : el("button", "pl-btn", label);
      b.title = { previous: "Anterior", "play-pause": "Tocar/pausar", next: "Próxima" }[action];
      b.onclick = () => void api.media(action);
      controls.append(b);
    }
    this.art.alt = "";
    this.root.append(this.art, info, controls);
  }

  show(m: MediaState | null) {
    const on = !!m?.title;
    this.root.classList.toggle("hidden", !on);
    if (!m || !on) return;
    this.root.classList.toggle("paused", !m.playing);
    this.title.textContent = m.title;
    this.artist.textContent = [m.artist, m.isSpotify ? "" : m.source].filter(Boolean).join(" · ");
    this.toggle.textContent = m.playing ? "⏸" : "▶";
    this.art.classList.toggle("hidden", !m.art);
    if (m.art && this.art.src !== m.art) this.art.src = m.art;
    this.root.title = `${m.title}${m.artist ? " — " + m.artist : ""} (${m.source})`;
  }
}

// ── Comandos de barra ────────────────────────────────────────────────────────

/** Comandos que só existem no terminal interativo (no chat não fazem nada). */
const TERMINAL_ONLY = new Set(["login", "logout", "config", "vim", "terminal-setup", "exit", "quit", "theme", "ide", "resume", "doctor"]);

export class SlashMenu {
  readonly root = el("div", "slash hidden");
  private commands: string[] = [];
  private shown: string[] = [];
  private index = 0;

  constructor(private input: HTMLTextAreaElement) {
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
    // antes do Enter de enviar: escolher o comando
    input.addEventListener(
      "keydown",
      (e) => {
        if (this.root.classList.contains("hidden")) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          this.index = (this.index + (e.key === "ArrowDown" ? 1 : -1) + this.shown.length) % this.shown.length;
          this.render();
        } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.pick(this.shown[this.index]);
        } else if (e.key === "Escape") {
          this.close();
        }
      },
      true,
    );
  }

  set(list: string[] | null | undefined) {
    if (list?.length) this.commands = [...new Set(list)].filter((c) => !TERMINAL_ONLY.has(c)).sort((a, b) => a.localeCompare(b));
  }

  get count() {
    return this.commands.length;
  }

  private update() {
    const m = /^\/([\w:.-]*)$/.exec(this.input.value);
    if (!m || !this.commands.length) return this.close();
    const q = m[1].toLowerCase();
    // primeiro os que começam com o que foi digitado, depois os que contêm
    const starts = this.commands.filter((c) => c.toLowerCase().startsWith(q) || c.split(":").pop()!.toLowerCase().startsWith(q));
    const rest = this.commands.filter((c) => !starts.includes(c) && c.toLowerCase().includes(q));
    this.shown = [...starts, ...rest].slice(0, 12);
    this.index = 0;
    if (!this.shown.length) return this.close();
    this.root.classList.remove("hidden");
    this.render();
  }

  private render() {
    this.root.replaceChildren(
      ...this.shown.map((c, i) => {
        const item = el("button", `slash-item${i === this.index ? " on" : ""}`);
        const [plugin, name] = c.includes(":") ? c.split(":") : ["", c];
        item.append(el("b", undefined, `/${name}`));
        if (plugin) item.append(el("small", undefined, plugin));
        item.onmousedown = (e) => {
          e.preventDefault();
          this.pick(c);
        };
        return item;
      }),
    );
    (this.root.children[this.index] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private pick(c: string | undefined) {
    if (!c) return;
    this.input.value = `/${c} `;
    this.input.focus();
    this.close();
  }

  close() {
    this.root.classList.add("hidden");
  }
}

// ── MCPs e conectores ────────────────────────────────────────────────────────

/** `claude.ai Figma` → `claude_ai_Figma`, como nas ferramentas `mcp__<nome>__…`. */
export function mcpKey(name: string) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

const MCP_STATUS: Record<string, string> = {
  connected: "conectado",
  "needs-auth": "precisa de login",
  failed: "falhou",
  pending: "conectando…",
  disabled: "desativado",
};

export class McpPanel {
  readonly root = el("div", "mcp-panel hidden");
  onChange: (off: string[]) => void = () => {};
  private caps: Capabilities | null = null;
  private off = new Set<string>();

  constructor() {
    window.addEventListener("mousedown", (e) => {
      if (!this.root.classList.contains("hidden") && !(e.target as HTMLElement).closest(".mcp-panel, #mcp")) this.close();
    });
  }

  set(caps: Capabilities | null, off: string[]) {
    if (caps) this.caps = caps;
    this.off = new Set(off);
    if (!this.root.classList.contains("hidden")) this.render();
  }

  /** Quantos ligados / quantos ao todo (para o botão). */
  get summary() {
    const servers = this.caps?.mcp_servers ?? [];
    return { on: servers.filter((s) => !this.off.has(mcpKey(s.name))).length, total: servers.length };
  }

  toggle() {
    if (this.root.classList.contains("hidden")) {
      this.root.classList.remove("hidden");
      this.render();
    } else this.close();
  }

  close() {
    this.root.classList.add("hidden");
  }

  private render() {
    const servers = this.caps?.mcp_servers ?? [];
    const tools = this.caps?.tools ?? [];
    const head = el("div", "mcp-head");
    head.append(el("span", "dv-label", "MCPs e conectores"), el("small", undefined, "os mesmos do seu Claude Code"));
    if (!servers.length) {
      this.root.replaceChildren(head, el("div", "mcp-empty", this.caps ? "Nenhum MCP configurado no Claude Code." : "Lendo os MCPs do Claude Code…"));
      return;
    }
    const rows = servers.map((s) => {
      const key = mcpKey(s.name);
      const count = tools.filter((t) => t.startsWith(`mcp__${key}__`)).length;
      const row = el("label", "mcp-row");
      row.dataset.status = s.status;
      const box = el("input");
      box.type = "checkbox";
      box.checked = !this.off.has(key);
      box.onchange = () => {
        if (box.checked) this.off.delete(key);
        else this.off.add(key);
        this.onChange([...this.off]);
      };
      const info = el("div", "mcp-info");
      info.append(el("b", undefined, s.name), el("small", undefined, [MCP_STATUS[s.status] ?? s.status, count ? `${count} ferramentas` : ""].filter(Boolean).join(" · ")));
      row.append(box, el("i", "mcp-dot"), info);
      if (s.status === "needs-auth") row.title = "Faça o login deste conector no Claude Code (/mcp num terminal) ou em claude.ai → Conectores.";
      return row;
    });
    const foot = el("div", "mcp-foot", "Desligar vale a partir da próxima mensagem.");
    this.root.replaceChildren(head, ...rows, foot);
  }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export class GithubCard {
  readonly root = el("div", "gh hidden");

  show(s: GithubStatus | null) {
    this.root.classList.toggle("hidden", !s);
    if (!s) return;
    const link = (text: string, url: string, cls = "") => {
      const a = el("a", cls, text);
      a.href = url;
      a.onclick = (e) => {
        e.preventDefault();
        void api.openUrl(url);
      };
      return a;
    };
    const parts: HTMLElement[] = [link(s.repo, s.url, "gh-repo")];
    if (s.branch) parts.push(el("span", "gh-branch", `⎇ ${s.branch}`));
    if (s.pr) {
      const c = s.pr.checks;
      const pr = el("span", "gh-pr");
      pr.append(link(`PR #${s.pr.number}${s.pr.draft ? " (rascunho)" : ""}`, s.pr.url));
      const ci = el("span", `gh-ci${c.fail ? " fail" : c.wait ? " wait" : c.ok ? " ok" : ""}`);
      ci.textContent = c.fail ? `✗ ${c.fail}` : c.wait ? `⏳ ${c.wait}` : c.ok ? `✓ ${c.ok}` : "";
      ci.title = `CI: ${c.ok} ok, ${c.fail} falharam, ${c.wait} rodando`;
      if (ci.textContent) pr.append(ci);
      pr.title = s.pr.title;
      parts.push(pr);
    } else if (s.branch) {
      parts.push(el("span", "gh-none", "sem PR"));
    }
    if (s.issues.length) {
      const issues = link(`${s.issues.length} issue${s.issues.length > 1 ? "s" : ""} sua${s.issues.length > 1 ? "s" : ""}`, `${s.url}/issues?q=is%3Aopen+assignee%3A%40me`);
      issues.title = s.issues.map((i) => `#${i.number} ${i.title}`).join("\n");
      parts.push(issues);
    }
    this.root.replaceChildren(el("b", "gh-logo", "GitHub"), ...parts);
  }
}
