// A janela do pet: um canvas transparente sempre por cima, com o Digimon, os
// efeitos, o balão e um menu. Reage aos hooks do Claude Code, à música e a você.
import "../shared/digivice.css";
import "./pet.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type MediaState, type PetState } from "../shared/api";
import { LINES, STAGES, monFor, pick, stageForXp, type Mon } from "../shared/lore";
import { setSoundEnabled, sfx } from "../shared/sound";
import { Bubble, type Question } from "./bubble";
import { Fx } from "./fx";
import { drawMon, drawMonFit, drawGrid, loadPacks, monBox, monScale, type Pose } from "./render";
import { Ring } from "./ring";
import { EXCLAIM } from "./sprites";

const W = window.innerWidth;
const H = window.innerHeight;
const GROUND = H - 8;

const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
document.body.appendChild(canvas);
const g = canvas.getContext("2d")!;
g.imageSmoothingEnabled = false;

const bubble = new Bubble(document.body);
const fx = new Fx(W, H);

const musicBar = document.createElement("div");
musicBar.className = "music hidden";
document.body.appendChild(musicBar);
const ring = new Ring(document.body);

// ── Estado ───────────────────────────────────────────────────────────────────

let state: PetState;
let stage = 0; // estágio mostrado
let mon: Mon;
let media: MediaState | null = null;
let hover = false;
let chatBusy = false;
let working = false;
let workingSince = 0;
let lastActivity = performance.now();

let posX = 0; // deslocamento horizontal em relação ao centro
let walked = 0; // distância andada, para o ciclo de passos não "patinar"
let targetX = 0;
let facing = 1;
let nextWander = performance.now() + 5000;
let nextIdleLine = performance.now() + 25000;

/** Animação de uma vez só (sobrepõe o modo atual). */
interface OneShot {
  name: "attack" | "happy" | "hurt" | "poke" | "dizzy" | "evolve" | "hatch" | "alert";
  t0: number;
  dur: number;
  fired?: boolean;
  next?: number; // estágio novo (evolução)
}
let anim: OneShot | null = null;

function monId(m: Mon) {
  return m.id;
}

/** Escala do Digimon `id` (de qualquer estágio da linha atual). */
function scaleOf(id: string) {
  const st = Math.max(0, LINES[state.line].mons.findIndex((m) => m.id === id));
  return monScale(id, st, state?.scale ?? 4);
}

function targetStage() {
  return state.stageLock ?? stageForXp(state.xp);
}

function setStage(s: number) {
  stage = s;
  mon = monFor(state.line, stage);
  fx.px = ({ 3: 2, 4: 3, 5: 4, 6: 5 } as Record<number, number>)[state.scale] ?? 3;
  if (state.currentName !== mon.name || state.currentStage !== stage) {
    void api.patch({ currentName: mon.name, currentStage: stage });
  }
}

// ── Falas e ações ────────────────────────────────────────────────────────────

function say(text: string, ttl?: number) {
  bubble.show({ kind: "say", text, ttl });
}

function play(name: OneShot["name"], dur: number, extra: Partial<OneShot> = {}) {
  anim = { name, t0: performance.now(), dur, ...extra };
}

function attack(withBanner = true) {
  if (anim?.name === "evolve" || anim?.name === "hatch") return;
  play("attack", 1500);
  sfx.attack();
  if (withBanner && stage > 0) fx.say(mon.attack.toUpperCase() + "!", "#ffd23f");
}

function activity() {
  lastActivity = performance.now();
}

let saveTimer = 0;
function addXp(n: number, extra: Partial<PetState> = {}) {
  state.xp += n;
  Object.assign(state, extra);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.patch({ xp: state.xp, tasksDone: state.tasksDone, questionsAnswered: state.questionsAnswered });
  }, 800);
  checkEvolution();
}

function checkEvolution() {
  const want = targetStage();
  if (want === stage || anim?.name === "evolve" || anim?.name === "hatch") return;
  if (want === 1 && stage === 0) {
    play("hatch", 2600, { next: 1 });
    sfx.hatch();
  } else {
    play("evolve", 3400, { next: want });
    sfx.evolve();
  }
}

// ── Hooks do Claude Code ─────────────────────────────────────────────────────

