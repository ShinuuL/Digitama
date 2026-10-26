// Painel "Configurações": tema da conversa, conexões rápidas (GitHub, Cloudflare,
// Docker… e as que o usuário adicionar), MCPs do OpenCode e provedores.
// Login sempre no terminal do VS Code; nada de senha ou token passa por aqui.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { checar, Conexao, idDe, PADRAO } from "./conexoes";
import { naPasta, Servico } from "./opencode";

export interface Tema {
  acento: string;
  densidade: "confortavel" | "compacta";
  animacoes: boolean;
}

export const TEMA_PADRAO: Tema = { acento: "#3fe0ff", densidade: "confortavel", animacoes: true };

export class PainelConfig {
  private static atual?: PainelConfig;
  private painel: vscode.WebviewPanel;

  static abrir(ctx: vscode.ExtensionContext, svc: Servico, aoMudarTema: (t: Tema) => void, aba?: string) {
    if (PainelConfig.atual) {
      PainelConfig.atual.painel.reveal();
      if (aba) PainelConfig.atual.post({ tipo: "aba", aba });
      return;
    }
    PainelConfig.atual = new PainelConfig(ctx, svc, aoMudarTema, aba);
  }

  private constructor(private ctx: vscode.ExtensionContext, private svc: Servico, private aoMudarTema: (t: Tema) => void, private aba?: string) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
    this.painel = vscode.window.createWebviewPanel("digitamaOpencode.config", "Configurações do OpenCode", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.painel.iconPath = vscode.Uri.joinPath(media, "icone.svg");
    this.painel.webview.html = this.html(media);
    this.painel.onDidDispose(() => (PainelConfig.atual = undefined));
    this.painel.webview.onDidReceiveMessage((m) =>
      this.mensagem(m).catch((e) => this.post({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) })),
    );
  }

  private post(m: unknown) {
    void this.painel.webview.postMessage(m);
  }

  private pasta() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private tema(): Tema {
    return { ...TEMA_PADRAO, ...this.ctx.globalState.get<Partial<Tema>>("tema", {}) };
  }

  private personalizadas(): Conexao[] {
    return this.ctx.globalState.get<Conexao[]>("conexoes", []);
  }

  private todas(): Conexao[] {
    return [...PADRAO, ...this.personalizadas()];
  }

  /** Roda um comando no terminal do VS Code, à vista do usuário (logins interativos). */
  private terminal(nome: string, cmd: string) {
    const t = vscode.window.createTerminal({ name: `OpenCode · ${nome}` });
    t.show();
    t.sendText(cmd);
  }

  /** O relay do Digitama, se o app estiver instalado (para registrar o MCP do pet). */
  private relayDigitama(): string | undefined {
    const base = process.env.LOCALAPPDATA;
    if (!base) return undefined;
    const p = path.join(base, "br.com.mastersys.digitama", "bin", "digitama-hook.exe");
    return fs.existsSync(p) ? p : undefined;
  }

  private async mcps() {
    const j = await this.svc.req<{ data: any[] }>("GET", "/api/mcp" + naPasta(this.pasta())).catch(() => ({ data: [] }));
    return (j.data ?? []).map((m) => ({ name: m.name, status: m.status?.status ?? "?", erro: m.status?.error }));
  }

  private async provedores() {
    const j = await this.svc.req<{ data: any[] }>("GET", "/api/integration").catch(() => ({ data: [] }));
    return (j.data ?? []).filter((i) => (i.connections ?? []).length).map((i) => ({ id: i.id, name: i.name, conexoes: i.connections.length }));
  }

  private async mensagem(m: any): Promise<unknown> {
    switch (m.tipo) {
      case "pronto":
        this.post({ tipo: "dados", tema: this.tema(), conexoes: this.todas(), relay: !!this.relayDigitama(), aba: this.aba });
        void this.checarTodas();
        return this.post({ tipo: "mcps", lista: await this.mcps(), provedores: await this.provedores() });
      case "tema": {
        const t = { ...this.tema(), ...m.tema };
        await this.ctx.globalState.update("tema", t);
        this.aoMudarTema(t);
        return this.post({ tipo: "tema", tema: t });
      }
      case "checar":
        return this.checarUma(m.id);
      case "login": {
        const c = this.todas().find((x) => x.id === m.id);
        const cmd = m.acao === "logout" ? c?.logout : m.acao === "instalar" ? c?.instalar : c?.login;
        if (c && cmd) this.terminal(c.nome, cmd);
        return;
      }
      case "addConexao": {
        const nome = String(m.nome ?? "").trim();
        const status = String(m.status ?? "").trim();
        if (!nome || !status) return this.post({ tipo: "erro", texto: "Informe o nome e o comando de status." });
        const lista = this.personalizadas();
        const c: Conexao = { id: idDe(nome, this.todas().map((x) => x.id)), nome, icone: "tool", descricao: String(m.descricao ?? "").trim() || "Conexão adicionada por você.", status, login: String(m.login ?? "").trim() || undefined, personalizada: true };
        await this.ctx.globalState.update("conexoes", [...lista, c]);
        this.post({ tipo: "conexoes", conexoes: this.todas() });
        return this.checarUma(c.id);
      }
      case "removerConexao":
        await this.ctx.globalState.update("conexoes", this.personalizadas().filter((c) => c.id !== m.id));
        return this.post({ tipo: "conexoes", conexoes: this.todas() });
      case "mcpAlternar":
        await this.svc.req("POST", `/api/experimental/mcp/${encodeURIComponent(m.nome)}/${m.ligar ? "connect" : "disconnect"}` + naPasta(this.pasta()), {});
        return this.post({ tipo: "mcps", lista: await this.mcps(), provedores: await this.provedores() });
      case "mcpRemover":
        await this.removerDoConfig(String(m.nome));
        // tira também do serviço em execução (se estava só lá, some na hora)
        await this.svc.req("DELETE", `/api/experimental/mcp/${encodeURIComponent(m.nome)}` + naPasta(this.pasta())).catch(() => {});
        return this.post({ tipo: "mcps", lista: await this.mcps(), provedores: await this.provedores() });
      case "mcpAdicionar": {
        const nome = String(m.nome ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(nome)) return this.post({ tipo: "erro", texto: "Nome do MCP: letras, números, - e _." });
        // `opencode mcp add --global` grava em ~/.config/opencode (a API experimental só vale até o serviço reiniciar)
        let args: string[];
        if (m.digitama) {
          const relay = this.relayDigitama();
          if (!relay) return this.post({ tipo: "erro", texto: "O app Digitama não está instalado nesta máquina." });
          args = ["mcp", "add", "--global", nome, "--", relay, "--mcp"];
        } else if (m.modo === "remote") {
          if (!/^https?:\/\/\S+$/.test(m.url ?? "")) return this.post({ tipo: "erro", texto: "Informe a URL do servidor (http/https)." });
          args = ["mcp", "add", "--global", nome, "--url", m.url];
        } else {
          const partes = String(m.comando ?? "").match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
          if (!partes.length) return this.post({ tipo: "erro", texto: "Informe o comando do servidor." });
          args = ["mcp", "add", "--global", nome, "--", ...partes];
        }
        await this.svc.cli(args);
        await this.svc.req("POST", "/api/location/reload" + naPasta(this.pasta()), {}).catch(() => {});
        return this.post({ tipo: "mcps", lista: await this.mcps(), provedores: await this.provedores(), adicionado: nome });
      }
      case "atualizacoes": {
        this.post({ tipo: "atualizacoes", carregando: true });
        const s = await vscode.commands.executeCommand(m.forcar ? "digitamaOpencode.verificarAtualizacoes" : "digitamaOpencode.situacaoAtualizacoes");
        const c = vscode.workspace.getConfiguration("digitamaOpencode.atualizacoes");
        return this.post({ tipo: "atualizacoes", situacao: s, automatico: c.get("automatico", true), repo: c.get("repositorio", "ShinuuL/Digitama") });
      }
      case "atualizarExtensao":
        return vscode.commands.executeCommand("digitamaOpencode.atualizarExtensao");
      case "atualizarOpencode":
        return vscode.commands.executeCommand("digitamaOpencode.atualizarOpencode");
      case "autoAtualizar":
        await vscode.workspace.getConfiguration("digitamaOpencode.atualizacoes").update("automatico", !!m.valor, vscode.ConfigurationTarget.Global);
        return this.mensagem({ tipo: "atualizacoes" });
      case "abrirUrl":
        // só páginas do GitHub (as notas do release)
        if (/^https:\/\/github\.com\//.test(String(m.url))) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case "provedorLogin":
        return this.terminal("provedores", "opencode auth login");
      case "atualizarMcps":
        return this.post({ tipo: "mcps", lista: await this.mcps(), provedores: await this.provedores() });
    }
  }

  /**
   * A CLI não tem `mcp remove`: tira a entrada do opencode.json global com backup
   * datado. Se o arquivo tem comentários (jsonc) e não dá para ler com segurança,
   * abre no editor para o usuário apagar à mão.
   */
  private async removerDoConfig(nome: string) {
    const dir = path.join(os.homedir(), ".config", "opencode");
    const arq = ["opencode.json", "opencode.jsonc"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    if (!arq) return;
    const texto = fs.readFileSync(arq, "utf8");
    let j: any;
    try {
      j = JSON.parse(texto);
    } catch {
      await vscode.window.showTextDocument(vscode.Uri.file(arq));
      throw new Error(`${path.basename(arq)} tem comentários: abri o arquivo para você apagar "${nome}" em mcp.servers.`);
    }
    const servidores = j?.mcp?.servers ?? j?.mcp;
    if (!servidores || !(nome in servidores)) return;
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    fs.copyFileSync(arq, `${arq}.bak-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
    delete servidores[nome];
    fs.writeFileSync(arq, JSON.stringify(j, null, 2) + "\n", "utf8");
    await this.svc.req("POST", "/api/location/reload" + naPasta(this.pasta()), {}).catch(() => {});
  }

  private async checarUma(id: string) {
    const c = this.todas().find((x) => x.id === id);
    if (!c) return;
    this.post({ tipo: "estado", id, carregando: true });
    const e = await checar(c);
    this.post({ tipo: "estado", id, ...e });
  }

  private async checarTodas() {
    await Promise.all(this.todas().map((c) => this.checarUma(c.id)));
  }

  private html(media: vscode.Uri) {
    const w = this.painel.webview;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${u("config.css")}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${u("icones.js")}"></script><script nonce="${nonce}" src="${u("config.js")}"></script></body></html>`;
  }
}
