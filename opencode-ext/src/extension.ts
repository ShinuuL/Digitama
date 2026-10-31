// Host da extensão: fala com o serviço do OpenCode (opencode.ts) e repassa à
// webview (media/main.js), que só desenha. A conversa trabalha na pasta aberta
// no VS Code: a extensão nunca escolhe pasta sozinha.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { acharOpencode, contextoUsado, Modelo, Modo, Agente, naPasta, regrasDoModo, Servico, Tokens } from "./opencode";
import { PainelAgentes } from "./painelAgentes";
import { PainelConfig, Tema, TEMA_PADRAO } from "./painelConfig";
import { COMANDOS, Comando, lerComando, lerShell, skillsCitadas } from "./comandos";
import * as uso from "./uso";
import { Anexo, classificar, comCaminhos } from "./anexos";
import { Atualizador } from "./atualizador";
import { buscar, mencoesDeAgentes } from "./mencoes";
import { chamadaEmTexto, DetectorRepeticao, JANELA_CICLO, MotivoRepeticao, REPETICOES_ATE_PARAR, VEZES_NO_CICLO } from "./repeticao";

/** Mensagem do botão "Executar de verdade" quando o modelo só escreveu a chamada. */
const PEDIDO_EXECUTAR =
  "Você escreveu a chamada de ferramenta como texto na resposta, então nada foi executado. Use as ferramentas de verdade agora (sem reescrever o conteúdo no chat) e confirme o que foi feito.";

interface Sessao {
  id: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string };
  tokens?: Tokens;
  time?: { created: number; updated: number };
}

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration("digitamaOpencode");
  const svc = new Servico(() => acharOpencode(cfg().get<string>("executavel", "")), path.join(ctx.globalStorageUri.fsPath, "subindo.lock"));
  const prov = new Painel(ctx, svc);
  // ao abrir a janela o serviço já fica de pé; se outra janela estiver subindo, só espera
  svc.aoSubir = (quem) => prov.avisarSubida(quem);
  void svc.garantir().catch(() => {}); // o painel mostra o erro quando abrir
  // colados (Ctrl+V de arquivos/prints) ficam numa pasta da extensão: apaga os de mais de 1 dia
  try {
    const dir = path.join(ctx.globalStorageUri.fsPath, "anexos");
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const p = path.join(dir, n);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(p, { force: true });
    }
  } catch {}
  const atualizador = new Atualizador(ctx, svc);
  const falhou = (e: unknown) => vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  status.command = "digitamaOpencode.abrir";
  prov.aoContexto = (usado, limite, nome) => {
    const pct = limite ? Math.min(100, Math.round((usado / limite) * 100)) : 0;
    const bolas = ["○", "◔", "◑", "◕", "●"];
    status.text = `${bolas[Math.min(4, Math.floor(pct / 25))]} ${pct}%`;
    status.tooltip = `Contexto do OpenCode: ${usado.toLocaleString("pt-BR")} de ${limite.toLocaleString("pt-BR")} tokens${nome ? ` · ${nome}` : ""}`;
    status.backgroundColor = pct >= 85 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
  };

  ctx.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider("digitamaOpencode.chat", prov, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("digitamaOpencode.abrir", () => vscode.commands.executeCommand("digitamaOpencode.chat.focus")),
    vscode.commands.registerCommand("digitamaOpencode.nova", () => prov.nova()),
    vscode.commands.registerCommand("digitamaOpencode.pair", () => prov.parear()),
    vscode.commands.registerCommand("digitamaOpencode.reconectar", () => prov.iniciar(true)),
    vscode.commands.registerCommand("digitamaOpencode.recarregar", () => prov.comando("/recarregar")),
    vscode.commands.registerCommand("digitamaOpencode.config", (aba?: string) => PainelConfig.abrir(ctx, svc, () => prov.temaMudou(), typeof aba === "string" ? aba : undefined)),
    vscode.commands.registerCommand("digitamaOpencode.agentes", () => PainelAgentes.abrir(ctx, svc, () => void prov.recarregarAgentes())),
    vscode.commands.registerCommand("digitamaOpencode.verificarAtualizacoes", () => atualizador.verificar(true).catch(falhou)),
    vscode.commands.registerCommand("digitamaOpencode.situacaoAtualizacoes", () => atualizador.situacao ?? atualizador.verificar(true)),
    vscode.commands.registerCommand("digitamaOpencode.atualizarExtensao", () => atualizador.atualizarExtensao().catch(falhou)),
    vscode.commands.registerCommand("digitamaOpencode.atualizarOpencode", () => atualizador.atualizarOpencode()),
    atualizador.iniciar(),
    vscode.workspace.onDidChangeWorkspaceFolders(() => prov.iniciar(true)),
    { dispose: () => prov.parar() },
  );
}

export function deactivate() {}

/**
 * Caminhos dos arquivos copiados no Explorer (lista CF_HDROP da área de
 * transferência). Só lê; nunca muda o que está copiado. Fora do Windows, vazio.
 */
