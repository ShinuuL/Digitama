// A conversa com o Claude Code desenhada como na extensão do VS Code: o
// "pensando…" com o tempo e os tokens, cada ferramenta num cartão (o comando,
// o arquivo, o padrão), a saída recolhida embaixo e os pedidos de permissão
// com botões. Os eventos são as linhas stream-json do `claude -p`.
import { follow } from "./scroll";

type Ev = Record<string, any>;

export interface ViewHost {
  log: HTMLElement;
  md: (src: string) => string;
  /** Texto da linha de status do cabeçalho. */
  status: (text: string) => void;
  /** Responde a um pedido da conversa mostrada (`input`: as respostas de uma pergunta). */
  answer: (requestId: string, allow: boolean, always: boolean, input?: Record<string, unknown>) => Promise<unknown>;
}

interface Card {
  el: HTMLElement;
  sum: HTMLElement;
  code: HTMLElement;
  out: HTMLElement;
  ask: HTMLElement;
  name: string;
}

interface Think {
  el: HTMLElement;
  label: HTMLElement;
  meta: HTMLElement;
  text: HTMLElement;
  t0: number;
  tokens: number;
  done: boolean;
}

type Block = { kind: "text"; el: HTMLElement | null; text: string } | { kind: "think"; think: Think } | { kind: "tool"; id: string; json: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Nome curto de ferramenta de MCP: `mcp__servidor__ferramenta` → "servidor · ferramenta". */
function toolName(name: string) {
  return name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : name;
}

const SHELLS = new Set(["Bash", "PowerShell"]);

/** O símbolo do "pensando", em giro, e os verbos que se revezam. */
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Pensando", "Ponderando", "Matutando", "Digievoluindo ideias", "Ligando os pontos", "Analisando", "Calculando", "Farejando o código", "Montando o plano"];
const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];

/** O resumo de uma chamada: uma linha e, para comandos, o próprio comando. */
function describe(name: string, input: Record<string, any>): { sum: string; code: string } {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (SHELLS.has(name)) return { sum: s("description"), code: s("command") };
  switch (name) {
    case "Read":
      return { sum: s("file_path") + (input.offset ? ` (a partir da linha ${input.offset})` : ""), code: "" };
    case "Write": {
      const lines = s("content") ? s("content").split("\n").length : 0;
      return { sum: `${s("file_path")}${lines ? ` · ${lines} linhas` : ""}`, code: "" };
    }
    case "Edit": {
      const minus = s("old_string") ? s("old_string").split("\n").length : 0;
      const plus = s("new_string") ? s("new_string").split("\n").length : 0;
      return { sum: `${s("file_path")}${minus || plus ? ` · −${minus} +${plus}` : ""}`, code: "" };
    }
    case "Grep":
      return { sum: `"${s("pattern")}"${s("path") ? ` em ${s("path")}` : ""}${s("glob") ? ` (${s("glob")})` : ""}`, code: "" };
    case "Glob":
      return { sum: s("pattern") + (s("path") ? ` em ${s("path")}` : ""), code: "" };
    case "WebFetch":
      return { sum: s("url"), code: "" };
    case "WebSearch":
      return { sum: s("query"), code: "" };
    case "Task":
    case "Agent":
      return { sum: s("description") || s("subagent_type"), code: "" };
    case "TodoWrite":
      return { sum: `${Array.isArray(input.todos) ? input.todos.length : 0} tarefas`, code: "" };
    default: {
      const json = JSON.stringify(input);
      return { sum: json === "{}" ? "" : json.length > 140 ? json.slice(0, 140) + "…" : json, code: "" };
    }
  }
}