interface HookPayload {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
  request_id?: string;
  digitama_internal?: boolean;
}

function summarize(tool: string, input: Record<string, unknown> = {}): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const text = s("command") || s("file_path") || s("url") || s("pattern") || s("query") || JSON.stringify(input);
  return text.length > 400 ? text.slice(0, 400) + "…" : text || tool;
}

function onHook(p: HookPayload) {
  const internal = !!p.digitama_internal;
  activity();
  switch (p.hook_event_name) {
    case "SessionStart":
      if (!internal) say(pick(mon.lines.greet));
      break;
    case "UserPromptSubmit":
      if (!internal) {
        working = true;
        workingSince = performance.now();
        bubble.clearWaiting();
      }
      break;
    case "PostToolUse":
      if (!internal) addXp(1);
      break;
    case "PostToolUseFailure":
      if (!internal) play("hurt", 500);
      break;
    case "Stop":
      bubble.clearWaiting();
      if (internal) {
        play("happy", 700);
        break;
      }
      working = false;
      attack();
      window.setTimeout(() => say(pick(mon.lines.done)), 1400);
      addXp(10, { tasksDone: state.tasksDone + 1 });
      break;
    case "StopFailure":
      working = false;
      play("hurt", 900);
      sfx.hurt();
      say("Ai… algo deu errado no Claude.");
      break;
    case "Notification": {
      const type = p.notification_type ?? "";
      const msg = p.message ?? "";
      if (type === "permission_prompt" || /permission/i.test(msg)) break; // o PermissionRequest cuida
      if (type === "idle_prompt" || /waiting for your input/i.test(msg)) {
        play("alert", 900);
        sfx.ask();
        bubble.show({ kind: "waiting", text: pick(mon.lines.ask), cwd: p.cwd });
      } else if (msg) {
        say(msg);
      }
      break;
    }
    case "PermissionRequest": {
      if (!p.request_id) break;
      void api.hookAck(p.request_id);
      attack(false);
      fx.say("!", "#ff5f5f", 1.2);
      sfx.ask();
      if (p.tool_name === "AskUserQuestion") {
        const questions = (p.tool_input?.questions as Question[] | undefined) ?? [];
        if (!questions.length) {
          void api.hookDecline(p.request_id);
          break;
        }
        bubble.show({ kind: "question", requestId: p.request_id, questions, cwd: p.cwd });
      } else {
        bubble.show({ kind: "permission", requestId: p.request_id, tool: p.tool_name ?? "Ferramenta", summary: summarize(p.tool_name ?? "", p.tool_input), cwd: p.cwd });
      }
      break;
    }
  }
}

bubble.onAnswered = (kind) => {
  if (kind === "question") addXp(3, { questionsAnswered: state.questionsAnswered + 1 });
  play("happy", 700);
  sfx.blip();
};

// ── Mouse: arrastar, cutucar, menu ───────────────────────────────────────────

let petBox: [number, number, number, number] = [0, 0, 0, 0];
let downAt: { x: number; y: number } | null = null;
const clicks: number[] = [];

function inPet(x: number, y: number) {
  const [bx, by, bw, bh] = petBox;
  return x >= bx - 6 && y >= by - 6 && x <= bx + bw + 6 && y <= by + bh + 6;
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !inPet(e.clientX, e.clientY)) return;
  downAt = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("mousemove", (e) => {
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) {
    downAt = null;
    void getCurrentWindow().startDragging();
  }
});
canvas.addEventListener("mouseup", (e) => {
  if (!downAt) return;
  downAt = null;
  if (!inPet(e.clientX, e.clientY)) return;
  hideMenu();
  activity();
  const now = performance.now();
  clicks.push(now);
  while (clicks.length && now - clicks[0] > 1600) clicks.shift();
  if (clicks.length >= 5) {
    clicks.length = 0;
    play("dizzy", 2200);
    sfx.hurt();
    say("@_@ … tudo girando…");
    return;
  }
  play("poke", 350);
  sfx.poke();
  if (Math.random() < 0.6) say(pick(mon.lines.poke));
  if (Math.random() < 0.3) fx.heart(W / 2 + posX, petBox[1]);
});
canvas.addEventListener("dblclick", (e) => {
  if (inPet(e.clientX, e.clientY)) attack();
});
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (inPet(e.clientX, e.clientY)) showMenu();
});

