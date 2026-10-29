// Recorte estilo Lightshot, com cara de Digivice: a tela fica congelada e
// escurecida, você arrasta a seleção, anota (lápis, linha, seta, retângulo,
// marca-texto, texto) e escolhe: copiar, salvar ou mandar para o Claude.
import "../shared/digivice.css";
import "./snip.css";
import { listen } from "@tauri-apps/api/event";
import { api, type Shot } from "../shared/api";
import { iconImg } from "../shared/icons";

type Tool = "pen" | "line" | "arrow" | "rect" | "marker" | "text";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Mark {
  tool: Tool;
  color: string;
  pts: [number, number][];
  text?: string;
}

const COLORS = ["#ff3b3b", "#ffd23f", "#3dff8a", "#3fe0ff", "#4d6bff", "#c48bff", "#ffffff", "#0b0820"];
// A janela é criada uma vez, escondida, e reaproveitada a cada captura (criar
// uma WebView demora): o tamanho muda conforme o monitor.
let W = window.innerWidth;
let H = window.innerHeight;

const canvas = document.createElement("canvas");
document.body.appendChild(canvas);
const g = canvas.getContext("2d")!;

function fitCanvas() {
  W = window.innerWidth;
  H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitCanvas();

const hud = document.createElement("div");
hud.className = "hud";
hud.innerHTML = `<div class="dv-banner">DIGIVICE · CAPTURA</div><div class="hint">Arraste para recortar · Esc para sair</div>`;
const sizeTag = document.createElement("div");
sizeTag.className = "size-tag hidden";
const tools = document.createElement("div");
tools.className = "toolbar vertical hidden";
const actions = document.createElement("div");
actions.className = "toolbar horizontal hidden";
const palette = document.createElement("div");
palette.className = "palette hidden";
const toast = document.createElement("div");
toast.className = "toast hidden";
document.body.append(hud, sizeTag, tools, actions, palette, toast);

let img: HTMLImageElement | null = null;
let shot: Shot | null = null;
let sel: Rect | null = null;
let tool: Tool | null = null;
let color = COLORS[0];
let marks: Mark[] = [];
let drawing: Mark | null = null;
let mouse = { x: W / 2, y: H / 2 };
let drag: { kind: "new" | "move" | "resize"; ox: number; oy: number; start: Rect; handle?: number } | null = null;
let scanY = 0;
let busy = false;

// ── Desenho ──────────────────────────────────────────────────────────────────

function norm(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
}

function handles(r: Rect): [number, number][] {
  const { x, y, w, h } = r;
  return [
    [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
    [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
  ];
}

function drawMark(ctx: CanvasRenderingContext2D, m: Mark) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  const [a, b] = [m.pts[0], m.pts[m.pts.length - 1]];
  switch (m.tool) {
    case "pen":
    case "marker":
      ctx.lineWidth = m.tool === "pen" ? 3 : 16;
      if (m.tool === "marker") ctx.globalAlpha = 0.38;
      ctx.beginPath();
      m.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      break;
    case "line":
    case "arrow": {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      if (m.tool === "arrow") {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const len = 16;
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45));
        ctx.lineTo(b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "rect":
      ctx.lineWidth = 3;
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      break;
    case "text":
      ctx.font = "26px VT323, monospace";
      ctx.textBaseline = "top";
      ctx.lineWidth = 4;
      ctx.strokeStyle = m.color === "#0b0820" ? "#ffffff" : "#0b0820";
      ctx.strokeText(m.text ?? "", a[0], a[1]);
      ctx.fillText(m.text ?? "", a[0], a[1]);
      break;
  }
  ctx.restore();
}

function bracket(x: number, y: number, dx: number, dy: number) {
  g.fillStyle = "#ffd23f";
  g.fillRect(x, y, 14 * dx, 4 * dy);
  g.fillRect(x, y, 4 * dx, 14 * dy);
}

function draw() {
  g.clearRect(0, 0, W, H);
  if (img) g.drawImage(img, 0, 0, W, H);
  // escurecimento azul com linhas de varredura, fora da seleção
  g.save();
  g.beginPath();
  g.rect(0, 0, W, H);
  if (sel && sel.w > 0 && sel.h > 0) g.rect(sel.x + sel.w, sel.y, -sel.w, sel.h);
  g.clip("evenodd");
  g.fillStyle = "rgba(4, 12, 40, 0.62)";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(63, 224, 255, 0.05)";
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  g.restore();

  // varredura de entrada
  if (scanY < H) {
    g.fillStyle = "rgba(63, 224, 255, 0.85)";
    g.fillRect(0, scanY, W, 3);
    g.fillStyle = "rgba(63, 224, 255, 0.15)";
    g.fillRect(0, scanY - 40, W, 40);
  }

  for (const m of marks) drawMark(g, m);
  if (drawing) drawMark(g, drawing);

  if (sel && sel.w > 0) {
    const { x, y, w, h } = sel;
    g.strokeStyle = "#3fe0ff";
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.lineDashOffset = -performance.now() / 60;
    g.strokeRect(x + 0.5, y + 0.5, w, h);
    g.setLineDash([]);
    bracket(x - 3, y - 3, 1, 1);
    bracket(x + w + 3, y - 3, -1, 1);
    bracket(x - 3, y + h + 3, 1, -1);
    bracket(x + w + 3, y + h + 3, -1, -1);
    if (!tool) {
      g.fillStyle = "#bff4ff";
      for (const [hx, hy] of handles(sel)) {
        g.fillRect(hx - 4, hy - 4, 8, 8);
        g.strokeStyle = "#0b2a7a";
        g.strokeRect(hx - 4, hy - 4, 8, 8);
      }
    }
  } else {
    // mira com coordenadas
    g.strokeStyle = "rgba(63, 224, 255, 0.55)";
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(0, mouse.y + 0.5);
    g.lineTo(W, mouse.y + 0.5);
    g.moveTo(mouse.x + 0.5, 0);
    g.lineTo(mouse.x + 0.5, H);
    g.stroke();
    g.setLineDash([]);
    const ratio = shot ? shot.width / W : 1;
    const label = `${Math.round(mouse.x * ratio)}, ${Math.round(mouse.y * ratio)}`;
    g.font = "8px Digivice, 'Press Start 2P'";
    const tw = g.measureText(label).width;
    g.fillStyle = "#0b2a7a";
    g.fillRect(mouse.x + 12, mouse.y + 12, tw + 12, 18);
    g.fillStyle = "#bff4ff";
    g.fillText(label, mouse.x + 18, mouse.y + 25);
  }
}

/** O aviso fica no alto do monitor do cursor (no meio do print caía na emenda). */
function placeHud() {
  const m = shot?.monitor;
  if (!m || !shot) {
    hud.style.left = "50%";
    hud.style.top = "18px";
    return;
  }
  const k = W / shot.width;
  hud.style.left = `${(m[0] + m[2] / 2) * k}px`;
  hud.style.top = `${m[1] * k + 18}px`;
  mouse = { x: (m[0] + m[2] / 2) * k, y: (m[1] + m[3] / 2) * k };
}

function layout() {
  const has = !!sel && sel.w > 4 && sel.h > 4 && !drag;
  tools.classList.toggle("hidden", !has);
  actions.classList.toggle("hidden", !has);
  sizeTag.classList.toggle("hidden", !sel || sel.w < 2);
  hud.classList.toggle("faded", !!sel);
  if (!sel) return;
  const ratio = shot ? shot.width / W : 1;
  sizeTag.textContent = `${Math.round(sel.w * ratio)} × ${Math.round(sel.h * ratio)}`;
  sizeTag.style.left = `${sel.x}px`;
  sizeTag.style.top = `${Math.max(4, sel.y - 28)}px`;
  if (!has) {
    palette.classList.add("hidden");
    return;
  }
  const tw = tools.offsetWidth, th = tools.offsetHeight;
  let tx = sel.x + sel.w + 12;
  if (tx + tw > W - 4) tx = sel.x - tw - 12;
  if (tx < 4) tx = W - tw - 4;
  tools.style.left = `${tx}px`;
  tools.style.top = `${Math.max(4, Math.min(H - th - 4, sel.y + sel.h - th))}px`;
  const aw = actions.offsetWidth, ah = actions.offsetHeight;
  let ay = sel.y + sel.h + 12;
  if (ay + ah > H - 4) ay = sel.y - ah - 36;
  if (ay < 4) ay = H - ah - 4;
  actions.style.left = `${Math.max(4, Math.min(W - aw - 4, sel.x + sel.w - aw))}px`;
  actions.style.top = `${ay}px`;
  palette.style.left = tools.style.left;
  palette.style.top = `${Math.max(4, parseFloat(tools.style.top) - palette.offsetHeight - 8)}px`;
}

// ── Barras de ferramentas ────────────────────────────────────────────────────

function hexButton(iconName: string, title: string, run: () => void, tint = "#ffd23f") {
  const b = document.createElement("button");
  b.className = "hex";
  b.title = title;
  b.append(iconImg(iconName, tint, 2));
  b.onclick = (e) => {
    e.stopPropagation();
    run();
  };
  b.onmousedown = (e) => e.stopPropagation();
  return b;
}

const toolButtons = new Map<Tool, HTMLButtonElement>();
const TOOLS: [Tool, string, string][] = [
  ["pen", "pen", "Lápis"],
  ["line", "line", "Linha"],
  ["arrow", "arrow", "Seta"],
  ["rect", "rect", "Retângulo"],
  ["marker", "marker", "Marca-texto"],
  ["text", "text", "Texto"],
];
for (const [t, ic, title] of TOOLS) {
  const b = hexButton(ic, title, () => setTool(tool === t ? null : t), "#bff4ff");
  toolButtons.set(t, b);
  tools.append(b);
}
const colorBtn = document.createElement("button");
colorBtn.className = "hex swatch";
colorBtn.title = "Cor";
colorBtn.onclick = (e) => {
  e.stopPropagation();
  palette.classList.toggle("hidden");
  layout();
};
colorBtn.onmousedown = (e) => e.stopPropagation();
tools.append(colorBtn, hexButton("undo", "Desfazer (Ctrl+Z)", undo, "#bff4ff"));

for (const c of COLORS) {
  const b = document.createElement("button");
  b.style.background = c;
  b.onclick = (e) => {
    e.stopPropagation();
    setColor(c);
    palette.classList.add("hidden");
  };
  b.onmousedown = (e) => e.stopPropagation();
  palette.append(b);
}

actions.append(
  hexButton("copy", "Copiar (Ctrl+C)", () => void finish("copy"), "#3fe0ff"),
  hexButton("save", "Salvar (Ctrl+S)", () => void finish("save"), "#3dff8a"),
  hexButton("send", "Perguntar ao Claude (Ctrl+Enter)", () => void finish("claude"), "#ffd23f"),
  hexButton("close", "Fechar (Esc)", close, "#ff4d5e"),
);

function setTool(t: Tool | null) {
  tool = t;
  for (const [k, b] of toolButtons) b.classList.toggle("on", k === t);
  canvas.style.cursor = t ? (t === "text" ? "text" : "crosshair") : "default";
  draw();
}

function setColor(c: string) {
  color = c;
  colorBtn.style.setProperty("--swatch", c);
}
setColor(color);

function undo() {
  marks.pop();
  draw();
}

// ── Mouse ────────────────────────────────────────────────────────────────────

function inside(r: Rect, x: number, y: number) {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

function placeText(x: number, y: number) {
  const input = document.createElement("input");
  input.className = "text-input";
  input.style.left = `${x}px`;
  input.style.top = `${y}px`;
  input.style.color = color;
  document.body.append(input);
  setTimeout(() => input.focus(), 0);
  const commit = () => {
    if (input.value.trim()) marks.push({ tool: "text", color, pts: [[x, y]], text: input.value });
    input.remove();
    draw();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit();
    if (e.key === "Escape") input.remove();
  };
  input.onblur = commit;
  input.onmousedown = (e) => e.stopPropagation();
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  palette.classList.add("hidden");
  const { clientX: x, clientY: y } = e;
  if (sel && tool && inside(sel, x, y)) {
    if (tool === "text") {
      placeText(x, y - 12);
      return;
    }
    drawing = { tool, color, pts: [[x, y]] };
    return;
  }
  if (sel && !tool) {
    const hi = handles(sel).findIndex(([hx, hy]) => Math.abs(hx - x) <= 7 && Math.abs(hy - y) <= 7);
    if (hi >= 0) {
      drag = { kind: "resize", ox: x, oy: y, start: { ...sel }, handle: hi };
      return;
    }
    if (inside(sel, x, y)) {
      drag = { kind: "move", ox: x, oy: y, start: { ...sel } };
      return;
    }
  }
  marks = [];
  setTool(null);
  sel = { x, y, w: 0, h: 0 };
  drag = { kind: "new", ox: x, oy: y, start: { ...sel } };
  layout();
});

window.addEventListener("mousemove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (drawing) {
    if (drawing.tool === "pen" || drawing.tool === "marker") drawing.pts.push([mouse.x, mouse.y]);
    else drawing.pts[1] = [mouse.x, mouse.y];
  } else if (drag && sel) {
    const dx = mouse.x - drag.ox, dy = mouse.y - drag.oy;
    const s = drag.start;
    if (drag.kind === "new") sel = norm({ x: s.x, y: s.y, w: dx, h: dy });
    else if (drag.kind === "move")
      sel = { ...s, x: Math.max(0, Math.min(W - s.w, s.x + dx)), y: Math.max(0, Math.min(H - s.h, s.y + dy)) };
    else {
      const h = drag.handle!;
      let { x, y, w, h: hh } = s;
      if ([0, 6, 7].includes(h)) { x += dx; w -= dx; }
      if ([2, 3, 4].includes(h)) w += dx;
      if ([0, 1, 2].includes(h)) { y += dy; hh -= dy; }
      if ([4, 5, 6].includes(h)) hh += dy;
      sel = norm({ x, y, w, h: hh });
    }
    layout();
  } else if (sel && !tool) {
    const hi = handles(sel).findIndex(([hx, hy]) => Math.abs(hx - mouse.x) <= 7 && Math.abs(hy - mouse.y) <= 7);
    const cursors = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];
    canvas.style.cursor = hi >= 0 ? cursors[hi] : inside(sel, mouse.x, mouse.y) ? "move" : "crosshair";
  }
  draw();
});