/** O texto de um tool_result (string ou blocos). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[imagem]" : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

export class ClaudeView {
  private cards = new Map<string, Card>();
  /** Pedido de permissão → o cartão dele (para saber, ao redesenhar, quais já foram respondidos). */
  private asks = new Map<string, Card>();
  private blocks = new Map<number, Block>();
  /**
   * Os balões de texto de cada mensagem, montados pelos pedaços do streaming.
   * A mensagem inteira ("assistant") confere com eles: se o streaming parou no
   * meio (o Claude Code às vezes refaz a requisição sem streaming), o balão é
   * completado em vez de a resposta ficar cortada.
   */
  private bubbles = new Map<string, { el: HTMLElement | null; text: string }[]>();
  private msgId = "";
  private thinking: Think | null = null;
  private timer = 0;

  constructor(private host: ViewHost) {}

  reset() {
    this.cards.clear();
    this.asks.clear();
    this.blocks.clear();
    this.bubbles.clear();
    this.msgId = "";
    this.endThink();
  }

  private add(node: HTMLElement) {
    this.host.log.append(node);
    follow();
    return node;
  }

  // ── Pensando ────────────────────────────────────────────────────────────

  private startThink() {
    this.endThink();
    const glyph = el("i", "spin", GLYPHS[0]);
    const t: Think = { el: el("div", "think"), label: el("span", "think-label", pickVerb()), meta: el("small"), text: el("div", "think-text"), t0: performance.now(), tokens: 0, done: false };
    t.el.append(glyph, t.label, t.meta, t.text);
    t.el.onclick = () => t.done && t.text.textContent && t.el.classList.toggle("open");
    this.add(t.el);
    this.thinking = t;
    this.host.status("pensando…");
    // como no Claude Code: o símbolo gira e o verbo muda de vez em quando
    let tick = 0;
    this.timer = window.setInterval(() => {
      tick++;
      glyph.textContent = GLYPHS[tick % GLYPHS.length];
      if (tick % 25 === 0) t.label.textContent = pickVerb();
      if (tick % 4 === 0) this.paintThink(t);
    }, 120);
    this.paintThink(t);
    return t;
  }

  private paintThink(t: Think) {
    const secs = Math.max(1, Math.round((performance.now() - t.t0) / 1000));
    t.meta.textContent = [`${secs}s`, t.tokens ? `~${t.tokens} tokens` : ""].filter(Boolean).join(" · ");
  }

  private endThink() {
    window.clearInterval(this.timer);
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    t.done = true;
    this.paintThink(t);
    t.el.classList.add("done");
    t.label.textContent = "Pensou";
    if (t.text.textContent) t.el.title = "Clique para ver o raciocínio";
  }

  // ── Ferramentas ─────────────────────────────────────────────────────────

  private card(id: string, name: string): Card {
    let c = this.cards.get(id);
    if (c) return c;
    const root = el("div", "tool-card");
    root.dataset.state = "running";
    const head = el("div", "tc-head");
    const sum = el("span", "tc-sum");
    head.append(el("i", "tc-dot"), el("b", undefined, toolName(name)), sum);
    const code = el("pre", "tc-code hidden");
    const out = el("pre", "tc-out hidden");
    out.title = "Clique para ver tudo";
    out.onclick = () => out.classList.toggle("open");
    const ask = el("div", "tc-ask hidden");
    root.append(head, code, ask, out);
    c = { el: root, sum, code, out, ask, name };
    this.cards.set(id, c);
    this.add(root);
    this.host.status(`usando ${toolName(name)}…`);
    return c;
  }

  private fill(c: Card, input: Record<string, any>) {
    const d = describe(c.name, input ?? {});
    c.sum.textContent = d.sum;
    c.code.textContent = d.code ? `$ ${d.code}` : "";
    c.code.classList.toggle("hidden", !d.code);
  }

  private finish(id: string, content: unknown, isError: boolean) {
    const c = this.cards.get(id);
    if (!c) return;
    c.el.dataset.state = isError ? "error" : "ok";
    c.ask.classList.add("hidden");
    const text = resultText(content).trim();
    if (!text) return;
    const lines = text.split("\n");
    c.out.textContent = text.length > 6000 ? text.slice(0, 6000) + "\n…" : text;
    c.out.classList.remove("hidden");
    c.out.classList.toggle("long", lines.length > 4);
    this.host.status("pensando…");
  }

  /** Pedido de permissão (`can_use_tool`): o cartão ganha os botões. */
  private askPermission(requestId: string, req: Ev) {
    const c = this.card(req.tool_use_id ?? requestId, req.tool_name ?? "ferramenta");
    this.asks.set(requestId, c);
    c.el.dataset.state = "ask";
    if (req.tool_name === "AskUserQuestion" && Array.isArray(req.input?.questions)) return this.askQuestions(requestId, req, c);
    if (req.input) this.fill(c, req.input);
    const why = req.description || req.decision_reason || "O Claude Code quer usar esta ferramenta.";
    const row = el("div", "row");
    const allow = el("button", "dv-btn go mini", "Permitir");
    const deny = el("button", "dv-btn warn mini", "Negar");
    row.append(allow);
    const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
    let always: HTMLButtonElement | null = null;
    if (suggestions.length) {
      const rule = suggestions
        .flatMap((s: Ev) => (Array.isArray(s.rules) ? s.rules : []))
        .map((r: Ev) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
        .join(", ");
      always = el("button", "dv-btn mini", "Sempre");
      always.title = `Permitir e não perguntar de novo nesta pasta${rule ? `: ${rule}` : ""}`;
      row.append(always);
    }
    row.append(deny);
    c.ask.replaceChildren(el("div", "tc-why", why), row);
    c.ask.classList.remove("hidden");
    this.host.status("esperando sua permissão");
    const answer = async (ok: boolean, keep: boolean) => {
      allow.disabled = deny.disabled = true;
      if (always) always.disabled = true;
      try {
        await this.host.answer(requestId, ok, keep);
        c.el.dataset.state = ok ? "running" : "denied";
        c.ask.replaceChildren(el("div", "tc-why", ok ? (keep ? "Permitido (sempre, nesta pasta)" : "Permitido") : "Negado"));
        this.host.status(ok ? `usando ${toolName(c.name)}…` : "pensando…");
      } catch (e) {
        c.ask.replaceChildren(el("div", "tc-why", String(e)));
      }
    };
    allow.onclick = () => void answer(true, false);
    deny.onclick = () => void answer(false, false);
    if (always) always.onclick = () => void answer(true, true);
  }

  /**
   * AskUserQuestion: uma pergunta por vez, com as opções em botões (várias,
   * com Confirmar, quando a pergunta aceita mais de uma) e uma resposta livre.
   * As respostas voltam no mesmo input, no mapa `answers` (texto da pergunta →
   * rótulo, ou lista de rótulos), como o balão do pet faz.
   */
  private askQuestions(requestId: string, req: Ev, c: Card) {
    const questions = req.input.questions as { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }[];
    c.sum.textContent = questions.length > 1 ? `${questions.length} perguntas` : "pergunta";
    c.el.classList.add("question");
    const answers: Record<string, string | string[]> = {};
    this.host.status("esperando sua resposta");
    const send = async (ok: boolean) => {
      c.ask.querySelectorAll("button, input").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      try {
        await this.host.answer(requestId, ok, false, ok ? { ...req.input, answers } : undefined);
        c.el.dataset.state = ok ? "ok" : "denied";
        const summary = Object.entries(answers)
          .map(([q, a]) => `${q} → ${Array.isArray(a) ? a.join(", ") : a}`)
          .join("\n");
        c.ask.replaceChildren(el("div", "tc-answer", ok ? summary : "Pulada: o Claude segue sem a resposta."));
        this.host.status("pensando…");
      } catch (e) {
        c.ask.replaceChildren(el("div", "tc-why", String(e)));
      }
    };
    const step = (i: number) => {
      const q = questions[i];
      const parts: HTMLElement[] = [];
      parts.push(el("div", "q-head", `${q.header || "Pergunta"}${questions.length > 1 ? ` · ${i + 1}/${questions.length}` : ""}`));
      parts.push(el("div", "q-text", q.question));
      const next = () => (i + 1 < questions.length ? step(i + 1) : void send(true));
      const picked = new Set<string>();
      const opts = el("div", "q-opts");
      const confirm = el("button", "dv-btn go mini", "Confirmar");
      confirm.disabled = true;
      for (const o of q.options ?? []) {
        const b = el("button", "q-opt");
        b.append(el("b", undefined, o.label));
        if (o.description) b.append(el("small", undefined, o.description));
        b.onclick = () => {
          if (q.multiSelect) {
            if (picked.has(o.label)) picked.delete(o.label);
            else picked.add(o.label);
            b.classList.toggle("on", picked.has(o.label));
            confirm.disabled = picked.size === 0;
          } else {
            answers[q.question] = o.label;
            next();
          }
        };
        opts.append(b);
      }
      parts.push(opts);
      // resposta livre ("Outra"), como no Claude Code
      const other = el("input", "q-other");
      other.placeholder = "Outra resposta… (Enter)";
      other.onkeydown = (e) => {
        if (e.key !== "Enter" || !other.value.trim()) return;
        e.preventDefault();
        answers[q.question] = q.multiSelect ? [...picked, other.value.trim()] : other.value.trim();
        next();
      };
      parts.push(other);
      const row = el("div", "row");
      if (q.multiSelect) {
        confirm.onclick = () => {
          answers[q.question] = (q.options ?? []).map((o) => o.label).filter((l) => picked.has(l));
          next();
        };
        row.append(confirm);
      }
      const skip = el("button", "dv-btn mini", "Pular");
      skip.title = "Não responder: o Claude segue sem esta resposta";
      skip.onclick = () => void send(false);
      row.append(skip);
      parts.push(row);
      c.ask.replaceChildren(...parts);
      c.ask.classList.remove("hidden");
      follow();
    };
    step(0);
  }

  /** Depois de redesenhar: os pedidos que não estão mais `pending` já foram respondidos. */
  settle(pending: Set<string>) {
    for (const [id, c] of this.asks)
      if (!pending.has(id) && c.el.dataset.state === "ask") {
        c.el.dataset.state = "ok";
        c.ask.replaceChildren(el("div", "tc-why", "Respondido"));
      }
  }

  // ── Eventos ─────────────────────────────────────────────────────────────

  handle(ev: Ev) {
    // o que um subagente faz por dentro fica no cartão do Task/Agent
    if (ev.parent_tool_use_id) return;
    switch (ev.type) {
      case "stream_event":
        return this.onStream(ev.event ?? {});
      case "assistant":
        return this.onAssistant(ev.message ?? {});
      case "user":
        for (const b of ev.message?.content ?? []) if (b?.type === "tool_result") this.finish(b.tool_use_id, b.content, !!b.is_error);
        return;
      case "system":
        if (ev.subtype === "thinking_tokens" && this.thinking) {
          this.thinking.tokens = ev.estimated_tokens ?? this.thinking.tokens;
          this.paintThink(this.thinking);
        } else if (ev.subtype === "status" && ev.status === "requesting") {
          this.host.status("pensando…");
        } else if (ev.subtype === "permission_denied") {
          const c = ev.tool_use_id ? this.cards.get(ev.tool_use_id) : null;
          if (c) {
            c.el.dataset.state = "denied";
            c.ask.replaceChildren(el("div", "tc-why", ev.message ?? "Bloqueado pelo Claude Code."));
            c.ask.classList.remove("hidden");
          }
        }
        return;
      case "control_request":
        if (ev.request?.subtype === "can_use_tool") this.askPermission(ev.request_id, ev.request);
        return;
      case "control_cancel_request":
        for (const c of this.cards.values())
          if (c.el.dataset.state === "ask") {
            c.el.dataset.state = "denied";
            c.ask.replaceChildren(el("div", "tc-why", "Pedido cancelado."));
          }
        return;
      case "result":
        this.endThink();
        for (const c of this.cards.values()) if (c.el.dataset.state === "running" || c.el.dataset.state === "ask") c.el.dataset.state = "ok";
        return;
    }
  }

  private onStream(e: Ev) {
    switch (e.type) {
      case "message_start":
        this.msgId = e.message?.id ?? "";
        this.blocks.clear();
        return;
      case "content_block_start": {
        const b = e.content_block ?? {};
        if (b.type === "thinking" || b.type === "redacted_thinking") this.blocks.set(e.index, { kind: "think", think: this.startThink() });
        else if (b.type === "text") this.blocks.set(e.index, { kind: "text", el: null, text: "" });
        else if (b.type === "tool_use" || b.type === "server_tool_use") {
          this.endThink();
          this.card(b.id, b.name);
          this.blocks.set(e.index, { kind: "tool", id: b.id, json: "" });
        }
        return;
      }
      case "content_block_delta": {
        const blk = this.blocks.get(e.index);
        const d = e.delta ?? {};
        if (!blk) return;
        if (blk.kind === "text" && d.type === "text_delta") {
          this.endThink();
          blk.text += d.text;
          if (!blk.el) {
            blk.el = this.add(el("div", "msg assistant"));
            this.bubbles.set(this.msgId, [...(this.bubbles.get(this.msgId) ?? []), blk]);
          }
          blk.el.innerHTML = this.host.md(blk.text);
          follow();
          this.host.status("escrevendo…");
        } else if (blk.kind === "think" && d.type === "thinking_delta" && d.thinking) {
          blk.think.text.textContent += d.thinking;
        } else if (blk.kind === "tool" && d.type === "input_json_delta") {
          // o comando aparece enquanto o Claude o escreve
          blk.json += d.partial_json ?? "";
          const c = this.cards.get(blk.id);
          const input = parsePartial(blk.json);
          if (c && input) this.fill(c, input);
        }
        return;
      }
      case "content_block_stop": {
        const blk = this.blocks.get(e.index);
        if (blk?.kind === "think") this.endThink();
        return;
      }
    }
  }

  private onAssistant(m: Ev) {
    const mine = this.bubbles.get(m.id) ?? [];
    for (const b of m.content ?? []) {
      if (b.type === "tool_use" || b.type === "server_tool_use") this.fill(this.card(b.id, b.name), b.input);
      else if (b.type === "text" && b.text) {
        const full: string = b.text;
        // o mesmo texto (ou o começo dele) já está na tela: completa, não repete
        // primeiro nesta mensagem; depois em qualquer balão (a requisição refeita vem com outro id)
        const match = (x: { el: HTMLElement | null; text: string }) => !!x.el && !!x.text && (full.startsWith(x.text) || x.text.startsWith(full));
        const same = mine.find(match) ?? [...this.bubbles.values()].flat().reverse().find(match);
        if (same) {
          if (full.length > same.text.length) {
            same.text = full;
            same.el!.innerHTML = this.host.md(full);
          }
          continue;
        }
        this.endThink();
        const bubble = { el: this.add(el("div", "msg assistant")), text: full };
        bubble.el.innerHTML = this.host.md(full);
        mine.push(bubble);
        this.bubbles.set(m.id, mine);
      }
    }
  }
}

/** JSON incompleto (a entrada da ferramenta chegando aos pedaços). */
function parsePartial(json: string): Record<string, any> | null {
  for (const tail of ["", '"}', "}", '"]}', "]}"]) {
    try {
      const v = JSON.parse(json + tail);
      if (v && typeof v === "object") return v;
    } catch {
      /* tenta o próximo fecho */
    }
  }
  return null;
}
