// Verifica atualizações do OpenCode e desta extensão (releases do GitHub do
// Digitama), avisa com um botão e só instala com o clique. Várias janelas do
// VS Code abertas: a verificação automática roda em uma só por intervalo.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as at from "./atualizacoes";
import { Servico } from "./opencode";

export interface Situacao {
  extensao: { atual: string; nova?: string; pagina?: string; erro?: string };
  opencode: { atual?: string; nova?: string; erro?: string };
  verificadoEm: number;
  repo: string;
}

const INTERVALO_MS = 6 * 60 * 60 * 1000;

export class Atualizador {
  private ultima?: Situacao;
  private release?: at.ReleaseVsix;
  private relogio?: NodeJS.Timeout;
  aoMudar: (s: Situacao) => void = () => {};

  constructor(private ctx: vscode.ExtensionContext, private svc: Servico) {}

  private cfg() {
    return vscode.workspace.getConfiguration("digitamaOpencode.atualizacoes");
  }
  private repo() {
    const r = this.cfg().get<string>("repositorio", at.REPO_PADRAO).trim();
    return at.repoValido(r) ? r : at.REPO_PADRAO;
  }
  get situacao() {
    return this.ultima;
  }

  iniciar() {
    const rodar = () => {
      if (!this.cfg().get<boolean>("automatico", true)) return;
      // a última verificação vale para todas as janelas: só uma avisa por intervalo
      const ultima = this.ctx.globalState.get<number>("atualizacoes.ultima", 0);
      if (Date.now() - ultima < INTERVALO_MS) return;
      void this.ctx.globalState.update("atualizacoes.ultima", Date.now());
      void this.verificar(false);
    };
    setTimeout(rodar, 20_000);
    this.relogio = setInterval(rodar, 30 * 60 * 1000);
    return { dispose: () => clearInterval(this.relogio) };
  }

  async verificar(manual: boolean): Promise<Situacao> {
    const repo = this.repo();
    const atualExt = String(this.ctx.extension.packageJSON.version ?? "0.0.0");
    const s: Situacao = { extensao: { atual: atualExt }, opencode: {}, verificadoEm: Date.now(), repo };
    await Promise.all([
      at.ultimaExtensao(repo).then(
        (r) => {
          this.release = r;
          if (r && at.comparar(r.versao, atualExt) > 0) Object.assign(s.extensao, { nova: r.versao, pagina: r.pagina });
        },
        (e) => (s.extensao.erro = e instanceof Error ? e.message : String(e)),
      ),
      (async () => {
        const info = await this.svc.req<any>("GET", "/api/info").catch(() => undefined);
        s.opencode.atual = info?.version;
        const nova = await at.ultimoOpencode(s.opencode.atual).catch(() => undefined);
        if (nova && s.opencode.atual && at.comparar(nova, s.opencode.atual) > 0) s.opencode.nova = nova;
        if (!nova) s.opencode.erro = "não consegui consultar o npm";
      })(),
    ]);
    this.ultima = s;
    this.aoMudar(s);
    if (!manual) this.avisar(s);
    else if (!s.extensao.nova && !s.opencode.nova) void vscode.window.showInformationMessage(`Tudo atualizado: extensão ${atualExt}${s.opencode.atual ? `, OpenCode ${s.opencode.atual}` : ""}.`);
    else this.avisar(s);
    return s;
  }

  private avisar(s: Situacao) {
    if (s.extensao.nova) {
      void vscode.window
        .showInformationMessage(`Digitama OpenCode ${s.extensao.nova} disponível (você tem ${s.extensao.atual}).`, "Atualizar", "Ver novidades")
        .then((b) => {
          if (b === "Atualizar") this.atualizarExtensao().catch((e) => vscode.window.showErrorMessage(String(e?.message ?? e)));
          else if (b === "Ver novidades" && s.extensao.pagina) void vscode.env.openExternal(vscode.Uri.parse(s.extensao.pagina));
        });
    }
    if (s.opencode.nova) {
      void vscode.window
        .showInformationMessage(`OpenCode ${s.opencode.nova} disponível (você tem ${s.opencode.atual}).`, "Atualizar OpenCode")
        .then((b) => b && this.atualizarOpencode());
    }
  }

  async atualizarExtensao() {
    const r = this.release ?? (await at.ultimaExtensao(this.repo()));
    if (!r) throw new Error("Nenhum release com o .vsix da extensão.");
    const dir = this.ctx.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, `digitama-opencode-${r.versao}.vsix`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Baixando Digitama OpenCode ${r.versao}…` }, async () => {
      await at.baixar(r.url, destino);
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(destino));
    });
    const b = await vscode.window.showInformationMessage(`Digitama OpenCode ${r.versao} instalada. Recarregue a janela para usar.`, "Recarregar agora");
    if (b) await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }

  /** `opencode upgrade` no terminal do VS Code, à vista (pode pedir confirmação). */
  atualizarOpencode() {
    const t = vscode.window.createTerminal({ name: "OpenCode · atualizar" });
    t.show();
    t.sendText("opencode upgrade");
    void vscode.window.showInformationMessage("Depois que o upgrade terminar, use /recarregar no chat (ou OpenCode: Reconectar ao serviço).");
  }
}