function showMenu() {
  const items: import("./ring").RingItem[] = [
    { icon: "chat", label: "Conversar", color: "#9fe6ff", run: () => void api.openWindow("chat") },
    { icon: "camera", label: "Print", color: "#ffffff", run: () => void api.snipOpen() },
    { icon: "sword", label: mon.attack, color: "#ff8a3d", run: () => attack() },
  ];
  if (media?.title) {
    items.push({ icon: media.playing ? "pause" : "play", label: media.playing ? "Pausar" : "Tocar", color: "#3dff8a", run: () => void api.media("play-pause") });
    items.push({ icon: "next", label: "Próxima", color: "#3dff8a", run: () => void api.media("next") });
  }
  items.push(
    { icon: "book", label: "Status", color: "#ffd23f", run: showStatus },
    { icon: "gear", label: "Digivice", color: "#bff4ff", run: () => void api.openWindow("settings") },
    { icon: "hide", label: "Esconder", danger: true, color: "#ffffff", run: () => void api.petVisibility(false) },
  );
  const [bx, by, bw, bh] = petBox;
  ring.open(bx + bw / 2, by + bh / 2, Math.max(92, Math.min(130, Math.max(bw, bh) / 2 + 44)), items, W, H);
  regionsDirty = true;
}

function hideMenu() {
  ring.close();
}
ring.onChange = () => {
  regionsDirty = true;
};

/** Cartão de status no estilo do painel "Battle" do Digivice. */
function showStatus() {
  const card = document.createElement("div");
  card.className = "status";
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  drawMonFit(c.getContext("2d")!, mon.id, 32, 62, 60, 60);
  const info = document.createElement("div");
  const next = [20, 60, 150, 400, 1000, 2500][stage] ?? null;
  const prevMin = [0, 20, 60, 150, 400, 1000, 2500][stage] ?? 0;
  const pct = next ? Math.min(100, ((state.xp - prevMin) / (next - prevMin)) * 100) : 100;
  const name = document.createElement("div");
  name.className = "st-name";
  name.textContent = state.nickname ? `${state.nickname} · ${mon.name}` : mon.name;
  const meta = document.createElement("div");
  meta.className = "st-meta";
  meta.textContent = `${STAGES[stage]} · ${mon.attribute} · ${mon.type}`;
  const bar = document.createElement("div");
  bar.className = "dv-bar";
  const fill = document.createElement("i");
  fill.style.width = `${pct}%`;
  bar.append(fill);
  const xp = document.createElement("div");
  xp.className = "st-meta";
  xp.textContent = next ? `XP ${state.xp} / ${next}` : `XP ${state.xp} · MAX`;
  const lore = document.createElement("div");
  lore.className = "st-lore";
  lore.textContent = `${mon.attack}! ${mon.lore}`;
  info.append(name, meta, bar, xp);
  const top = document.createElement("div");
  top.className = "st-top";
  top.append(c, info);
  card.append(top, lore);
  bubble.show({ kind: "card", node: card, ttl: 12 });
}

window.addEventListener("blur", hideMenu);
window.addEventListener("mousedown", (e) => {
  if (ring.visible && !(e.target as HTMLElement).closest(".ring")) hideMenu();
});

// ── Música ───────────────────────────────────────────────────────────────────

function musicMode(): "dance" | "vibe" | null {
  if (!media?.playing || !media.isSpotify) return null;
  return media.spotifyFocused ? "dance" : "vibe";
}

function renderMusic() {
  const show = !!media?.title && media.isSpotify && (hover || media.spotifyFocused) && !bubble.visible;
  musicBar.classList.toggle("hidden", !show);
  if (!show || !media) return;
  const title = document.createElement("div");
  title.className = "track";
  title.textContent = `♪ ${media.title}${media.artist ? " — " + media.artist : ""}`;
  const controls = document.createElement("div");
  controls.className = "row";
  for (const [label, action] of [["⏮", "previous"], [media.playing ? "⏸" : "▶", "play-pause"], ["⏭", "next"]] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => void api.media(action);
    controls.append(b);
  }
  musicBar.replaceChildren(title, controls);
  regionsDirty = true;
}

