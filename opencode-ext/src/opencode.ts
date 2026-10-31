// Cliente do serviço em segundo plano do OpenCode v2 (opencode service).
// Nunca lê a senha do ~/.config/opencode/service.json: a extensão pareia como
// qualquer dispositivo (`opencode api server.pair` → código de uso único →
// /auth/connect → token) e guarda o token só na memória.
import { exec, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface Modelo {
  id: string;
  providerID: string;
  name: string;
  gratis: boolean;
  contexto: number;
  saida: number;
  /** O que o modelo lê além de texto: image, audio, video, pdf… */
  entrada: string[];
  ferramentas: boolean;
  /** Níveis de raciocínio (variantes), se houver. */
  variantes: string[];
}

export type Regra = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
export type Modo = "perguntar" | "edicoes" | "auto";

/** Leituras e buscas nunca perguntam; o resto depende do modo. A última regra que casa vale. */
const LEITURA = ["read", "glob", "grep", "question", "skill", "subagent"];

export function regrasDoModo(modo: Modo): Regra[] {
  if (modo === "auto") {
    return [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ];
  }
  const r: Regra[] = [{ action: "*", resource: "*", effect: "ask" }, ...LEITURA.map((a) => ({ action: a, resource: "*", effect: "allow" as const }))];
  if (modo === "edicoes") r.push({ action: "edit", resource: "*", effect: "allow" });
  // fora da pasta do projeto sempre pergunta (vem depois, então vence o "allow" acima)
  r.push({ action: "external_directory", resource: "*", effect: "ask" });
  return r;
}

export interface Agente {
  id: string;
  name: string;
  mode: string;
  description?: string;
  color?: string;
  model?: { id: string; providerID: string };
}

/** Procura o opencode: configuração, PATH e a pasta global do npm. */
export function acharOpencode(custom: string): string | undefined {
  if (custom && fs.existsSync(custom)) return custom;
  const nomes = process.platform === "win32" ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  for (const d of dirs) for (const n of nomes) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Um argumento para a linha do cmd.exe (o .cmd do npm precisa do shell): com
 * espaço vai entre aspas; caracteres que o cmd interpreta são recusados, para
 * que texto digitado (ex.: o comando de um MCP) nunca vire outro comando.
 */
export function argCmd(a: string): string {
  if (/["%^&|<>!\r\n]/.test(a)) throw new Error(`Caractere não permitido em "${a}" (" % ^ & | < > !).`);
  return /\s/.test(a) || a === "" ? `"${a}"` : a;
}

/** Roda o opencode com argumentos separados (nunca uma linha montada com texto solto). */
export function rodar(exe: string, args: string[]): Promise<string> {
  const fim = (resolve: (s: string) => void, reject: (e: Error) => void) => (err: Error | null, out: string, errOut: string) => {
    if (err) reject(new Error((errOut || out || err.message).trim()));
    else resolve(out.trim());
  };
  const op = { windowsHide: true, timeout: 20_000 };
  return new Promise((resolve, reject) => {
    if (exe.toLowerCase().endsWith(".cmd")) {
      let linha: string;
      try {
        linha = `"${exe}" ${args.map(argCmd).join(" ")}`;
      } catch (e) {
        return reject(e as Error);
      }
      exec(linha, op, fim(resolve, reject));
    } else execFile(exe, args, op, fim(resolve, reject));
  });
}

/** `opencode service status` imprime o endereço do serviço. */
export function urlDoStatus(saida: string): string | undefined {
  return saida.match(/https?:\/\/[\w.\-]+:\d+/)?.[0];
}

/** Trava de quem está subindo o serviço: depois deste tempo é considerada abandonada. */
export const TRAVA_MS = 30_000;

/** A trava existe e ainda vale (outra janela está subindo o serviço agora)? */
export function travaValida(criadaEm: number | undefined, agora: number): boolean {
  // o mtime pode sair alguns ms à frente do relógio (Windows): só data muito no futuro é inválida
  return criadaEm !== undefined && Math.abs(agora - criadaEm) < TRAVA_MS;
}

/**
 * Pega a trava (arquivo criado com "wx", atômico): só uma janela roda o
 * `service start`. Trava abandonada (janela fechada no meio) é removida.
 */
export function pegarTrava(arquivo: string, agora = Date.now()): boolean {
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    let criada: number | undefined;
    try {
      criada = fs.statSync(arquivo).mtimeMs;
    } catch {
      return pegarTrava(arquivo, agora); // sumiu entre as duas chamadas
    }
    if (travaValida(criada, agora)) return false;
    try {
      fs.rmSync(arquivo, { force: true });
      fs.writeFileSync(arquivo, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false; // outra janela pegou primeiro
    }
  }
}

/**
 * `opencode service start` desanexado: o servidor fica rodando depois e não
 * pode prender a extensão (nem morrer junto com a janela que o subiu).
 */
function iniciarServico(exe: string) {
  const cmd = exe.toLowerCase().endsWith(".cmd");
  const p = spawn(cmd ? `"${exe}"` : exe, ["service", "start"], { detached: true, stdio: "ignore", windowsHide: true, shell: cmd });
  p.on("error", () => {}); // a falha aparece como "não subiu" na espera pelo status
  p.unref();
}

/** Ocupação do contexto: o que foi para o modelo no último passo, mais a resposta. */
export function contextoUsado(t: Tokens | undefined): number {
  if (!t) return 0;
  return (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) + (t.output || 0);
}

/** Separa um fluxo SSE em blocos completos; devolve os blocos e o resto. */
export function cortarSse(buf: string): { blocos: string[]; resto: string } {
  const partes = buf.replace(/\r\n/g, "\n").split("\n\n");
  const resto = partes.pop() ?? "";
  return { blocos: partes.filter((b) => b.trim()), resto };
}

/** Extrai o JSON das linhas `data:` de um bloco SSE (heartbeats viram undefined). */
export function dadosSse(bloco: string): any {
  const linhas = bloco.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
  if (!linhas.length) return undefined;
  try {
    return JSON.parse(linhas.join("\n"));
  } catch {
    return undefined;
  }
}

/** Query que escolhe a pasta (Location) de uma consulta: ?location[directory]=… */
export const naPasta = (dir?: string) => (dir ? "?" + new URLSearchParams({ "location[directory]": dir }) : "");

export class Servico {
  base = "";
  private auth = "";

  /** Avisado quando esta janela vai subir o serviço (ou esperar outra subir). */
  aoSubir: (quem: "eu" | "outra") => void = () => {};

  /** `trava`: arquivo compartilhado entre as janelas para só uma subir o serviço. */
  constructor(private exe: () => string | undefined, private trava?: string) {}

  private opencode(): string {
    const e = this.exe();
    if (!e) throw new Error("OpenCode não encontrado. Instale (npm i -g opencode-ai) ou ajuste digitamaOpencode.executavel.");
    return e;
  }

  /** Roda a CLI do opencode (ex.: `mcp add --global`, que grava na configuração). */
  cli(args: string[]): Promise<string> {
    return rodar(this.opencode(), args);
  }

  /** Cria um código de pareamento de uso único (vale 5 minutos). */
  async codigo(): Promise<{ code: string; expires_in: number }> {
    const j = JSON.parse(await rodar(this.opencode(), ["api", "server.pair"]));
    if (!j?.code) throw new Error("O serviço não devolveu código de pareamento.");
    return j;
  }

  async conectar(): Promise<void> {
    const url = await this.garantir();
    this.base = url;
    const { code } = await this.codigo();
    const r = await fetch(`${url}/auth/connect/${encodeURIComponent(code)}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Pareamento recusado (${r.status}).`);
    const { token } = (await r.json()) as { token: string };
    this.auth = "Basic " + Buffer.from("opencode:" + token).toString("base64");
  }

  /** Endereço do serviço; se estiver parado, sobe (ou espera outra janela subir). */
  async garantir(): Promise<string> {
    const exe = this.opencode();
    return (await this.endereco(exe)) ?? (await this.subir(exe));
  }

  private async endereco(exe: string): Promise<string | undefined> {
    return urlDoStatus(await rodar(exe, ["service", "status"]).catch(() => ""));
  }

  /**
   * Serviço parado: a primeira janela pega a trava e roda o `service start`;
   * as outras só esperam o status mostrar o endereço. Nunca sobe dois.
   */
  private async subir(exe: string): Promise<string> {
    const minha = !this.trava || pegarTrava(this.trava);
    this.aoSubir(minha ? "eu" : "outra");
    try {
      if (minha) iniciarServico(exe);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const url = await this.endereco(exe);
        if (url) return url;
      }
      throw new Error("O serviço do OpenCode não subiu em 20 s. Rode `opencode service start` no terminal para ver o erro.");
    } finally {
      if (minha && this.trava) fs.rmSync(this.trava, { force: true });
    }
  }

  get conectado() {
    return !!this.auth;
  }

  /** Requisição autenticada; num 401 pareia de novo uma vez. */
  async req<T = any>(metodo: string, caminho: string, corpo?: unknown, refeito = false): Promise<T> {
    if (!this.auth) await this.conectar();
    const r = await fetch(this.base + caminho, {
      method: metodo,
      headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (r.status === 401 && !refeito) {
      this.auth = "";
      return this.req(metodo, caminho, corpo, true);
    }
    const texto = await r.text();
    if (!r.ok) {
      let msg = texto;
      try {
        const j = JSON.parse(texto);
        msg = j?.message ?? j?.error?.message ?? j?.data?.message ?? texto;
      } catch {}
      throw new Error(`${metodo} ${caminho.split("?")[0]}: ${r.status} ${String(msg).slice(0, 300)}`);
    }
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  /** Assina /api/event; reconecta sozinho até `sinal` abortar. */
  async eventos(sinal: AbortSignal, aoEvento: (e: any) => void, aoEstado: (ok: boolean) => void) {
    while (!sinal.aborted) {
      try {
        if (!this.auth) await this.conectar();
        const r = await fetch(this.base + "/api/event", { headers: { authorization: this.auth }, signal: sinal });
        if (r.status === 401) {
          this.auth = "";
          continue;
        }
        if (!r.ok || !r.body) throw new Error(String(r.status));
        aoEstado(true);
        const leitor = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await leitor.read();
          if (done) break;
          const { blocos, resto } = cortarSse(buf + dec.decode(value, { stream: true }));
          buf = resto;
          for (const b of blocos) {
            const d = dadosSse(b);
            if (d?.type) aoEvento(d);
          }
        }
      } catch {
        if (sinal.aborted) return;
      }
      aoEstado(false);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async modelos(dir?: string): Promise<Modelo[]> {
    const j = await this.req<{ data: any[] }>("GET", "/api/model" + naPasta(dir));
    return (j.data ?? [])
      .filter((m) => m.enabled !== false && m.status !== "deprecated")
      .map((m) => ({
        id: m.id,
        providerID: m.providerID,
        name: m.name ?? m.id,
        gratis: (m.cost ?? []).every((c: any) => !c.input && !c.output),
        contexto: m.limit?.context ?? 0,
        saida: m.limit?.output ?? 0,
        entrada: (m.capabilities?.input ?? ["text"]).filter((x: string) => x !== "text"),
        ferramentas: m.capabilities?.tools !== false,
        variantes: (m.variants ?? []).map((v: any) => v.id).filter((v: string) => v !== "default"),
      }));
  }

  /** Nome de cada provedor (opencode → "OpenCode Zen"…), para agrupar os modelos. */
  async provedores(dir?: string): Promise<Record<string, string>> {
    const j = await this.req<{ data: any[] }>("GET", "/api/provider" + naPasta(dir));
    return Object.fromEntries((j.data ?? []).map((p) => [p.id, p.name ?? p.id]));
  }

  async agentes(dir?: string): Promise<Agente[]> {
    const j = await this.req<{ data: any[] }>("GET", "/api/agent" + naPasta(dir));
    const internos = new Set(["compaction", "title", "summary"]);
    return (j.data ?? []).filter((a) => !internos.has(a.id) && !a.hidden).map((a) => ({ id: a.id, name: a.name ?? a.id, mode: a.mode, description: a.description, color: a.color, model: a.model }));
  }
}
