// Configurações em forma de Digivice: um anel de hexágonos em volta do seu
// Digimon (animado no centro) e, ao lado, os painéis de cada seção.
import "../shared/digivice.css";
import "./settings.css";
import { listen } from "@tauri-apps/api/event";
import { api, type PetState, type Usage } from "../shared/api";
import { usageBlock } from "../shared/usage";
import { iconImg } from "../shared/icons";
import { LINES, STAGES, XP_STAGES, monFor, stageForXp, type LineId } from "../shared/lore";
import { drawMon, drawMonFit, hasPack, loadPacks, monBox, type Pose } from "../pet/render";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
let state: PetState;
let usage: Usage | null = null;

interface Section {
  id: string;
  icon: string;
  title: string;
  color: string;
}
const SECTIONS: Section[] = [
  { id: "start", icon: "play", title: "Início", color: "#3dff8a" },
  { id: "digimon", icon: "egg", title: "Digimon", color: "#ffd23f" },
  { id: "hooks", icon: "agent", title: "Agentes", color: "#3dff8a" },
  { id: "chat", icon: "chat", title: "Chat", color: "#9fe6ff" },
  { id: "mcp", icon: "plug", title: "MCP", color: "#c48bff" },
  { id: "snip", icon: "camera", title: "Captura", color: "#ffffff" },
  { id: "sprites", icon: "star", title: "Sprites", color: "#ff8a3d" },
  { id: "keys", icon: "keys", title: "Atalhos", color: "#bff4ff" },
  { id: "about", icon: "book", title: "Sobre", color: "#ffd23f" },
];

document.body.innerHTML = `
<div class="digivice">
  <aside class="left">
    <div class="dv-banner title">DIGIVICE</div>
    <div class="dial">
      <div class="dial-outer"></div>
      <div class="dial-ticks"></div>
      <div class="dial-inner"></div>
      <canvas id="mon" width="240" height="210"></canvas>
      <div class="dv-banner dial-label" id="dial-label">Digimon</div>
    </div>
    <div class="wallet">
      <span class="dv-label">XP</span><b id="wallet-xp">0</b>
      <span class="dv-label">Tarefas</span><b id="wallet-tasks">0</b>
    </div>
  </aside>
  <main class="right">
    <div class="dv-banner head" id="head">Digimon</div>
    <div id="pages"></div>
  </main>
</div>`;

const dial = $(".dial");
SECTIONS.forEach((s, i) => {
  const a = ((-90 + (360 / SECTIONS.length) * i) * Math.PI) / 180;
  const b = document.createElement("button");
  b.className = "hex dial-item";
  b.dataset.section = s.id;
  b.style.setProperty("--x", `${Math.cos(a) * 168}px`);
  b.style.setProperty("--y", `${Math.sin(a) * 168}px`);
  b.style.setProperty("--i", String(i));
  b.title = s.title;
  b.append(iconImg(s.icon, s.color, 2));
  b.onclick = () => show(s.id);
  b.onmouseenter = () => ($("#dial-label").textContent = s.title);
  b.onmouseleave = () => ($("#dial-label").textContent = SECTIONS.find((x) => x.id === current)!.title);
  dial.append(b);
});

// ── Páginas ──────────────────────────────────────────────────────────────────