function caminhosCopiados(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }";
  return new Promise((resolve) => {
    // Windows PowerShell 5.1 (STA, tem o Clipboard do Windows Forms) vem em todo Windows 10/11
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

class Painel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private modelos: Modelo[] = [];
  private agentes: Agente[] = [];
  private comandos: { name: string; description?: string }[] = [];
  private skills: { id: string; name: string; description?: string }[] = [];
  /** Nome de cada provedor (id → "OpenCode", "Google"…), para agrupar o menu de modelos. */
  private provedores: Record<string, string> = {};
  private sessoes: Sessao[] = [];
  private atual?: Sessao;
  private agente = "build";
  private modelo?: { id: string; providerID: string };
  private usado = 0;
  private rodando = false;
  private conectado = false;
  private espiando?: NodeJS.Timeout;
  private modo: Modo;
  /** Limites aprendidos e bloqueios: arquivo compartilhado por todas as janelas do VS Code. */
  private uso: uso.Compartilhado = uso.vazio();
  /** Tokens desde o início da janela de cada cota, do servidor (soma todas as janelas, TUI, celular e subagentes). */
  private gasto: { porModelo: Record<string, number>; porCota: Record<string, number> } = { porModelo: {}, porCota: {} };
  /** Modelo de cada sessão (inclusive subagentes), visto no início de cada passo. */
  private modeloDaSessao = new Map<string, string>();
  /** Para de executar quando o agente repete a mesma chamada várias vezes. */
  private repeticao = new DetectorRepeticao((sid, ferramenta, motivo) => void this.interromperRepeticao(sid, ferramenta, motivo));
  /** Texto da resposta em andamento, por sessão, para achar chamada de ferramenta escrita como texto. */
  private textoDaExecucao = new Map<string, string>();
  /** Lista de arquivos da pasta para o @arquivo (refeita a cada 20 s no máximo). */
  private cacheArquivos?: { pasta: string; em: number; lista: string[] };
  private atualizandoUso?: NodeJS.Timeout;
  private relogioUso?: NodeJS.Timeout;
  aoContexto: (usado: number, limite: number, nome?: string) => void = () => {};

  constructor(private ctx: vscode.ExtensionContext, private svc: Servico) {
    this.modo = ctx.globalState.get<Modo>("modo", "perguntar");
  }

  /** Roda um comando de barra vindo da paleta do VS Code. */
  comando(texto: string) {
    return this.enviar(texto).catch((e) => this.erro(e));
  }

  temaMudou() {
    this.estado();
  }

  async recarregarAgentes() {
    try {
      this.agentes = await this.svc.agentes(this.pasta());
    } catch (e) {
      // Antes o erro era engolido e a lista velha ficava para sempre, sem aviso:
      // era isso que escondia um agente global recém-criado.
      this.avisar(`Não consegui recarregar os agentes: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.estado();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.mensagem(m).catch((e) => this.erro(e)));
  }

  private pasta(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private post(m: unknown) {
    this.view?.webview.postMessage(m);
  }

  private erro(e: unknown) {
    this.post({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
  }

  parar() {
    this.abort?.abort();
    clearInterval(this.espiando);
    clearInterval(this.relogioUso);
  }

  async iniciar(forcar = false) {
    if (this.abort && !forcar) return this.estado();
    this.parar();
    this.abort = new AbortController();
    try {
      await this.svc.conectar();
      [this.modelos, this.agentes] = await Promise.all([
        this.svc.modelos(this.pasta()),
        // Uma falha só nos agentes não derruba a conexão inteira: mantém a lista
        // anterior e avisa, em vez de deixar o menu preso nos agentes embutidos.
        this.svc.agentes(this.pasta()).catch((e) => {
          this.avisar(`Não consegui listar os agentes: ${e instanceof Error ? e.message : String(e)}. Mantive a lista anterior.`);
          return this.agentes;
        }),
      ]);
      this.comandos = ((await this.svc.req<{ data: any[] }>("GET", "/api/command" + naPasta(this.pasta())).catch(() => ({ data: [] }))).data ?? []).map((c) => ({
        name: c.name ?? c.id,
        description: c.description,
      }));
      this.provedores = await this.svc.provedores(this.pasta()).catch(() => ({}));
      this.skills = ((await this.svc.req<{ data: any[] }>("GET", "/api/skill" + naPasta(this.pasta())).catch(() => ({ data: [] }))).data ?? []).map((k) => ({
        id: k.id,
        name: k.name ?? k.id,
        description: k.description,
      }));
      const padrao = await this.svc.req<{ data: any }>("GET", "/api/model/default").catch(() => undefined);
      if (!this.modelo && padrao?.data) this.modelo = { id: padrao.data.id, providerID: padrao.data.providerID };
      this.conectado = true;
    } catch (e) {
      this.conectado = false;
      this.erro(e);
    }
    void this.svc.eventos(this.abort.signal, (e) => this.evento(e), (ok) => {
      const reconectou = ok && !this.conectado;
      this.conectado = ok;
      // o serviço pode ter subido com outra configuração (um agente global novo,
      // por exemplo): ao reconectar, relê a lista em vez de ficar com a antiga.
      if (reconectou) void this.recarregarAgentes();
      this.estado();
    });
    clearInterval(this.relogioUso);
    this.relogioUso = setInterval(() => void this.atualizarUso(), 60_000);
    void this.atualizarUso();
    this.espiando = setInterval(() => {
      if (this.rodando) void this.pendencias();
    }, 3000);
    await this.listar();
  }

  async listar() {
    const pasta = this.pasta();
    if (!pasta || !this.conectado) return this.estado();
    const q = new URLSearchParams({ directory: pasta, order: "desc", limit: "30", parentID: "null" });
    const j = await this.svc.req<{ data: Sessao[] }>("GET", `/api/session?${q}`).catch((e) => (this.erro(e), { data: [] }));
    this.sessoes = j.data ?? [];
    this.estado();
  }

  private limite(): { limite: number; nome?: string } {
    const ref = this.atual?.model ?? this.modelo;
    const m = this.modelos.find((x) => x.id === ref?.id && x.providerID === ref?.providerID);
    return { limite: m?.contexto ?? 0, nome: m?.name };
  }

  private estado() {
    const { limite, nome } = this.limite();
    this.aoContexto(this.usado, limite, nome);
    this.post({
      tipo: "estado",
      conectado: this.conectado,
      pasta: this.pasta(),
      sessoes: this.sessoes.map((s) => ({ id: s.id, title: s.title, updated: s.time?.updated })),
      atual: this.atual?.id,
      titulo: this.atual?.title,
      agente: this.atual?.agent ?? this.agente,
      modelo: this.atual?.model ?? this.modelo,
      modelos: this.modelos,
      agentes: this.agentes,
      comandos: this.comandos,
      locais: COMANDOS,
      skills: this.skills,
      provedores: this.provedores,
      ctx: { usado: this.usado, limite },
      rodando: this.rodando,
      modo: this.modo,
      tema: { ...TEMA_PADRAO, ...this.ctx.globalState.get<Partial<Tema>>("tema", {}) },
      uso: Object.fromEntries(
        this.modelos.map((m) => {
          const ref = `${m.providerID}/${m.id}`;
          const agora = Date.now();
          // usado/limite/esgotadoAte são da cota (compartilhada entre os grátis); usadoModelo é só deste modelo
          const cota = this.cotaDe(ref);
          return [ref, { cota, ...uso.situacao(this.uso, cota, this.gasto.porCota[cota] ?? 0, agora), usadoModelo: this.gasto.porModelo[ref] ?? 0 }];
        }),
      ),
    });
  }

  async nova() {
    this.atual = undefined;
    this.usado = 0;
    this.rodando = false;
    this.post({ tipo: "historico", mensagens: [] });
    this.post({ tipo: "pendencias", permissoes: [], forms: [] });
    this.estado();
  }

  private async criar(): Promise<Sessao> {
    const pasta = this.pasta();
    if (!pasta) throw new Error("Abra uma pasta no VS Code: a conversa trabalha nela.");
    const j = await this.svc.req<{ data: Sessao }>("POST", "/api/session", {
      location: { directory: pasta },
      agent: this.agente,
      model: this.modelo ?? null,
      permissions: regrasDoModo(this.modo),
    });
    this.atual = j.data;
    this.sessoes.unshift(j.data);
    return j.data;
  }

  private async abrir(id: string) {
    const s = await this.svc.req<{ data: Sessao }>("GET", `/api/session/${id}`);
    this.atual = s.data;
    await this.svc.req("PATCH", `/api/session/${id}`, { permissions: regrasDoModo(this.modo) }).catch(() => {});
    await this.historico();
    await this.pendencias();
  }

  private async historico() {
    if (!this.atual) return;
    const j = await this.svc.req<{ data: any[] }>("GET", `/api/session/${this.atual.id}/message?limit=200&order=desc`);
    let msgs = (j.data ?? []).reverse();
    // depois de um /desfazer, a sessão marca a mensagem desfeita: dali em diante some da conversa
    const sess = await this.svc.req<{ data: Sessao & { revert?: { messageID: string } } }>("GET", `/api/session/${this.atual.id}`).catch(() => undefined);
    if (sess?.data) this.atual = { ...this.atual, ...sess.data };
    const corte = sess?.data?.revert ? msgs.findIndex((m) => m.id === sess.data.revert!.messageID) : -1;
    // quantos pedidos seus foram desfeitos: a faixa "N desfeitas · Refazer" mostra isso
    const desfeitas = corte >= 0 ? msgs.slice(corte).filter((m) => m.type === "user").length : 0;
    if (corte >= 0) msgs = msgs.slice(0, corte);
    const ultima = [...msgs].reverse().find((m) => m.type === "assistant" && m.tokens);
    this.usado = contextoUsado(ultima?.tokens);
    this.rodando = msgs.length > 0 && msgs[msgs.length - 1].type !== "idle" && msgs[msgs.length - 1].type !== "assistant";
    this.post({ tipo: "historico", mensagens: msgs, desfeitas });
    this.estado();
  }

  private async pendencias() {
    if (!this.atual) return;
    const id = this.atual.id;
    const [p, f] = await Promise.all([
      this.svc.req<{ data: any[] }>("GET", `/api/session/${id}/permission`).catch(() => ({ data: [] })),
      this.svc.req<{ data: any[] }>("GET", `/api/session/${id}/form`).catch(() => ({ data: [] })),
    ]);
    if (this.atual?.id === id) this.post({ tipo: "pendencias", permissoes: p.data ?? [], forms: f.data ?? [] });
  }

  /** Os modelos grátis de um provedor dividem a mesma cota; um pago tem a sua. */
  private cotaDe(ref: string): string {
    const m = this.modelos.find((x) => `${x.providerID}/${x.id}` === ref);
    return m?.gratis ? `${m.providerID}:gratis` : ref;
  }

  private arquivoUso() {
    return path.join(this.ctx.globalStorageUri.fsPath, "uso.json");
  }

  /** Lê o arquivo compartilhado e junta com o desta janela (outra janela pode ter aprendido algo). */
  private lerUso() {
    try {
      const outro = JSON.parse(fs.readFileSync(this.arquivoUso(), "utf8"));
      this.uso = uso.mesclar(this.uso, outro, Date.now());
    } catch {}
  }

  private gravarUso() {
    this.lerUso(); // relê antes: nunca apaga o que outra janela gravou
    try {
      fs.mkdirSync(path.dirname(this.arquivoUso()), { recursive: true });
      fs.writeFileSync(this.arquivoUso(), JSON.stringify(this.uso), "utf8");
    } catch {}
  }

  /**
   * Busca no servidor os tokens (todas as sessões, de todas as janelas) desde o
   * início da janela de cada cota: o reinício diário, quando já é conhecido, ou
   * as últimas 5 h. Uma consulta por início diferente (quase sempre uma ou duas).
   */
  private async atualizarUso() {
    this.lerUso();
    const agora = Date.now();
    const inicio = (cota: string) => uso.inicioDaJanela(this.uso.reinicios?.[cota], agora).desde;
    const cotas = [...new Set(this.modelos.map((m) => this.cotaDe(`${m.providerID}/${m.id}`)))];
    const inicios = [...new Set([agora - uso.JANELA_MS, ...cotas.map(inicio)])];
    const somas = new Map<number, ReturnType<typeof uso.somar>>();
    await Promise.all(
      inicios.map(async (de) => {
        const j = await this.svc.req<{ data: any }>("GET", `/api/experimental/session/stats?from=${de}&tools=none`).catch(() => undefined);
        if (j?.data) somas.set(de, uso.somar(j.data.models ?? [], (ref) => this.cotaDe(ref)));
      }),
    );
    if (somas.size) {
      // cada cota (e cada modelo dela) usa a soma que começa no seu próprio início
      const gasto: typeof this.gasto = { porModelo: {}, porCota: {} };
      const de = (ref: string) => somas.get(inicio(this.cotaDe(ref)));
      for (const c of cotas) gasto.porCota[c] = somas.get(inicio(c))?.porCota[c] ?? 0;
      for (const m of this.modelos) {
        const ref = `${m.providerID}/${m.id}`;
        gasto.porModelo[ref] = de(ref)?.porModelo[ref] ?? 0;
      }
      this.gasto = gasto;
    }
    this.estado();
  }

  /** Depois de cada resposta, em qualquer sessão: atualiza logo (agrupado). */
  private usoEmBreve() {
    clearTimeout(this.atualizandoUso);
    this.atualizandoUso = setTimeout(() => void this.atualizarUso(), 1500);
  }

  /** Percebe a recusa por cota em qualquer sessão (FreeUsageLimitError e afins). */
  private contarUso(t: string, d: any) {
    const sid = d?.sessionID;
    if (!sid) return;
    if (t === "session.step.started" && d.model) this.modeloDaSessao.set(sid, `${d.model.providerID}/${d.model.id}`);
    if (t === "session.step.ended" || t.startsWith("session.execution.")) this.usoEmBreve();
    if (!/fail|retry|error/.test(t)) return;
    const err = d.error?.error ?? d.error ?? {};
    const msg = typeof err === "string" ? err : err.message ?? d.message;
    if (!uso.erroDeLimite(msg, err.status, err.type ?? err._tag) && !/FreeUsageLimitError/.test(JSON.stringify(d))) return;
    const mAtual = this.atual?.id === sid ? this.atual?.model : undefined;
    const ref = this.modeloDaSessao.get(sid) ?? (mAtual ? `${mAtual.providerID}/${mAtual.id}` : undefined);
    if (!ref) return;
    this.registrarLimite(ref, err.retryAfterMs ?? d.retryAfterMs);
  }

  /** Conta chamadas de ferramenta para perceber o agente repetindo os mesmos passos. */
  private vigiarRepeticao(t: string, d: any) {
    const sid = d?.sessionID;
    if (!sid) return;
    // Cada execução nova (o usuário mandou outra mensagem) recomeça a contagem.
    if (t === "session.execution.started") {
      this.textoDaExecucao.set(sid, "");
      return this.repeticao.zerar(sid);
    }
    if (t === "session.text.delta") {
      // só o fim importa para achar chamada escrita como texto; guarda até 20 mil caracteres
      const s = (this.textoDaExecucao.get(sid) ?? "") + (d.delta ?? "");
      this.textoDaExecucao.set(sid, s.slice(-20_000));
      return;
    }
    if (t === "session.execution.succeeded") {
      const texto = this.textoDaExecucao.get(sid) ?? "";
      this.textoDaExecucao.delete(sid);
      if (sid === this.atual?.id && chamadaEmTexto(texto)) this.avisarChamadaEmTexto();
      return;
    }
    if (t.startsWith("session.execution.")) return void this.textoDaExecucao.delete(sid);
    if (t !== "session.tool.called") return;
    this.repeticao.ferramenta(sid, d.name, d.input);
  }

  /** O modelo escreveu a chamada de ferramenta na resposta em vez de chamá-la: nada foi executado. */
  private avisarChamadaEmTexto() {
    this.post({
      tipo: "aviso",
      nivel: "erro",
      texto:
        "O agente escreveu a chamada de ferramenta como texto, então nada foi criado nem executado. Isso costuma acontecer com modelos que não suportam bem ferramentas: peça para executar de verdade ou troque de modelo.",
      acao: { rotulo: "Executar de verdade", enviar: PEDIDO_EXECUTAR },
    });
  }

  /** O agente entrou em loop: interrompe e explica, em vez de deixar rodando. */
  private async interromperRepeticao(sid: string, ferramenta: string, motivo: MotivoRepeticao) {
    const nome = ferramenta || "ferramenta";
    try {
      await this.svc.req("POST", `/api/session/${sid}/interrupt`, {});
    } catch (e) {
      // Se nem interromper deu certo, o aviso abaixo ainda explica o que houve.
      this.avisar(`Não consegui interromper a repetição: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.post({
      tipo: "aviso",
      nivel: "erro",
      texto:
        motivo === "seguidas"
          ? `Parei: o agente repetiu "${nome}" ${REPETICOES_ATE_PARAR + 1} vezes seguidas com a mesma entrada. Isso é loop — reformule o pedido ou dê mais contexto.`
          : `Parei: o agente voltou ${VEZES_NO_CICLO} vezes à mesma chamada de "${nome}" nas últimas ${JANELA_CICLO} ações, andando em círculo. Reformule o pedido, dê mais contexto ou troque de modelo.`,
    });
  }

  private registrarLimite(ref: string, retryAfterMs: unknown) {
    const cota = this.cotaDe(ref);
    // o servidor diz quando a cota volta (retry-after); outra janela pode já ter marcado
    uso.marcarLimite(this.uso, cota, uso.liberaEm(retryAfterMs, Date.now()));
    this.gravarUso();
    this.estado();
    this.avisarLimite(ref);
    void this.atualizarUso();
  }

  private avisarLimite(ref: string) {
    const cota = this.cotaDe(ref);
    const b = this.uso.bloqueios[cota];
    const nome = this.modelos.find((m) => `${m.providerID}/${m.id}` === ref)?.name ?? ref;
    const hora = b ? new Date(b.ate).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
    const volta = !b ? "" : b.exato ? ` Volta às ${hora} (horário informado pelo servidor).` : ` Deve voltar por volta das ${hora} (estimativa: o servidor não informou).`;
    const compartilhada = cota !== ref;
    this.post({
      tipo: "aviso",
      nivel: "erro",
      texto: compartilhada
        ? `A cota grátis acabou (${nome} recusou). Ela vale para todos os modelos grátis deste provedor, em todas as janelas: trocar para outro grátis não resolve.${volta} Até lá, use um modelo pago ou de outro provedor.`
        : `${nome} chegou no limite de uso.${volta} Troque de modelo para continuar.`,
      acao: { rotulo: "Trocar modelo", menu: "modelo" },
    });
  }

  /** Pai de cada sessão vista nos eventos (a busca é uma só por sessão, e em ordem). */
  private paiDe = new Map<string, Promise<{ pai?: string; agente?: string }>>();

  /** Evento de outra sessão: se for subagente da conversa aberta (ou de um subagente dela), vai para o cartão dele. */
  private eventoDeSubagente(sid: string, e: any) {
    let p = this.paiDe.get(sid);
    if (!p) {
      p = this.svc
        .req<{ data: Sessao & { parentID?: string } }>("GET", `/api/session/${sid}`)
        .then((j) => ({ pai: j.data?.parentID, agente: j.data?.agent }))
        .catch(() => ({}));
      this.paiDe.set(sid, p);
    }
    void p.then(async ({ pai, agente }) => {
      if (!pai || !this.atual) return;
      // sobe pela cadeia (subagente de subagente) até achar a conversa aberta
      let acima: string | undefined = pai;
      for (let i = 0; acima && i < 5; i++) {
        if (acima === this.atual.id) return this.post({ tipo: "subEvento", sessao: sid, agente, e });
        acima = (await this.paiDe.get(acima))?.pai;
      }
    });
  }

  private evento(e: any) {
    const t: string = e.type ?? "";
    const sid = e.data?.sessionID;
    this.contarUso(t, e.data);
    this.vigiarRepeticao(t, e.data);
    if (/permission|form/.test(t)) void this.pendencias();
    if (this.atual && sid && sid !== this.atual.id && /^session\.(step|text|reasoning|tool)\./.test(t)) this.eventoDeSubagente(sid, e);
    if (!this.atual || sid !== this.atual.id) {
      if (t.startsWith("session.") && sid && this.sessoes.some((s) => s.id === sid) && t === "session.execution.succeeded") void this.listar();
      return;
    }
    if (t === "session.execution.started") this.rodando = true;
    if (t === "session.step.ended") this.usado = contextoUsado(e.data.tokens);
    if (t === "session.step.started" && e.data.model) this.atual.model = e.data.model;
    if (t.startsWith("session.execution.") && t !== "session.execution.started") {
      this.rodando = false;
      void this.historico().then(() => this.listar());
      void this.pendencias();
    }
    this.post({ tipo: "evento", e });
    if (/^session\.(execution|step\.(started|ended))/.test(t)) this.estado();
  }

  async parear() {
    try {
      if (!this.svc.base) await this.svc.conectar();
      const { code, expires_in } = await this.svc.codigo();
      const url = `${this.svc.base}/auth/connect/${code}`;
      this.post({ tipo: "pair", url, expira: Date.now() + expires_in * 1000 });
      await vscode.commands.executeCommand("digitamaOpencode.chat.focus");
    } catch (e) {
      this.erro(e);
    }
  }

  private async mensagem(m: any): Promise<unknown> {
    switch (m.tipo) {
      case "pronto":
        return this.iniciar();
      case "reconectar":
        return this.iniciar(true);
      case "nova":
        return this.nova();
      case "excluir": {
        // só chega aqui depois da confirmação no próprio menu (não tem volta)
        const ids: string[] = (m.ids ?? []).filter((id: unknown) => typeof id === "string" && /^ses/.test(id));
        const falhas: string[] = [];
        for (const id of ids) await this.svc.req("DELETE", `/api/session/${id}`).catch(() => falhas.push(id));
        if (this.atual && ids.includes(this.atual.id) && !falhas.includes(this.atual.id)) await this.nova();
        await this.listar();
        const ok = ids.length - falhas.length;
        return this.avisar(falhas.length ? `${ok} excluída(s); ${falhas.length} falharam.` : `${ok} conversa(s) excluída(s).`, falhas.length ? "info" : "ok");
      }
      case "abrir":
        return this.abrir(m.id);
      case "subagente": {
        // a execução de um subagente (sessão filha), para o cartão dele
        if (typeof m.id !== "string" || !/^ses/.test(m.id)) return;
        const j = await this.svc.req<{ data: any[] }>("GET", `/api/session/${m.id}/message?limit=200&order=desc`).catch(() => undefined);
        return this.post({ tipo: "subagente", id: m.id, mensagens: (j?.data ?? []).reverse(), erro: j ? undefined : "não consegui buscar a execução" });
      }
      case "pair":
        return this.parear();
      case "copiar":
        await vscode.env.clipboard.writeText(m.texto);
        return vscode.window.setStatusBarMessage("Link copiado.", 2000);
      case "navegador":
        return vscode.env.openExternal(vscode.Uri.parse(m.url));
      case "agente":
        this.agente = m.id;
        {
          // agente com modelo próprio (ex.: montado no painel) leva o modelo junto
          const proprio = this.agentes.find((a) => a.id === m.id)?.model;
          if (proprio) this.modelo = { id: proprio.id, providerID: proprio.providerID };
        }
        if (this.atual) {
          await this.svc.req("POST", `/api/session/${this.atual.id}/agent`, { agent: m.id });
          this.atual.agent = m.id;
          if (this.modelo) {
            await this.svc.req("POST", `/api/session/${this.atual.id}/model`, { model: this.modelo });
            this.atual.model = this.modelo;
          }
        }
        return this.estado();
      case "modelo":
        this.modelo = { id: m.id, providerID: m.providerID };
        if (this.atual) {
          await this.svc.req("POST", `/api/session/${this.atual.id}/model`, { model: this.modelo });
          this.atual.model = this.modelo;
        }
        return this.estado();
      case "modo":
        this.modo = m.modo;
        await this.ctx.globalState.update("modo", m.modo);
        if (this.atual) await this.svc.req("PATCH", `/api/session/${this.atual.id}`, { permissions: regrasDoModo(this.modo) });
        return this.estado();
      case "agentes":
        return vscode.commands.executeCommand("digitamaOpencode.agentes");
      case "config":
        return vscode.commands.executeCommand("digitamaOpencode.config", m.aba);
      case "enviar":
        return this.enviar(String(m.texto ?? ""), Array.isArray(m.anexos) ? m.anexos : []);
      case "colar": {
        // Ctrl+C num arquivo do Explorer guarda o caminho real: usa ele (sem copiar nada)
        const nomes: string[] = (Array.isArray(m.nomes) ? m.nomes : []).map((n: unknown) => String(n ?? ""));
        const caminhos = await caminhosCopiados();
        const entrada = this.modelos.find((x) => x.id === (this.atual?.model ?? this.modelo)?.id && x.providerID === (this.atual?.model ?? this.modelo)?.providerID)?.entrada ?? [];
        const achados: Anexo[] = [];
        const faltam: string[] = [];
        for (const nome of nomes) {
          const p = caminhos.find((c) => path.basename(c).toLowerCase() === nome.toLowerCase());
          if (p) achados.push(classificar(p, entrada));
          else faltam.push(nome);
        }
        if (achados.length) this.post({ tipo: "anexos", itens: achados });
        if (faltam.length) this.post({ tipo: "enviarConteudo", nomes: faltam });
        return;
      }
      case "colarArquivos": {
        // a webview não sabe o caminho do que foi colado: grava numa pasta da extensão e classifica como no clipe
        const dir = path.join(this.ctx.globalStorageUri.fsPath, "anexos");
        fs.mkdirSync(dir, { recursive: true });
        const entrada = this.modelos.find((x) => x.id === (this.atual?.model ?? this.modelo)?.id && x.providerID === (this.atual?.model ?? this.modelo)?.providerID)?.entrada ?? [];
        const itens = (Array.isArray(m.itens) ? m.itens : []).slice(0, 20).map((it: any) => {
          const nome = String(it.nome ?? "colado").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100) || "colado";
          const p = path.join(dir, `${Date.now()}-${nome}`);
          fs.writeFileSync(p, Buffer.from(String(it.b64 ?? ""), "base64"));
          return { ...classificar(p, entrada), nome };
        });
        return this.post({ tipo: "anexos", itens });
      }
      case "anexar": {
        // no Windows/Linux, arquivos + pastas no mesmo seletor vira um seletor só de pastas: aqui são só arquivos
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: "Anexar", title: "Anexar arquivos", defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
        if (!uris?.length) return;
        const entrada = this.modelos.find((x) => x.id === (this.atual?.model ?? this.modelo)?.id && x.providerID === (this.atual?.model ?? this.modelo)?.providerID)?.entrada ?? [];
        return this.post({ tipo: "anexos", itens: uris.map((u) => classificar(u.fsPath, entrada)) });
      }
      case "buscarArquivos": {
        // @arquivo: lista da pasta (com cache) + ranking; a resposta leva o id para a webview descartar as velhas
        const caminhos = await this.arquivosDaPasta();
        return this.post({ tipo: "arquivosAchados", id: m.id, itens: buscar(caminhos, String(m.q ?? "")) });
      }
      case "mencionarArquivo": {
        const pasta = this.pasta();
        const rel = String(m.rel ?? "");
        if (!pasta || !rel || rel.includes("..")) return;
        return this.post({ tipo: "anexos", itens: [classificar(path.join(pasta, rel), this.entradaDoModelo())] });
      }
      case "soltar": {
        // arrastar do Explorer do VS Code (ou do Windows): chegam URIs file://
        const entrada = this.entradaDoModelo();
        const itens: Anexo[] = [];
        for (const u of (Array.isArray(m.uris) ? m.uris : []).slice(0, 20)) {
          try {
            const uri = vscode.Uri.parse(String(u));
            if (uri.scheme === "file" && fs.statSync(uri.fsPath).isFile()) itens.push(classificar(uri.fsPath, entrada));
          } catch {} // pasta, URI estranha ou arquivo que sumiu: ignora
        }
        if (itens.length) this.post({ tipo: "anexos", itens });
        else this.avisar("Solte arquivos (pastas não são anexadas). Do Explorer do VS Code, segure Shift ao soltar.");
        return;
      }
      case "interromper":
        if (this.atual) await this.svc.req("POST", `/api/session/${this.atual.id}/interrupt`, {});
        return;
      case "compactar":
        if (this.atual) await this.svc.req("POST", `/api/session/${this.atual.id}/compact`, {});
        return;
      case "permissao":
        if (!this.atual) return;
        await this.svc.req("POST", `/api/session/${this.atual.id}/permission/${m.id}/reply`, { decision: m.decisao });
        return this.pendencias();
      case "form":
        if (!this.atual) return;
        await this.svc.req("POST", `/api/session/${this.atual.id}/form/${m.id}/reply`, { answer: m.answer });
        return this.pendencias();
      case "formCancelar":
        if (!this.atual) return;
        await this.svc.req("DELETE", `/api/session/${this.atual.id}/form/${m.id}`);
        return this.pendencias();
    }
  }

  /** Tipos de entrada que o modelo atual lê (para decidir anexo ou caminho). */
  private entradaDoModelo(): string[] {
    const m = this.atual?.model ?? this.modelo;
    return this.modelos.find((x) => x.id === m?.id && x.providerID === m?.providerID)?.entrada ?? [];
  }

  /** Arquivos da pasta do projeto, relativos e com "/"; refeito no máximo a cada 20 s. */
  private async arquivosDaPasta(): Promise<string[]> {
    const pasta = this.pasta();
    if (!pasta) return [];
    const c = this.cacheArquivos;
    if (c && c.pasta === pasta && Date.now() - c.em < 20_000) return c.lista;
    const base = vscode.Uri.file(pasta);
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(base, "**/*"), "**/{node_modules,.git,target,out,dist}/**", 20_000);
    const lista = uris.map((u) => path.relative(pasta, u.fsPath).split(path.sep).join("/"));
    this.cacheArquivos = { pasta, em: Date.now(), lista };
    return lista;
  }

  /**
   * Manda o prompt com os agentes citados com "@" (o OpenCode chama cada um
   * nesta mensagem). Se o servidor recusar o campo `agents`, manda de novo sem
   * ele: a menção nunca impede a mensagem de sair (o "@nome" segue no texto).
   */
  private async prompt(sid: string, text: string, extra: Record<string, unknown> = {}) {
    const url = `/api/session/${sid}/prompt`;
    const agents = mencoesDeAgentes(text, this.agentes.map((a) => a.id));
    // "/skill" em qualquer ponto da frase carrega a skill nesta mensagem
    const skills = skillsCitadas(text, this.skills.map((k) => k.id)).map((id) => ({ id }));
    const mais = { ...(agents.length ? { agents } : {}), ...(skills.length ? { skills } : {}) };
    if (!agents.length && !skills.length) return this.svc.req<{ data: any }>("POST", url, { text, ...extra });
    try {
      return await this.svc.req<{ data: any }>("POST", url, { text, ...extra, ...mais });
    } catch {
      return this.svc.req<{ data: any }>("POST", url, { text, ...extra });
    }
  }

  private async enviar(texto: string, anexos: Anexo[] = []): Promise<unknown> {
    texto = texto.trim();
    if (!texto && !anexos.length) return;
    const local = anexos.length ? undefined : lerComando(texto);
    if (local) return this.executar(local.cmd, local.args);
    if (anexos.length) {
      // arquivos legíveis vão em `files` (file:// ou data: do texto colado); o resto vai pelo caminho no texto
      const s = this.atual ?? (await this.criar());
      const files = anexos
        .filter((a) => a.modo === "arquivo" && typeof a.uri === "string" && /^(file:|data:text\/plain;)/.test(a.uri))
        .map((a) => ({ uri: a.uri!, name: String(a.nome ?? "anexo").slice(0, 120) }));
      const final = comCaminhos(texto || "Veja os anexos.", anexos);
      this.rodando = true;
      this.estado();
      const r = await this.prompt(s.id, final, { files });
      this.post({ tipo: "eco", mensagem: { id: r.data?.id, type: "user", text: final, anexos: anexos.map((a) => ({ nome: a.nome, modo: a.modo })) } });
      return;
    }
    const s = this.atual ?? (await this.criar());
    const shell = lerShell(texto);
    this.rodando = true;
    this.estado();
    if (shell) {
      await this.svc.req("POST", `/api/session/${s.id}/shell`, { command: shell });
      return;
    }
    const cmd = texto.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (cmd && this.comandos.some((c) => c.name === cmd[1])) {
      await this.svc.req("POST", `/api/session/${s.id}/command`, { name: cmd[1], text: cmd[2] });
    } else {
      const r = await this.prompt(s.id, texto);
      this.post({ tipo: "eco", mensagem: { id: r.data?.id, type: "user", text: texto } });
    }
  }

  avisarSubida(quem: "eu" | "outra") {
    vscode.window.setStatusBarMessage(quem === "eu" ? "$(sync~spin) Subindo o serviço do OpenCode…" : "$(sync~spin) Outra janela está subindo o serviço do OpenCode…", 20_000);
  }

  private avisar(texto: string, nivel: "ok" | "info" = "info") {
    this.post({ tipo: "aviso", texto, nivel });
  }

  /** Comandos de barra locais (src/comandos.ts). */
  private async executar(cmd: Comando, args: string): Promise<unknown> {
    const s = this.atual;
    if (cmd.sessao && !s) return this.avisar(`/${cmd.nome} precisa de uma conversa aberta.`);
    const base = s ? `/api/session/${s.id}` : "";
    switch (cmd.nome) {
      case "recarregar": {
        const pasta = this.pasta();
        if (pasta) await this.svc.req("POST", "/api/location/reload" + naPasta(pasta), {}).catch(() => {});
        await this.iniciar(true);
        if (s) await this.abrir(s.id);
        return this.avisar("Recarregado: conversa, agentes, modelos e comandos.", "ok");
      }
      case "nova":
        return this.nova();
      case "sessoes":
        return this.post({ tipo: "menu", qual: "sessao" });
      case "parar":
        await this.svc.req("POST", `${base}/interrupt`, {});
        return;
      case "compactar":
        await this.svc.req("POST", `${base}/compact`, {});
        return this.avisar("Compactando a conversa…");
      case "desfazer": {
        const j = await this.svc.req<{ data: any[] }>("GET", `${base}/message?limit=200&order=desc`);
        const ultima = (j.data ?? []).find((m) => m.type === "user");
        if (!ultima) return this.avisar("Nada para desfazer.");
        await this.svc.req("POST", `${base}/revert/stage`, { messageID: ultima.id, files: true });
        await this.historico();
        return this.avisar("Última mensagem desfeita (arquivos também). Use /refazer para voltar.", "ok");
      }
      case "refazer":
        await this.svc.req("DELETE", `${base}/revert`);
        await this.historico();
        return this.avisar("Refeito.", "ok");
      case "bifurcar": {
        const j = await this.svc.req<{ data: Sessao }>("POST", `${base}/fork`, {});
        await this.listar();
        await this.abrir(j.data.id);
        return this.avisar("Conversa copiada. Você está na cópia.", "ok");
      }
      case "renomear":
        if (!args) return this.avisar("Use: /renomear <título>");
        await this.svc.req("PATCH", base, { title: args });
        s!.title = args;
        await this.listar();
        return this.avisar("Conversa renomeada.", "ok");
      case "arquivar":
        await this.svc.req("PATCH", base, { archived: true });
        await this.nova();
        await this.listar();
        return this.avisar("Conversa arquivada.", "ok");
      case "exportar": {
        const j = await this.svc.req("GET", `/api/experimental/session/${s!.id}/export`);
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(j, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      case "modelos":
        return this.post({ tipo: "menu", qual: "modelo" });
      case "agentes":
        return this.post({ tipo: "menu", qual: "agente" });
      case "montar":
        return vscode.commands.executeCommand("digitamaOpencode.agentes");
      case "modo": {
        const modo = ({ perguntar: "perguntar", ask: "perguntar", edicoes: "edicoes", edits: "edicoes", auto: "auto" } as Record<string, Modo>)[args.toLowerCase()];
        if (!modo) return this.avisar("Use: /modo perguntar | edicoes | auto");
        return this.mensagem({ tipo: "modo", modo });
      }
      case "skill": {
        const [id, ...resto] = args.split(/\s+/);
        if (!id || !this.skills.some((k) => k.id === id)) return this.avisar(`Skills: ${this.skills.map((k) => k.id).join(", ") || "nenhuma"}`);
        const sess = this.atual ?? (await this.criar());
        const textoSkill = resto.join(" ") || `Use a skill ${id}.`;
        this.rodando = true;
        this.estado();
        const r = await this.svc.req<{ data: any }>("POST", `/api/session/${sess.id}/prompt`, { text: textoSkill, skills: [{ id }] });
        this.post({ tipo: "eco", mensagem: { id: r.data?.id, type: "user", text: `[${id}] ${textoSkill}` } });
        return;
      }
      case "mcp": {
        const j = await this.svc.req<{ data: any[] }>("GET", "/api/mcp" + naPasta(this.pasta()));
        const nomes: Record<string, string> = { connected: "conectado", pending: "conectando", disabled: "desligado", failed: "falhou", needs_auth: "precisa de login" };
        const l = (j.data ?? []).map((m) => `${m.name ?? m.id}: ${nomes[m.status?.status] ?? m.status?.status ?? "?"}`);
        return this.avisar(l.length ? "MCP — " + l.join(" · ") : "Nenhum servidor MCP configurado. Adicione em Configurações → MCPs (o do pet Digitama entra com um clique).");
      }
      case "status": {
        const info = await this.svc.req<any>("GET", "/api/info").catch(() => ({}));
        const { limite, nome } = this.limite();
        return this.avisar(`OpenCode ${info.version ?? "?"} em ${this.svc.base} · ${nome ?? "modelo padrão"} · contexto ${this.usado.toLocaleString("pt-BR")}/${limite.toLocaleString("pt-BR")} · modo ${this.modo}`);
      }
      case "pair":
        return this.parear();
      case "config":
        return vscode.commands.executeCommand("digitamaOpencode.config");
      case "atualizar":
        return vscode.commands.executeCommand("digitamaOpencode.config", "atualizacoes");
      case "ajuda":
        return this.post({ tipo: "ajuda" });
    }
  }

  private html(w: vscode.Webview, media: vscode.Uri) {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, "main.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
    const icones = w.asWebviewUri(vscode.Uri.joinPath(media, "icones.js"));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${icones}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
