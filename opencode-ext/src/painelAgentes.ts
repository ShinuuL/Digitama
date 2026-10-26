// Painel "Montar agentes": a webview (media/agentes.js) monta o fluxo com cartões
// arrastáveis; aqui geramos a prévia e só gravamos com o clique em "Gravar".
// Arquivo que não tem a nossa MARCA nunca é sobrescrito.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Fluxo, gerar, lerFluxo, MARCA, validar } from "./agentes";
import { Servico } from "./opencode";

type Destino = "projeto" | "global";

export class PainelAgentes {
  private static atual?: PainelAgentes;
  private painel: vscode.WebviewPanel;

  static abrir(ctx: vscode.ExtensionContext, svc: Servico, aoGravar: () => void) {
    if (PainelAgentes.atual) return PainelAgentes.atual.painel.reveal();
    PainelAgentes.atual = new PainelAgentes(ctx, svc, aoGravar);
  }

  private constructor(private ctx: vscode.ExtensionContext, private svc: Servico, private aoGravar: () => void) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
    this.painel = vscode.window.createWebviewPanel("digitamaOpencode.agentes", "Montar agentes", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.painel.iconPath = vscode.Uri.joinPath(media, "icone.svg");
    this.painel.webview.html = this.html(media);
    this.painel.onDidDispose(() => (PainelAgentes.atual = undefined));
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

  private dir(destino: Destino): string {
    if (destino === "global") return path.join(os.homedir(), ".config", "opencode", "agents");
    const p = this.pasta();
    if (!p) throw new Error("Abra uma pasta no VS Code para gravar agentes no projeto, ou escolha Global.");
    return path.join(p, ".opencode", "agents");
  }

  /** Fluxos já gravados por este painel, para reabrir e editar. */
  private salvos(): { destino: Destino; fluxo: Fluxo }[] {
    const r: { destino: Destino; fluxo: Fluxo }[] = [];
    for (const destino of ["projeto", "global"] as Destino[]) {
      let d: string;
      try {
        d = this.dir(destino);
      } catch {
        continue;
      }
      if (!fs.existsSync(d)) continue;
      for (const n of fs.readdirSync(d).filter((n) => n.endsWith(".md"))) {
        const f = lerFluxo(fs.readFileSync(path.join(d, n), "utf8"));
        if (f) r.push({ destino, fluxo: f });
      }
    }
    return r;
  }

  private previa(fluxo: Fluxo, destino: Destino) {
    const erros = validar(fluxo);
    const dir = this.dir(destino);
    const arquivos = gerar(fluxo).map((a) => {
      const caminho = path.join(dir, a.nome);
      const atual = fs.existsSync(caminho) ? fs.readFileSync(caminho, "utf8") : undefined;
      const estado = atual === undefined ? "novo" : !atual.includes(MARCA) ? "bloqueado" : atual === a.conteudo ? "igual" : "atualiza";
      return { ...a, caminho, estado };
    });
    for (const a of arquivos) if (a.estado === "bloqueado") erros.push(`${a.caminho} já existe e não foi criado aqui — troque o id.`);
    return { arquivos, erros };
  }

  private async mensagem(m: any) {
    switch (m.tipo) {
      case "pronto": {
        const [modelos, agentes] = await Promise.all([this.svc.modelos(this.pasta()), this.svc.agentes(this.pasta())]);
        return this.post({ tipo: "dados", modelos, agentes, salvos: this.salvos(), temPasta: !!this.pasta() });
      }
      case "previa":
        return this.post({ tipo: "previa", ...this.previa(m.fluxo, m.destino) });
      case "gravar": {
        const { arquivos, erros } = this.previa(m.fluxo, m.destino);
        if (erros.length) return this.post({ tipo: "previa", arquivos, erros });
        fs.mkdirSync(this.dir(m.destino), { recursive: true });
        for (const a of arquivos) if (a.estado !== "igual") fs.writeFileSync(a.caminho, a.conteudo, "utf8");
        const pasta = this.pasta();
        if (pasta) await this.svc.req("POST", "/api/location/reload", { directory: pasta }).catch(() => {});
        this.aoGravar();
        this.post({ tipo: "gravado", caminhos: arquivos.map((a) => a.caminho), orquestrador: m.fluxo.orquestrador.id });
        return;
      }
      case "abrirArquivo":
        return vscode.window.showTextDocument(vscode.Uri.file(m.caminho), { preview: true });
    }
  }

  private html(media: vscode.Uri) {
    const w = this.painel.webview;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, "agentes.css"));
    const icones = w.asWebviewUri(vscode.Uri.joinPath(media, "icones.js"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(media, "agentes.js"));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${icones}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