$("#pages").innerHTML = `
<section data-page="start">
  <div class="dv-panel">
    <p>Bem-vindo! Vamos deixar o Digitama pronto nesta máquina.</p>
    <div class="checklist">
      <div class="check-row"><span class="dot" id="ck-claude"></span><div><b>Claude Code</b><span class="muted" id="ck-claude-text">verificando…</span></div><button class="dv-btn" data-goto="hooks">Conectar</button></div>
      <div class="check-row"><span class="dot" id="ck-oc"></span><div><b>OpenCode</b><span class="muted" id="ck-oc-text">verificando…</span></div><button class="dv-btn" data-goto="hooks">Conectar</button></div>
      <div class="check-row"><span class="dot" id="ck-sprites"></span><div><b>Sprites dos Digimon</b><span class="muted" id="ck-sprites-text">verificando…</span></div><button class="dv-btn" id="ck-sprites-btn">Baixar</button></div>
      <div class="check-row"><span class="dot on"></span><div><b>Iniciar com o Windows</b><span class="muted">o pet abre sozinho quando você liga o PC</span></div><label class="check"><input type="checkbox" id="autostart" /> ligado</label></div>
    </div>
    <div class="dv-bar sp hidden" id="sprites-bar-start"><i style="width:0%"></i></div>
    <div class="row"><button class="dv-btn go" id="onboard-done">Pronto, vamos lá!</button>
    <span class="muted">Dá para voltar aqui quando quiser pelo hexágono ▶ do Digivice.</span></div>
  </div>
</section>

<section data-page="digimon">
  <div class="battle" id="battle"></div>
  <div class="dv-panel">
    <div class="dv-label">Linha evolutiva</div>
    <div id="lines" class="lines"></div>
  </div>
  <div class="dv-panel grid">
    <label><span class="dv-label">Apelido</span><input id="nickname" placeholder="opcional" maxlength="24" /></label>
    <label><span class="dv-label">Estágio mostrado</span><select id="stage"></select></label>
    <label><span class="dv-label">Tamanho</span>
      <select id="scale"><option value="3">Pequeno</option><option value="4">Normal</option><option value="5">Grande</option><option value="6">Enorme</option></select>
    </label>
    <label class="check"><input type="checkbox" id="sounds" /> Sons em chiptune</label>
    <div class="row wide"><button class="dv-btn warn" id="resetxp">Zerar XP</button>
    <span class="muted">Tarefa concluída +10 · ferramenta +1 · pergunta respondida pelo balão +3</span></div>
  </div>
</section>

<section data-page="hooks">
  <div class="dv-panel">
    <div class="dv-label">Claude Code — hooks</div>
    <p id="hookstatus">…</p>
    <div class="row"><button class="dv-btn go" id="hookinstall">Ver prévia e instalar</button><button class="dv-btn" id="hookremove">Ver prévia e remover</button></div>
    <div id="preview" class="hidden">
      <p class="muted" id="previewpath"></p>
      <pre id="diff"></pre>
      <div class="row"><button class="dv-btn go" id="apply">Confirmar e gravar</button><button class="dv-btn" id="cancel">Cancelar</button></div>
    </div>
    <p class="muted">Backup datado do settings.json antes de gravar. Hooks de outras ferramentas (como o coucou) não são tocados. Com o Digitama fechado, o Claude Code segue normal.</p>
  </div>
  <div class="dv-panel">
    <div class="dv-label">Claude Code — uso do plano (barra de status, só no terminal)</div>
    <div id="usagebox"></div>
    <div class="row">
      <label class="check">Consultar a cada <select id="usagemin"><option value="0">nunca</option><option value="5">5 min</option><option value="10">10 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">1 hora</option></select></label>
      <button class="dv-btn" id="usagenow">Atualizar agora</button>
    </div>
    <p class="muted">Cada consulta é uma chamada mínima ao Claude Code (Haiku, sem ferramentas): ~1–2 mil tokens. Funciona também com a extensão do VS Code.</p>
    <p id="usagestatus" class="muted">…</p>
    <div class="row"><button class="dv-btn go" id="usageinstall">Ver prévia e ativar</button><button class="dv-btn" id="usageremove">Ver prévia e desativar</button></div>
    <div id="usagepreview" class="hidden">
      <p class="muted" id="usagepreviewpath"></p>
      <pre id="usagediff"></pre>
      <div class="row"><button class="dv-btn go" id="usageapply">Confirmar e gravar</button><button class="dv-btn" id="usagecancel">Cancelar</button></div>
    </div>
    <p class="muted">O Claude Code só entrega os limites do plano (janela de 5h e semanal) para o comando da barra de status. O Digitama ocupa esse lugar e continua rodando a barra que você já tinha (a do coucou, por exemplo) — ela segue aparecendo igual. Desativar devolve a anterior. Só funciona com login de assinatura (Pro/Max), não com chave de API.</p>
  </div>
  <div class="dv-panel">
    <div class="dv-label">OpenCode — plugin</div>
    <p id="ocstatus">…</p>
    <div class="row"><button class="dv-btn go" id="ocinstall">Ver prévia e instalar</button><button class="dv-btn" id="ocremove">Ver prévia e remover</button></div>
    <div id="ocpreview" class="hidden">
      <p class="muted" id="ocpreviewpath"></p>
      <pre id="ocdiff"></pre>
      <div class="row"><button class="dv-btn go" id="ocapply">Confirmar e gravar</button><button class="dv-btn" id="occancel">Cancelar</button></div>
    </div>
    <p class="muted">O plugin manda ao pet o fim das tarefas, as ferramentas e os pedidos de permissão do OpenCode (você pode permitir ou negar pelo balão). Reinicie o OpenCode depois de instalar.</p>
  </div>
</section>

<section data-page="chat">
  <div class="dv-panel grid">
    <label class="wide"><span class="dv-label">Quem responde no chat</span>
      <select id="provider"><option value="claude">Claude Code (sua assinatura claude.ai)</option><option value="opencode">OpenCode (qualquer provedor configurado nele)</option></select>
    </label>
    <label class="check wide"><input type="checkbox" id="persona" /> Responder no papel do Digimon</label>
  </div>
  <div class="dv-panel">
    <div class="dv-label">OpenCode</div>
    <p id="ocinfo">…</p>
    <div class="grid">
      <label class="wide"><span class="dv-label">Caminho do opencode.exe</span><input id="ocpath" placeholder="detectar automaticamente" /></label>
      <label class="wide"><span class="dv-label">Modelo (provedor/modelo)</span><input id="ocmodel" list="ocmodels" placeholder="padrão do OpenCode" /><datalist id="ocmodels"></datalist></label>
    </div>
    <div class="row"><button class="dv-btn" id="ocloadmodels">Carregar modelos</button><span class="muted" id="ocmodelsinfo"></span></div>
  </div>
  <div class="dv-panel">
    <div class="dv-label">Claude Code</div>
    <p id="claudeinfo">…</p>
    <div class="grid">
      <label class="wide"><span class="dv-label">Caminho do claude.exe</span><input id="claudepath" placeholder="detectar automaticamente" /></label>
      <label><span class="dv-label">Modelo</span><input id="model" placeholder="padrão (sonnet, opus…)" /></label>
      <label><span class="dv-label">Ferramentas liberadas</span><input id="tools" /></label>
      <label class="check"><input type="checkbox" id="oauth" /> Forçar login OAuth</label>
    </div>
    <p class="muted">O chat roda o seu Claude Code logado (assinatura claude.ai, sem chave de API), com os mesmos MCPs e conectores. Para liberar um MCP, adicione <code>mcp__servidor</code> às ferramentas.</p>
  </div>
</section>

<section data-page="mcp">
  <div class="dv-panel">
    <p>Registra o pet como servidor MCP no Claude Code. Ferramentas: <code>screenshot</code>, <code>pet_say</code>, <code>pet_attack</code>, <code>pet_status</code>.</p>
    <pre id="mcpcmd"></pre>
    <div class="row"><button class="dv-btn" id="mcpcopy">Copiar comando</button><button class="dv-btn go" id="mcpinstall">Registrar agora</button></div>
    <p id="mcpout" class="muted"></p>
  </div>
  <div class="dv-panel">
    <p>O mesmo servidor no OpenCode v2 (config global, <code>mcp.servers.digitama</code>).</p>
    <pre id="ocmcpcmd"></pre>
    <div class="row"><button class="dv-btn" id="ocmcpcopy">Copiar comando</button><button class="dv-btn go" id="ocmcpinstall">Registrar no OpenCode</button></div>
    <p id="ocmcpout" class="muted"></p>
  </div>
</section>

<section data-page="snip">
  <div class="dv-panel">
    <p>A captura funciona como o Lightshot: a tela congela, você arrasta a área, anota e escolhe <b>copiar</b>, <b>salvar</b> (em Imagens\\Digitama) ou <b>perguntar ao Claude</b>.</p>
    <label class="check"><input type="checkbox" id="prtsc" /> Usar a tecla Print Screen (vale ao reabrir o Digitama)</label>
    <p class="muted">Sempre disponível também em Ctrl+Alt+Shift+P, no menu do pet e no botão 📷 do chat. Na captura: Ctrl+C copia, Ctrl+S salva, Ctrl+Enter manda ao Claude, Ctrl+Z desfaz, duplo clique copia, Esc sai.</p>
    <div class="row"><button class="dv-btn go" id="snipnow">Capturar agora</button></div>
  </div>
</section>

<section data-page="sprites">
  <div class="dv-panel">
    <p id="spritestatus">…</p>
    <p>Os sprites reais (Digimon World DS) são baixados do Wikimon para a sua pasta local na primeira abertura.</p>
    <div class="dv-bar sp hidden" id="sprites-bar"><i style="width:0%"></i></div>
    <div class="row"><button class="dv-btn go" id="spritesdl">Baixar o que falta</button><button class="dv-btn" id="spritesforce">Baixar tudo de novo</button><span class="muted" id="spritesprog"></span></div>
    <p class="muted">Para trocar um sprite, coloque um PNG em <code>sprites\\&lt;id&gt;\\idle.png</code> (ou <code>attack.png</code>, <code>hit.png</code>), ou <code>sprites\\&lt;id&gt;.png</code>. Uso pessoal: não distribua os sprites oficiais.</p>
    <div class="row"><button class="dv-btn" id="sprites">Abrir pasta de sprites</button></div>
  </div>
</section>

<section data-page="keys">
  <div class="dv-panel keys">
    <div><b>Ctrl+Alt+Shift+D</b><span>abre o chat com o Claude</span></div>
    <div><b>Print Screen</b><span>captura estilo Lightshot</span></div>
    <div><b>Ctrl+Alt+Shift+P</b><span>captura (alternativa)</span></div>
    <div><b>Clique no pet</b><span>cutuca · 5 rápidos = tonto</span></div>
    <div><b>Duplo clique</b><span>ataque especial</span></div>
    <div><b>Botão direito</b><span>menu circular do Digivice</span></div>
    <div><b>Arrastar</b><span>move o pet</span></div>
  </div>
</section>

<section data-page="about">
  <div class="dv-panel">
    <p>Digitama — pet de área de trabalho que acompanha o Claude Code.</p>
    <p class="muted">Digimon e nomes relacionados são © Bandai / Toei Animation; projeto pessoal de fã, sem fins comerciais. Sprites do Digimon World DS via Wikimon, usados localmente. Relay de hooks, pipe e instalador adaptados do Coucou (MIT, © Louis Raillé).</p>
  </div>
</section>`;