// ── Regiões clicáveis (o resto da janela deixa o clique passar) ──────────────

let regionsDirty = true;
let lastRegions = "";
let lastRegionSend = 0;

function syncRegions(now: number) {
  if (!regionsDirty && now - lastRegionSend < 250) return;
  const rects: [number, number, number, number][] = [];
  const [bx, by, bw, bh] = petBox;
  rects.push([bx - 6, by - 6, bw + 12, bh + 12]);
  for (const e of [bubble.root, musicBar, ring.root]) {
    if (e.classList.contains("hidden")) continue;
    const r = e.getBoundingClientRect();
    rects.push([r.left - 4, r.top - 4, r.width + 8, r.height + 8]);
  }
  const key = JSON.stringify(rects.map((r) => r.map(Math.round)));
  if (key !== lastRegions) {
    lastRegions = key;
    void api.hitRegions(rects);
  }
  regionsDirty = false;
  lastRegionSend = now;
}

bubble.onChange = () => {
  regionsDirty = true;
  renderMusic();
};

// ── Laço de desenho ──────────────────────────────────────────────────────────

let last = performance.now();
let walkStep = 0;
let nextNote = 0;
let nextZ = 0;

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  if (!mon) {
    requestAnimationFrame(frame);
    return;
  }

  const id = monId(mon);
  const S = scaleOf(id);
  const box = monBox(id, S);
  const music = musicMode();
  if (working && now - workingSince > 10 * 60_000) working = false;
  const sleeping = !music && !working && !bubble.busy && now - lastActivity > 15 * 60_000;

  // passeio
  // o ovo não passeia; ele só balança no lugar
  if (!anim && !music && !working && !sleeping && stage > 0 && now > nextWander) {
    targetX = (Math.random() - 0.5) * (W - box.w - 40);
    nextWander = now + 6000 + Math.random() * 9000;
  }
  if (Math.abs(targetX - posX) > 2 && !anim && !sleeping) {
    const speed = stage <= 2 ? 34 : 40 + stage * 4;
    const step = Math.sign(targetX - posX) * speed * dt;
    posX += step;
    walked += Math.abs(step);
    facing = Math.sign(step) || facing;
  }
  if (!anim && !music && !working && !sleeping && now > nextIdleLine && !bubble.visible) {
    if (Math.random() < 0.5) say(pick(mon.lines.idle));
    nextIdleLine = now + 40000 + Math.random() * 50000;
  }

  // transformação do frame
  let dx = 0, dy = 0, sx = 1, sy = 1, rot = 0, white = 0, red = 0;
  let flip = facing < 0;
  let drawId = id;
  let pose: Pose = "idle";
  const walking = Math.abs(targetX - posX) > 2 && !anim;

  if (sleeping) {
    sy = 0.92 + Math.sin(t * 1.5) * 0.02;
    if (now > nextZ) {
      fx.z(W / 2 + posX + 20, petBox[1] + 4);
      nextZ = now + 1500;
    }
  } else if (music === "dance") {
    const beat = t * 2.1; // ~126 bpm
    dx = Math.sin(beat * Math.PI) * 14;
    dy = -Math.abs(Math.sin(beat * Math.PI * 2)) * 10;
    sy = 1 + Math.sin(beat * Math.PI * 4) * 0.06;
    flip = Math.floor(beat) % 2 === 0;
    // pose de ataque no contratempo: parece um passinho de dança
    if (Math.floor(beat * 2) % 4 === 1) pose = "attack";
    if (now > nextNote) {
      fx.note(W / 2 + posX + (Math.random() - 0.5) * 80, petBox[1] + 10);
      nextNote = now + 380;
    }
  } else if (music === "vibe") {
    dy = -Math.abs(Math.sin(t * Math.PI * 2.1)) * 3;
    rot = Math.sin(t * Math.PI * 1.05) * 0.04;
  } else if (working) {
    dy = -Math.abs(Math.sin(t * 9)) * 4;
    if (Math.random() < dt * 0.8) fx.sparkle(W / 2 + posX, petBox[1] + 10, 2, "#9fe6ff");
  } else if (walking && stage >= 3) {
    // passos: um quadro a cada ~7 px andados, com um leve balanço
    pose = "walk";
    walkStep = Math.floor(walked / 7) % 4;
    dy = walkStep % 2 === 1 ? 0 : -1;
  } else if (walking) {
    // bebês andam saltitando, como nos jogos
    const hop = Math.abs(Math.sin(walked / 9));
    dy = -hop * 7;
    sy = 1 + (hop < 0.2 ? -0.08 : 0.03);
  } else {
    sy = 1 + Math.sin(t * 2.4) * 0.025;
    if (stage === 0) rot = Math.sin(t * 3) * 0.04 * (Math.sin(t * 0.7) > 0.6 ? 1 : 0);
  }

  if (anim) {
    const p = (now - anim.t0) / anim.dur;
    if (p >= 1) {
      if ((anim.name === "evolve" || anim.name === "hatch") && anim.next != null) {
        setStage(anim.next);
        fx.sparkle(W / 2 + posX, GROUND - 40, 20, "#ffffff");
        say(`${STAGES[stage]}: ${mon.name}! ${pick(mon.lines.greet)}`, 5);
        anim = null;
        // XP que chegou durante a animação pode pedir mais uma evolução.
        window.setTimeout(checkEvolution, 1800);
      }
      anim = null;
    } else {
      switch (anim.name) {
        case "attack": {
          const dir = flip ? -1 : 1;
          if (p < 0.25) {
            dx -= dir * p * 24;
            sx = 1 + p * 0.3;
            sy = 1 - p * 0.3;
          } else if (p < 0.45) {
            pose = "attack";
            dx += dir * ((p - 0.25) / 0.2) * 18;
            if (!anim.fired) {
              anim.fired = true;
              fx.attack(mon.fx, W / 2 + posX + dir * box.w * 0.42, GROUND - box.h * 0.62, dir);
            }
          } else {
            if (p < 0.8) pose = "attack";
            dx += dir * (1 - (p - 0.45) / 0.55) * 18;
          }
          break;
        }
        case "happy":
          dy = -Math.abs(Math.sin(p * Math.PI * 2)) * 16;
          if (dy < -6) pose = "attack";
          break;
        case "poke":
          if (p < 0.6) pose = "hit";
          sx = 1 + Math.sin(p * Math.PI) * 0.18;
          sy = 1 - Math.sin(p * Math.PI) * 0.18;
          break;
        case "hurt":
          pose = "hit";
          dx += Math.sin(p * 60) * 4;
          red = 0.5 * (1 - p);
          break;
        case "dizzy":
          pose = "hit";
          rot = Math.sin(p * 30) * 0.25;
          if (Math.random() < 0.2) fx.sparkle(W / 2 + posX, petBox[1], 1, "#ffe066");
          break;
        case "alert":
          pose = "attack";
          dy = -Math.abs(Math.sin(p * Math.PI * 2)) * 12;
          break;
        case "hatch":
          rot = Math.sin(p * 40) * 0.12 * Math.min(1, p * 2);
          white = p > 0.7 ? (p - 0.7) / 0.3 : 0;
          if (p > 0.85) {
            fx.flash = 0.8;
            drawId = monFor(state.line, anim.next ?? 1).id;
          }
          break;
        case "evolve": {
          // pisca entre a forma atual e a nova, em silhueta branca, cada vez mais rápido
          const blink = Math.floor(p * p * 26) % 2 === 0;
          white = Math.min(1, p * 3);
          if (p > 0.3 && blink && anim.next != null) drawId = monFor(state.line, anim.next).id;
          if (p > 0.92 && anim.next != null) {
            drawId = monFor(state.line, anim.next).id;
            white = (1 - p) / 0.08;
          }
          if (!anim.fired && p > 0.1) {
            anim.fired = true;
            fx.say("DIGIVOLVE!", "#7df9ff", 2.6);
          }
          if (Math.random() < 0.5) fx.sparkle(W / 2 + posX + (Math.random() - 0.5) * 100, GROUND - Math.random() * 120, 1, "#ffffff");
          break;
        }
      }
    }
  }

  // desenho
  fx.update(dt);
  g.clearRect(0, 0, W, H);
  g.save();
  if (fx.shake > 0) g.translate((Math.random() - 0.5) * fx.shake * 10, (Math.random() - 0.5) * fx.shake * 6);
  const x = W / 2 + posX + dx;
  const dScale = scaleOf(drawId);
  const dBox = monBox(drawId, dScale);
  g.fillStyle = "rgba(0,0,0,0.22)";
  g.fillRect(Math.round(x - dBox.w * 0.3), GROUND - 2, Math.round(dBox.w * 0.6), 4);
  petBox = drawMon(g, drawId, { x, y: GROUND + dy, scale: dScale, pose, step: walkStep, facing: flip ? -1 : 1, sx, sy, rot, white, red });
  if (bubble.busy && !anim) {
    drawGrid(g, EXCLAIM, x + dBox.w * 0.3, petBox[1] - 26 + Math.sin(t * 8) * 3, 3, "#ffd23f");
  }
  fx.draw(g);
  g.restore();

  if (!bubble.root.classList.contains("hidden")) {
    const bw = bubble.root.offsetWidth;
    bubble.root.style.left = `${Math.max(4, Math.min(W - bw - 4, x - bw / 2))}px`;
    bubble.root.style.bottom = `${H - petBox[1] + 14}px`;
    bubble.root.style.maxHeight = `${Math.max(120, petBox[1] - 20)}px`;
  }
  if (!musicBar.classList.contains("hidden")) {
    const mw = musicBar.offsetWidth;
    musicBar.style.left = `${Math.max(4, Math.min(W - mw - 4, x - mw / 2))}px`;
    musicBar.style.bottom = `${H - petBox[1] + 8}px`;
  }
  syncRegions(now);
  requestAnimationFrame(frame);
}