window.addEventListener("mouseup", () => {
  if (drawing) {
    if (drawing.pts.length > 1) marks.push(drawing);
    drawing = null;
  }
  if (drag) {
    drag = null;
    if (sel && (sel.w < 4 || sel.h < 4)) sel = null;
  }
  layout();
  draw();
});

// clique duplo na seleção: copia, como no Lightshot
canvas.addEventListener("dblclick", (e) => {
  if (sel && !tool && inside(sel, e.clientX, e.clientY)) void finish("copy");
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
  else if (e.ctrlKey && e.key.toLowerCase() === "c") void finish("copy");
  else if (e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void finish("save");
  } else if (e.ctrlKey && e.key.toLowerCase() === "z") undo();
  else if (e.ctrlKey && e.key === "Enter") void finish("claude");
});

// ── Saída ────────────────────────────────────────────────────────────────────

/** A seleção com as anotações, na resolução real da tela. */
function exportPng(): { png: string; width: number; height: number } | null {
  if (!img || !shot || !sel) return null;
  const r = shot.width / W;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sel.w * r));
  out.height = Math.max(1, Math.round(sel.h * r));
  const o = out.getContext("2d")!;
  o.drawImage(img, sel.x * r, sel.y * r, sel.w * r, sel.h * r, 0, 0, out.width, out.height);
  o.scale(r, r);
  o.translate(-sel.x, -sel.y);
  for (const m of marks) drawMark(o, m);
  return { png: out.toDataURL("image/png").split(",")[1], width: out.width, height: out.height };
}