let current = "start";
function show(id: string) {
  current = id;
  document.querySelectorAll<HTMLElement>("#pages section").forEach((s) => s.classList.toggle("hidden", s.dataset.page !== id));
  document.querySelectorAll<HTMLElement>(".dial-item").forEach((b) => b.classList.toggle("on", b.dataset.section === id));
  const s = SECTIONS.find((x) => x.id === id)!;
  $("#head").textContent = s.title;
  $("#dial-label").textContent = s.title;
  const page = document.querySelector<HTMLElement>(`#pages section[data-page="${id}"]`)!;
  page.classList.remove("enter");
  void page.offsetWidth;
  page.classList.add("enter");
}

// ── Digimon ──────────────────────────────────────────────────────────────────

function save(patch: Partial<PetState>) {
  void api.patch(patch);
}

function renderBattle() {
  const m = monFor(state.line, state.currentStage);
  const s = stageForXp(state.xp);
  const lo = XP_STAGES[s], hi = XP_STAGES[s + 1];
  const pct = hi ? ((state.xp - lo) / (hi - lo)) * 100 : 100;
  const box = $("#battle");
  box.innerHTML = `
    <div class="b-portrait"><canvas width="72" height="72"></canvas></div>
    <div class="b-info">
      <div class="b-name"></div>
      <div class="b-row"><span class="dv-label">Lv.</span><b class="b-lv">${state.currentStage}</b>
        <span class="dv-label">EXP</span><div class="dv-bar"><i style="width:${pct}%"></i></div><b>${state.xp}${hi ? "/" + hi : ""}</b></div>
      <div class="b-row"><span class="dv-label">Tipo</span><span class="b-meta"></span></div>
      <div class="b-usage"></div>
    </div>`;
  box.querySelector(".b-usage")!.replaceWith(usageBlock(usage));
  box.querySelector(".b-name")!.textContent = `${state.nickname ? state.nickname + " · " : ""}${m.name} — ${STAGES[m.stage]}`;
  box.querySelector(".b-meta")!.textContent = `${m.attribute} · ${m.type} · ${m.attack}`;
  const c = box.querySelector("canvas")!;
  drawMonFit(c.getContext("2d")!, m.id, 36, 70, 68, 68);
  $("#wallet-xp").textContent = String(state.xp);
  $("#wallet-tasks").textContent = String(state.tasksDone);
}

