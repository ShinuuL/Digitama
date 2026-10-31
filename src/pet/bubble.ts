// O balão de fala do pet: falas soltas, e os pedidos dos agentes (Claude Code,
// OpenCode) — perguntas, permissões de ferramenta e "estou esperando".
// Clicar no texto leva à janela do agente; os botões respondem direto.
import { withIcon } from "../shared/svg";
import { api } from "../shared/api";

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type BubbleReq =
  | { kind: "say"; text: string; ttl?: number }
  | { kind: "card"; node: HTMLElement; ttl?: number }
  | { kind: "question"; requestId: string; questions: Question[]; cwd?: string; agent?: string }
  | { kind: "permission"; requestId: string; tool: string; summary: string; cwd?: string; agent?: string; extId?: string }
  | { kind: "waiting"; text: string; cwd?: string; agent?: string };

/** Nome de cada agente no balão. */
export const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", opencode: "OpenCode" };
const agentName = (id?: string) => AGENT_NAMES[id ?? "claude"] ?? id ?? "Claude Code";

type Interactive = Exclude<BubbleReq, { kind: "say" } | { kind: "card" }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class Bubble {
  readonly root = el("div", "bubble hidden");
  private queue: Interactive[] = [];
  private current: Interactive | null = null;
  private sayTimer = 0;
  /** Chamado quando uma pergunta é respondida pelo balão. */
  onAnswered: (kind: "question" | "permission", detail: string) => void = () => {};
  onChange: () => void = () => {};

  constructor(host: HTMLElement) {
    host.appendChild(this.root);
  }

  get busy() {
    return this.current !== null;
  }

  get visible() {
    return !this.root.classList.contains("hidden");
  }

  show(req: BubbleReq) {
    if (req.kind === "say" || req.kind === "card") {
      if (this.current) return; // um pedido do Claude tem prioridade
      const node = req.kind === "say" ? el("div", "say", req.text) : req.node;
      this.render([node]);
      if (req.kind === "card") node.onclick = () => this.hide();
      window.clearTimeout(this.sayTimer);
      const ttl = req.ttl ?? (req.kind === "say" ? Math.max(2.5, req.text.length / 14) : 10);
      this.sayTimer = window.setTimeout(() => this.hide(), ttl * 1000);
      return;
    }
    if (this.current) {
      this.queue.push(req);
      return;
    }
    this.current = req;
    window.clearTimeout(this.sayTimer);
    this.renderCurrent();
  }

  /** Um pedido já respondido em outro lugar sai da fila (ou do balão). */
  drop(requestId: string) {
    this.queue = this.queue.filter((r) => !("requestId" in r) || r.requestId !== requestId);
    if (this.current && "requestId" in this.current && this.current.requestId === requestId) this.next();
  }

  /** Uma permissão respondida no próprio agente (ex.: no terminal do OpenCode). */
  dropExternal(extId: string) {
    if (!extId) return;
    const match = (r: Interactive) => r.kind === "permission" && r.extId === extId;
    for (const r of this.queue.filter(match)) if ("requestId" in r) void api.hookDecline(r.requestId);
    this.queue = this.queue.filter((r) => !match(r));
    if (this.current && match(this.current)) {
      if ("requestId" in this.current) void api.hookDecline(this.current.requestId);
      this.next();
    }
  }

  /** "Claude terminou": o aviso de espera não faz mais sentido. */
  clearWaiting() {
    this.queue = this.queue.filter((r) => r.kind !== "waiting");
    if (this.current?.kind === "waiting") this.next();
  }

  hide() {
    this.root.classList.add("hidden");
    this.root.replaceChildren();
    this.onChange();
  }

  private next() {
    this.current = this.queue.shift() ?? null;
    if (this.current) this.renderCurrent();
    else this.hide();
  }

  private render(children: HTMLElement[]) {
    this.root.replaceChildren(...children);
    this.root.classList.remove("hidden");
    this.onChange();
  }

  private toChat(cwd?: string) {
    void api.focusClaude(cwd);
  }

  private renderCurrent() {
    const req = this.current!;
    const name = agentName(req.agent);
    const goChat = el("button", "ghost");
    withIcon(goChat, "chat", `Responder no ${name}`, 12);
    goChat.onclick = () => {
      if ("requestId" in req) void api.hookDecline(req.requestId);
      this.toChat(req.cwd);
      this.next();
    };

    if (req.kind === "waiting") {
      const text = el("div", "say link", req.text);
      text.onclick = () => this.toChat(req.cwd);
      const open = el("button", "primary", `Abrir o ${name}`);
      open.onclick = () => {
        this.toChat(req.cwd);
        this.next();
      };
      const close = el("button", "ghost", "Depois");
      close.onclick = () => this.next();
      this.render([el("div", "tag", `${name} está esperando você`), text, row(open, close)]);
      return;
    }

    if (req.kind === "permission") {
      const title = el("div", "tag", `${name} · ${req.tool}`);
      const body = el("pre", "code link", req.summary);
      body.title = `Clique para ver no ${name}`;
      body.onclick = () => this.toChat(req.cwd);
      const allow = el("button", "primary", "Permitir");
      const deny = el("button", "danger", "Negar");
      allow.onclick = () => {
        void api.hookAnswer(req.requestId, "allow");
        this.onAnswered("permission", "allow");
        this.next();
      };
      deny.onclick = () => {
        void api.hookAnswer(req.requestId, "deny");
        this.onAnswered("permission", "deny");
        this.next();
      };
      this.render([title, body, row(allow, deny), row(goChat)]);
      return;
    }

    // AskUserQuestion: uma pergunta por vez, as respostas vão juntas no fim.
    const answers: Record<string, string | string[]> = {};
    const step = (i: number) => {
      const q = req.questions[i];
      const parts: HTMLElement[] = [];
      const head = el("div", "tag", `${q.header || "Pergunta"}${req.questions.length > 1 ? ` · ${i + 1}/${req.questions.length}` : ""}`);
      const text = el("div", "say link", q.question);
      text.title = `Clique para ver no ${name}`;
      text.onclick = () => this.toChat(req.cwd);
      parts.push(head, text);
      const opts = el("div", "options");
      const picked = new Set<string>();
      const finish = () => {
        if (i + 1 < req.questions.length) step(i + 1);
        else {
          void api.hookAnswerQuestion(req.requestId, answers);
          this.onAnswered("question", JSON.stringify(answers));
          this.next();
        }
      };
      for (const o of q.options) {
        const b = el("button", "option");
        b.append(el("span", "label", o.label));
        if (o.description) b.append(el("span", "desc", o.description));
        b.onclick = () => {
          if (q.multiSelect) {
            if (picked.has(o.label)) picked.delete(o.label);
            else picked.add(o.label);
            b.classList.toggle("on", picked.has(o.label));
            confirm.disabled = picked.size === 0;
          } else {
            answers[q.question] = o.label;
            finish();
          }
        };
        opts.append(b);
      }
      parts.push(opts);
      const confirm = el("button", "primary", "Confirmar");
      confirm.disabled = true;
      confirm.onclick = () => {
        answers[q.question] = q.options.map((o) => o.label).filter((l) => picked.has(l));
        finish();
      };
      parts.push(q.multiSelect ? row(confirm, goChat) : row(goChat));
      this.render(parts);
    };
    step(0);
  }
}

function row(...items: HTMLElement[]) {
  const r = el("div", "row");
  r.append(...items);
  return r;
}
