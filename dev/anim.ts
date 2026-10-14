// Prévia das animações: cada linha é um movimento, cada coluna um quadro a
// 15 fps (o mesmo código do pet: src/pet/anim.ts + drawMon). Só em dev:
//   npx vite  →  http://127.0.0.1:1430/dev/anim.html?id=agumon
import { base, compose, shot, SHOT_DUR, type Base, type Shot } from "../src/pet/anim";
import { drawMon, loadPacks, monBox } from "../src/pet/render";

const q = new URLSearchParams(location.search);
const id = q.get("id") ?? "agumon";
const scale = Number(q.get("scale") ?? 2);
const FPS = 15;
const COLS = Number(q.get("cols") ?? 16);

const rows: { label: string; look: (t: number) => ReturnType<typeof base> }[] = [
  ...(["idle", "walk", "hop", "dance", "work"] as Base[]).map((m) => ({
    label: m,
    look: (t: number) => base(m, t, t * 48),
  })),
  ...(["attack", "hurt", "happy", "poke", "alert"] as Shot[]).map((s) => ({
    label: s,
    look: (t: number) => compose(base("idle", t, 0), shot(s, Math.min(1, t / SHOT_DUR[s]), 1)),
  })),
];

async function main() {
  const poses = ["idle", "attack", "hit", "idle_0", "idle_1", "idle_2", "idle_3"];
  const map: Record<string, string> = {};
  for (const p of poses) map[`${id}/${p}`] = `/__sprites/${id}/${p}.png`;
  await loadPacks(map);
  const box = monBox(id, scale);
  const cw = Math.ceil(box.w + 70), ch = Math.ceil(box.h + 40);
  const c = document.getElementById("c") as HTMLCanvasElement;
  c.width = 70 + cw * COLS;
  c.height = ch * rows.length;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a3a52";
  g.fillRect(0, 0, c.width, c.height);
  rows.forEach((row, r) => {
    g.fillStyle = "#fff";
    g.fillText(row.label, 6, r * ch + ch / 2);
    for (let i = 0; i < COLS; i++) {
      const t = i / FPS;
      const l = row.look(t);
      const x = 70 + i * cw + cw / 2, y = r * ch + ch - 10;
      g.fillStyle = i % 2 ? "#41415c" : "#45455f";
      g.fillRect(70 + i * cw, r * ch, cw, ch);
      g.fillStyle = "rgba(0,0,0,.3)";
      g.fillRect(x - box.w * 0.3, y - 2, box.w * 0.6, 3);
      drawMon(g, id, { x: x + l.dx, y: y + l.dy, scale, pose: l.pose, step: l.step, breath: l.breath, cycle: l.cycle, ghosts: l.ghosts, rot: l.rot, white: l.white, red: l.red, facing: l.flip === null ? 1 : l.flip ? -1 : 1 });
      if (l.fire) { g.fillStyle = "#ffd23f"; g.fillRect(70 + i * cw + 2, r * ch + 2, 6, 6); }
    }
  });
  document.title = "pronto";
}
void main();