function renderLines() {
  const box = $("#lines");
  box.replaceChildren();
  for (const id of Object.keys(LINES) as LineId[]) {
    const line = LINES[id];
    const card = document.createElement("button");
    card.className = `line ${state.line === id ? "on" : ""}`;
    const c = document.createElement("canvas");
    c.width = 456;
    c.height = 64;
    const g = c.getContext("2d")!;
    line.mons.forEach((m, i) => {
      if (i === 0) return;
      drawMonFit(g, m.id, 38 + (i - 1) * 76, 62, 72, 60);
    });
    const title = document.createElement("span");
    title.className = "dv-label";
    title.textContent = line.title;
    card.append(title, c);
    card.onclick = () => state.line !== id && save({ line: id, stageLock: null });
    box.append(card);
  }
}

function render() {
  renderBattle();
  renderLines();
  $<HTMLInputElement>("#nickname").value = state.nickname;
  const sel = $<HTMLSelectElement>("#stage");
  sel.replaceChildren(new Option(`Automático pela XP (${STAGES[stageForXp(state.xp)]})`, ""));
  STAGES.forEach((name, i) => sel.append(new Option(`${name} — ${monFor(state.line, i).name}`, String(i))));
  sel.value = state.stageLock == null ? "" : String(state.stageLock);
  $<HTMLSelectElement>("#scale").value = String(state.scale);
  $<HTMLInputElement>("#sounds").checked = state.sounds;
  $<HTMLInputElement>("#claudepath").value = state.claudePath;
  $<HTMLInputElement>("#model").value = state.model;
  $<HTMLInputElement>("#tools").value = state.allowedTools;
  $<HTMLInputElement>("#persona").checked = state.personaChat;
  $<HTMLInputElement>("#oauth").checked = state.forceOauth;
  $<HTMLInputElement>("#prtsc").checked = state.printScreenKey;
  $<HTMLSelectElement>("#usagemin").value = String(state.usageRefreshMin);
  $<HTMLSelectElement>("#provider").value = state.chatProvider;
  $<HTMLInputElement>("#ocpath").value = state.opencodePath;
  $<HTMLInputElement>("#ocmodel").value = state.opencodeModel;
  const ids = Object.values(LINES).flatMap((l) => l.mons.slice(1).map((m) => m.id));
  const have = ids.filter(hasPack).length;
  $("#spritestatus").textContent = `${have} de ${ids.length} Digimon com sprite real carregado${have < ids.length ? " — os outros usam o desenho em código." : "."}`;
}