// ── Eventos do backend ───────────────────────────────────────────────────────

async function boot() {
  state = await api.state();
  setSoundEnabled(state.sounds);
  try {
    await loadPacks(await api.customSprites());
  } catch {
    /* sem pasta de sprites: fica o desenho em código */
  }
  setStage(targetStage());
  requestAnimationFrame(frame);
  window.setTimeout(() => say(pick(mon.lines.greet)), 600);

  await listen<HookPayload>("hook", (e) => onHook(e.payload));
  await listen<MediaState>("media", (e) => {
    const was = musicMode();
    media = e.payload;
    const now = musicMode();
    if (now === "dance" && was !== "dance" && Math.random() < 0.5) say(pick(mon.lines.music));
    if (now) activity();
    renderMusic();
  });
  await listen<boolean>("pet-hover", (e) => {
    hover = e.payload;
    renderMusic();
  });
  await listen<string>("pet-say", (e) => say(e.payload, 6));
  await listen("pet-attack", () => attack());
  await listen("pet-flash", () => {
    fx.flash = 0.7;
    sfx.blip();
  });
  await listen<boolean>("chat-busy", (e) => {
    chatBusy = e.payload;
    if (chatBusy) activity();
  });
  await listen<PetState>("state-changed", (e) => {
    const prev = state;
    // XP e contadores só crescem aqui: um eco atrasado do próprio save não os desfaz.
    state = {
      ...e.payload,
      xp: e.payload.xp === 0 ? 0 : Math.max(e.payload.xp, prev.xp), // 0 só vem do "Zerar XP"
      tasksDone: Math.max(e.payload.tasksDone, prev.tasksDone),
      questionsAnswered: Math.max(e.payload.questionsAnswered, prev.questionsAnswered),
    };
    setSoundEnabled(state.sounds);
    if (state.xp === 0 && prev.xp > 0) {
      setStage(targetStage());
      say("De volta ao ovo… *toc toc*");
    } else if (prev.line !== state.line) {
      setStage(targetStage());
      fx.sparkle(W / 2 + posX, GROUND - 40, 16);
      say(`${LINES[state.line].title}! ${pick(mon.lines.greet)}`);
    } else if (prev.stageLock !== state.stageLock || prev.scale !== state.scale) {
      if (targetStage() !== stage) checkEvolution();
      else setStage(stage);
    }
  });
}

void boot();