function flashToast(text: string) {
  toast.textContent = text;
  toast.classList.remove("hidden");
}

async function finish(kind: "copy" | "save" | "claude") {
  if (busy) return;
  const res = exportPng();
  if (!res) return;
  busy = true;
  try {
    if (kind === "copy") {
      await api.copyPng(res.png);
      flashToast("COPIADO!");
    } else if (kind === "save") {
      const path = await api.savePng(res.png);
      flashToast(`SALVO! ${path}`);
    } else {
      await api.attachToChat(res.png, res.width, res.height);
      flashToast("ENVIADO AO CLAUDE!");
    }
    setTimeout(close, kind === "save" ? 1100 : 450);
  } catch (e) {
    flashToast(`ERRO: ${e}`);
    busy = false;
  }
}

function close() {
  // A janela só se esconde até o próximo Print: para de desenhar e solta o
  // print (um monitor 4K são ~33 MB decodificados, mais o canvas do tamanho da tela).
  const closing = ++loopId;
  void api.snipClose().then(() => {
    if (closing !== loopId) return; // um Print novo já chegou
    img = null;
    shot = null;
    marks = [];
    drawing = null;
    canvas.width = canvas.height = 0;
  });
}

// ── Início ───────────────────────────────────────────────────────────────────

let scanStart = performance.now();
/** O laço de desenho que vale; outro número (ou fechar) faz o antigo parar. */
let loopId = 0;

function startLoop() {
  const id = ++loopId;
  const tick = () => {
    if (id !== loopId) return;
    scanY = ((performance.now() - scanStart) / 380) * H;
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Carrega o print novo, zera a captura anterior e pede para mostrar a janela. */
async function load() {
  loopId++;
  const next = await api.snipImage();
  if (!next) return; // janela pré-criada: espera a primeira captura
  const image = new Image();
  image.src = `data:image/png;base64,${next.png}`;
  await image.decode();
  shot = next;
  img = image;
  sel = null;
  marks = [];
  drawing = null;
  drag = null;
  busy = false;
  setTool(null);
  document.querySelectorAll(".text-input").forEach((el) => el.remove());
  toast.classList.add("hidden");
  palette.classList.add("hidden");
  fitCanvas();
  mouse = { x: W / 2, y: H / 2 };
  placeHud();
  layout();
  scanStart = performance.now();
  draw();
  await api.snipReady();
  window.focus();
  startLoop();
}

window.addEventListener("resize", () => {
  fitCanvas();
  placeHud();
  layout();
  draw();
});

async function boot() {
  await document.fonts.load("8px Digivice").catch(() => {});
  await listen("snip-load", () => void load());
  await load();
}

void boot();