const bind = (sel: string, ev: string, fn: (el: any) => void) => $(sel).addEventListener(ev, (e) => fn(e.target));
bind("#nickname", "change", (el) => save({ nickname: el.value.trim() }));
bind("#stage", "change", (el) => save({ stageLock: el.value === "" ? null : Number(el.value) }));
bind("#scale", "change", (el) => save({ scale: Number(el.value) }));
bind("#sounds", "change", (el) => save({ sounds: el.checked }));
bind("#claudepath", "change", (el) => {
  save({ claudePath: el.value.trim() });
  window.setTimeout(refreshClaude, 300);
});
bind("#model", "change", (el) => save({ model: el.value.trim() }));
bind("#tools", "change", (el) => save({ allowedTools: el.value.trim() }));
bind("#persona", "change", (el) => save({ personaChat: el.checked }));
bind("#oauth", "change", (el) => save({ forceOauth: el.checked }));
bind("#prtsc", "change", (el) => save({ printScreenKey: el.checked }));
bind("#provider", "change", (el) => save({ chatProvider: el.value }));
bind("#ocpath", "change", (el) => {
  save({ opencodePath: el.value.trim() });
  window.setTimeout(refreshOpencode, 300);
});
bind("#ocmodel", "change", (el) => save({ opencodeModel: el.value.trim() }));
bind("#autostart", "change", async (el) => {
  try {
    el.checked = await api.autostartSet(el.checked);
  } catch (e) {
    alert(`Não consegui mudar a inicialização: ${e}`);
  }
});
$("#onboard-done").onclick = () => {
  save({ onboarded: true });
  show("digimon");
};
document.querySelectorAll<HTMLElement>("[data-goto]").forEach((b) => (b.onclick = () => show(b.dataset.goto!)));

// ── OpenCode ─────────────────────────────────────────────────────────────────

let ocPending: boolean | null = null;

