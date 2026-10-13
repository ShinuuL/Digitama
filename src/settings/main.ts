// Configurações em forma de Digivice: um anel de hexágonos em volta do seu
// Digimon (animado no centro) e, ao lado, os painéis de cada seção.
import "../shared/digivice.css";
import "./settings.css";
import { listen } from "@tauri-apps/api/event";
import { api, type PetState } from "../shared/api";
import { iconImg } from "../shared/icons";
import { LINES, STAGES, XP_STAGES, monFor, stageForXp, type LineId } from "../shared/lore";
import { drawMon, drawMonFit, hasPack, loadPacks, monBox, type Pose } from "../pet/render";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
let state: PetState;

interface Section {
  id: string;
  icon: string;
  title: string;
  color: string;
}
const SECTIONS: Section[] = [
  { id: "digimon", icon: "egg", title: "Digimon", color: "#ffd23f" },
  { id: "hooks", icon: "hook", title: "Hooks", color: "#3dff8a" },
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
      <canvas id="mon" width="200" height="170"></canvas>
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
  b.append(iconImg(s.icon, s.color, 3));
  b.onclick = () => show(s.id);
  b.onmouseenter = () => ($("#dial-label").textContent = s.title);
  b.onmouseleave = () => ($("#dial-label").textContent = SECTIONS.find((x) => x.id === current)!.title);
  dial.append(b);
});

// ── Páginas ──────────────────────────────────────────────────────────────────

$("#pages").innerHTML = `
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
    <p id="hookstatus">…</p>
    <div class="row"><button class="dv-btn go" id="hookinstall">Ver prévia e instalar</button><button class="dv-btn" id="hookremove">Ver prévia e remover</button></div>
    <div id="preview" class="hidden">
      <p class="muted" id="previewpath"></p>
      <pre id="diff"></pre>
      <div class="row"><button class="dv-btn go" id="apply">Confirmar e gravar</button><button class="dv-btn" id="cancel">Cancelar</button></div>
    </div>
    <p class="muted">Backup datado do settings.json antes de gravar. Hooks de outras ferramentas (como o coucou) não são tocados. Com o Digitama fechado, o Claude Code segue normal.</p>
  </div>
</section>

<section data-page="chat">
  <div class="dv-panel">
    <p id="claudeinfo">…</p>
    <div class="grid">
      <label class="wide"><span class="dv-label">Caminho do claude.exe</span><input id="claudepath" placeholder="detectar automaticamente" /></label>
      <label><span class="dv-label">Modelo</span><input id="model" placeholder="padrão (sonnet, opus…)" /></label>
      <label><span class="dv-label">Ferramentas liberadas</span><input id="tools" /></label>
      <label class="check"><input type="checkbox" id="persona" /> Responder no papel do Digimon</label>
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
    <p>Os sprites reais (Digimon World DS) são baixados para a sua pasta local com:</p>
    <pre>node scripts/fetch-sprites.mjs</pre>
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

let current = "digimon";
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
    </div>`;
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

// ── O Digimon animado no centro do Digivice ──────────────────────────────────

const monCanvas = $<HTMLCanvasElement>("#mon");
const mg = monCanvas.getContext("2d")!;
function animate(now: number) {
  if (state) {
    const m = monFor(state.line, state.currentStage);
    const t = now / 1000;
    const pose: Pose = Math.floor(t / 2.4) % 4 === 3 ? "attack" : "idle";
    mg.clearRect(0, 0, monCanvas.width, monCanvas.height);
    const raw = monBox(m.id, 1);
    const scale = Math.max(1, Math.floor(Math.min(150 / raw.w, 130 / raw.h)));
    mg.fillStyle = "rgba(0,0,0,0.3)";
    mg.fillRect(100 - raw.w * scale * 0.3, 158, raw.w * scale * 0.6, 4);
    drawMon(mg, m.id, { x: 100, y: 160 - Math.abs(Math.sin(t * 2)) * 4, scale, pose, sy: 1 + Math.sin(t * 2.4) * 0.02 });
  }
  requestAnimationFrame(animate);
}

async function boot() {
  state = await api.state();
  try {
    await loadPacks(await api.customSprites());
  } catch {
    /* sem sprites reais */
  }
  render();
  show("digimon");
  requestAnimationFrame(animate);
  void refreshHooks();
  void refreshClaude();
  $("#mcpcmd").textContent = await api.mcpCommand();
  await listen<PetState>("state-changed", (e) => {
    state = e.payload;
    render();
  });
}

void boot();