async function refreshOpencode() {
  const st = await api.opencodeStatus();
  const where = st.found ? `✅ ${st.version ?? "OpenCode"} — ${st.found}` : "⚪ OpenCode não encontrado (instale com npm i -g opencode-ai, ou informe o caminho).";
  $("#ocinfo").textContent = where;
  $("#ocstatus").textContent = st.foreign
    ? `⚠️ ${st.path} existe e não é do Digitama — não vou mexer.`
    : st.installed
      ? `✅ Plugin instalado${st.upToDate ? "" : " (desatualizado: instale de novo)"} em ${st.path}`
      : `⚪ Plugin não instalado. ${st.found ? "" : "(OpenCode não encontrado nesta máquina)"}`;
  $("#ck-oc").className = `dot ${st.found ? (st.installed ? "on" : "half") : ""}`;
  $("#ck-oc-text").textContent = st.found ? (st.installed ? "conectado ao pet" : "encontrado — falta instalar o plugin") : "não encontrado (opcional)";
}

function colorInto(pre: HTMLElement, diff: string) {
  pre.replaceChildren(
    ...diff.split("\n").map((l) => {
      const span = document.createElement("span");
      span.className = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
      span.textContent = l + "\n";
      return span;
    }),
  );
}

async function ocPreview(install: boolean) {
  try {
    const diff = await api.opencodePluginPreview(install);
    ocPending = install;
    $("#ocpreviewpath").textContent = diff.trim() ? (install ? "Arquivo do plugin:" : "Será removido:") : "Nada a mudar.";
    colorInto($("#ocdiff"), diff || "(sem diferenças)");
    $<HTMLButtonElement>("#ocapply").disabled = !diff.trim();
    $("#ocpreview").classList.remove("hidden");
  } catch (e) {
    alert(String(e));
  }
}
$("#ocinstall").onclick = () => void ocPreview(true);
$("#ocremove").onclick = () => void ocPreview(false);
$("#occancel").onclick = () => $("#ocpreview").classList.add("hidden");
$("#ocapply").onclick = async () => {
  if (ocPending === null) return;
  try {
    const path = await api.opencodePluginApply(ocPending);
    $("#ocpreview").classList.add("hidden");
    $("#ocstatus").textContent = `${ocPending ? "Instalado" : "Removido"}: ${path}. Reinicie o OpenCode.`;
    window.setTimeout(refreshOpencode, 800);
  } catch (e) {
    alert(String(e));
  }
};
$("#ocloadmodels").onclick = async () => {
  $("#ocmodelsinfo").textContent = "carregando…";
  try {
    const models = await api.opencodeModels();
    $("#ocmodels").replaceChildren(...models.map((m) => new Option(m, m)));
    $("#ocmodelsinfo").textContent = `${models.length} modelos — digite ou escolha no campo acima`;
  } catch (e) {
    $("#ocmodelsinfo").textContent = `Falhou: ${e}`;
  }
};

// ── Uso do Claude ────────────────────────────────────────────────────────────

let usagePending: { install: boolean; fingerprint: string } | null = null;

async function refreshUsage() {
  const on = await api.usageBarStatus();
  $("#usagestatus").textContent = on ? "✅ Ativo: o pet recebe o uso a cada resposta do Claude Code." : "⚪ Inativo.";
  $("#usagebox").replaceChildren(usageBlock(usage));
}
async function usagePreview(install: boolean) {
  try {
    const p = await api.usageBarPreview(install);
    usagePending = { install, fingerprint: p.fingerprint };
    $("#usagepreviewpath").textContent = p.changes ? `Alterações em ${p.settingsPath}:` : "Nada a mudar.";
    colorInto($("#usagediff"), p.diff || "(sem diferenças)");
    $<HTMLButtonElement>("#usageapply").disabled = !p.changes;
    $("#usagepreview").classList.remove("hidden");
  } catch (e) {
    alert(String(e));
  }
}
$<HTMLSelectElement>("#usagemin").onchange = (e) => save({ usageRefreshMin: Number((e.target as HTMLSelectElement).value) });
$("#usagenow").onclick = async () => {
  $("#usagenow").textContent = "consultando…";
  try {
    const u = await api.usageRefresh();
    if (!u) alert("Não veio o uso: o Claude Code está logado com uma assinatura (Pro/Max)?");
  } finally {
    $("#usagenow").textContent = "Atualizar agora";
  }
};
$("#usageinstall").onclick = () => void usagePreview(true);
$("#usageremove").onclick = () => void usagePreview(false);
$("#usagecancel").onclick = () => $("#usagepreview").classList.add("hidden");
$("#usageapply").onclick = async () => {
  if (!usagePending) return;
  try {
    const backup = await api.usageBarApply(usagePending.install, usagePending.fingerprint);
    $("#usagepreview").classList.add("hidden");
    $("#usagestatus").textContent = `Gravado.${backup ? ` Backup: ${backup}` : ""}`;
    window.setTimeout(refreshUsage, 1200);
  } catch (e) {
    alert(String(e));
  }
};

// ── Sprites ──────────────────────────────────────────────────────────────────

async function refreshSprites() {
  const missing = await api.spritesMissing();
  $("#ck-sprites").className = `dot ${missing === 0 ? "on" : ""}`;
  $("#ck-sprites-text").textContent = missing === 0 ? "todos baixados" : `faltam ${missing} arquivos`;
}
async function downloadSprites(force: boolean) {
  for (const id of ["#sprites-bar", "#sprites-bar-start"]) $(id).classList.remove("hidden");
  try {
    const r = await api.spritesDownload(force);
    $("#spritesprog").textContent = `${r.downloaded} baixados${r.failed ? `, ${r.failed} falharam (sem internet?)` : ""}`;
  } catch (e) {
    $("#spritesprog").textContent = `Falhou: ${e}`;
  }
}
$("#spritesdl").onclick = () => void downloadSprites(false);
$("#spritesforce").onclick = () => void downloadSprites(true);
$("#ck-sprites-btn").onclick = () => void downloadSprites(false);
$("#sprites").onclick = () => void api.openSpritesFolder();
$("#snipnow").onclick = () => void api.snipOpen();
$("#resetxp").onclick = () => {
  if (confirm("Zerar a XP? O Digimon volta a ser um Digitama.")) save({ xp: 0, stageLock: null });
};

// ── Hooks ────────────────────────────────────────────────────────────────────

let pending: { install: boolean; fingerprint: string } | null = null;

async function refreshHooks() {
  const s = await api.hooksStatus();
  $("#hookstatus").textContent = `${s.installed ? "✅ Instalados" : "⚪ Não instalados"} em ${s.settingsPath}${s.hookReady ? "" : " · ⚠️ relay não encontrado (rode npm run hook)"}`;
  const info = await api.claudeInfo();
  $("#ck-claude").className = `dot ${info.path ? (s.installed ? "on" : "half") : ""}`;
  $("#ck-claude-text").textContent = info.path
    ? s.installed
      ? `${info.version ?? "instalado"} — conectado ao pet`
      : `${info.version ?? "encontrado"} — falta instalar os hooks`
    : "não encontrado (opcional)";
}

function colorDiff(diff: string) {
  const pre = $("#diff");
  pre.replaceChildren(
    ...diff.split("\n").map((l) => {
      const span = document.createElement("span");
      span.className = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
      span.textContent = l + "\n";
      return span;
    }),
  );
}

async function preview(install: boolean) {
  try {
    const p = await api.hooksPreview(install);
    pending = { install, fingerprint: p.fingerprint };
    $("#previewpath").textContent = p.changes ? `Alterações em ${p.settingsPath}:` : "Nada a mudar.";
    colorDiff(p.diff || "(sem diferenças)");
    $<HTMLButtonElement>("#apply").disabled = !p.changes;
    $("#preview").classList.remove("hidden");
  } catch (e) {
    alert(String(e));
  }
}

$("#hookinstall").onclick = () => void preview(true);
$("#hookremove").onclick = () => void preview(false);
$("#cancel").onclick = () => $("#preview").classList.add("hidden");
$("#apply").onclick = async () => {
  if (!pending) return;
  try {
    const backup = await api.hooksApply(pending.install, pending.fingerprint);
    $("#preview").classList.add("hidden");
    $("#hookstatus").textContent = `Gravado.${backup ? ` Backup: ${backup}` : ""}`;
    window.setTimeout(refreshHooks, 1500);
  } catch (e) {
    alert(String(e));
  }
};

// ── Chat e MCP ───────────────────────────────────────────────────────────────

async function refreshClaude() {
  const info = await api.claudeInfo();
  $("#claudeinfo").textContent = info.path ? `✅ ${info.version ?? "Claude Code"} — ${info.path}` : "⚠️ claude.exe não encontrado. Instale o Claude Code e faça login (claude → /login).";
}

$("#mcpcopy").onclick = () => void navigator.clipboard.writeText($("#mcpcmd").textContent ?? "");
$("#mcpinstall").onclick = async () => {
  if (!confirm(`Rodar este comando?\n\n${$("#mcpcmd").textContent}\n\nEle adiciona o servidor "digitama" à configuração do Claude Code (escopo do usuário).`)) return;
  try {
    $("#mcpout").textContent = (await api.mcpInstall()) || "Registrado.";
  } catch (e) {
    $("#mcpout").textContent = `Falhou: ${e}`;
  }
};
$("#ocmcpcopy").onclick = () => void navigator.clipboard.writeText($("#ocmcpcmd").textContent ?? "");
$("#ocmcpinstall").onclick = async () => {
  if (!confirm(`Rodar este comando?\n\n${$("#ocmcpcmd").textContent}\n\nEle adiciona o servidor "digitama" à configuração global do OpenCode.`)) return;
  try {
    $("#ocmcpout").textContent = (await api.opencodeMcpInstall()) || "Registrado.";
  } catch (e) {
    $("#ocmcpout").textContent = `Falhou: ${e}`;
  }
};

// ── O Digimon animado no centro do Digivice ──────────────────────────────────

const monCanvas = $<HTMLCanvasElement>("#mon");
const mg = monCanvas.getContext("2d")!;
function animate(now: number) {
  if (state) {
    const m = monFor(state.line, state.currentStage);
    const t = now / 1000;
    const pose: Pose = Math.floor(t / 2.4) % 4 === 3 ? "attack" : "idle";
    mg.clearRect(0, 0, monCanvas.width, monCanvas.height);
    // cabe inteiro na área útil do mostrador (os Supremos chegam a 152 px de alto)
    const raw = monBox(m.id, 1);
    const scale = Math.max(1, Math.floor(Math.min(200 / raw.w, 190 / raw.h)));
    const cx = monCanvas.width / 2;
    const base = monCanvas.height - 12;
    mg.fillStyle = "rgba(0,0,0,0.3)";
    mg.fillRect(cx - raw.w * scale * 0.3, base - 2, raw.w * scale * 0.6, 4);
    drawMon(mg, m.id, { x: cx, y: base - Math.abs(Math.sin(t * 2)) * 4, scale, pose, sy: 1 + Math.sin(t * 2.4) * 0.02 });
  }
  requestAnimationFrame(animate);
}

async function boot() {
  state = await api.state();
  try {
    usage = await api.usageGet();
  } catch {
    /* sem uso ainda */
  }
  try {
    await loadPacks(await api.customSprites());
  } catch {
    /* sem sprites reais */
  }
  render();
  show(state.onboarded ? "digimon" : "start");
  requestAnimationFrame(animate);
  void refreshHooks();
  void refreshClaude();
  void refreshOpencode();
  void refreshUsage();
  await listen<Usage>("usage", (e) => {
    usage = e.payload;
    renderBattle();
    $("#usagebox").replaceChildren(usageBlock(usage));
  });
  void refreshSprites();
  try {
    $<HTMLInputElement>("#autostart").checked = await api.autostartGet();
  } catch {
    /* sem suporte */
  }
  await listen<{ done: number; total: number; current: string }>("sprites-progress", (e) => {
    const pct = `${(e.payload.done / e.payload.total) * 100}%`;
    for (const id of ["#sprites-bar", "#sprites-bar-start"]) {
      $(id).classList.remove("hidden");
      ($(id).firstElementChild as HTMLElement).style.width = pct;
    }
    $("#spritesprog").textContent = `${e.payload.done}/${e.payload.total} · ${e.payload.current}`;
    $("#ck-sprites-text").textContent = `baixando ${e.payload.done}/${e.payload.total}…`;
  });
  await listen("sprites-ready", async () => {
    try {
      await loadPacks(await api.customSprites());
    } catch {
      /* fica o desenho em código */
    }
    render();
    void refreshSprites();
  });
  $("#mcpcmd").textContent = await api.mcpCommand();
  $("#ocmcpcmd").textContent = await api.opencodeMcpCommand();
  await listen<PetState>("state-changed", (e) => {
    state = e.payload;
    render();
  });
}

void boot();
