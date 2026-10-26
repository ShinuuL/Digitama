// Efeitos: projéteis dos ataques, explosões, notas musicais, brilhos, Zz e o
// letreiro com o nome do golpe. Tudo pixelado e desenhado no mesmo canvas.
import type { AttackFx } from "../shared/lore";
import { ART } from "./art.gen";
import { artFrame, drawGrid, pixelDisc } from "./render";

interface Particle {
  kind: "note" | "spark" | "bubble" | "ball" | "fire" | "trail" | "boom" | "z" | "heart" | "beam" | "ring" | "bolt" | "orb";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  gravity?: number;
  /** Ao terminar: explode aqui. */
  boom?: string;
  trail?: string;
  data?: number;
}

const NOTE_COLORS = ["#ff5fa2", "#ffd23f", "#4fd1ff", "#7dff7a", "#c48bff"];

export class Fx {
  parts: Particle[] = [];
  banner: { text: string; age: number; life: number; color: string } | null = null;
  shake = 0;
  flash = 0;
  /** Pixel do efeito (acompanha a escala do pet). */
  px = 3;

  constructor(private w: number, private h: number) {}

  /** Há algo se mexendo (o pet desenha mais quadros por segundo). */
  get busy() {
    return this.parts.length > 0 || !!this.banner || this.shake > 0 || this.flash > 0;
  }

  update(dt: number) {
    const next: Particle[] = [];
    for (const p of this.parts) {
      p.age += dt;
      p.vy += (p.gravity ?? 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // ~48 faíscas de rastro por segundo, seja qual for o ritmo de desenho
      if (p.trail && Math.random() < dt * 48) {
        next.push({ kind: "trail", x: p.x, y: p.y, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, age: 0, life: 0.35, size: p.size * 0.6, color: p.trail });
      }
      const out = p.x < -40 || p.x > this.w + 40 || p.y < -60 || p.y > this.h + 20;
      if (p.age >= p.life || out) {
        if (p.boom) this.explode(Math.max(10, Math.min(this.w - 10, p.x)), Math.max(10, Math.min(this.h - 10, p.y)), p.boom, p.size);
        continue;
      }
      next.push(p);
    }
    this.parts = next;
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age > this.banner.life) this.banner = null;
    }
    this.shake = Math.max(0, this.shake - dt * 3);
    this.flash = Math.max(0, this.flash - dt * 2.5);
  }

  draw(g: CanvasRenderingContext2D) {
    const P = this.px;
    for (const p of this.parts) {
      const t = p.age / p.life;
      g.globalAlpha = p.kind === "note" || p.kind === "z" || p.kind === "heart" ? Math.min(1, (1 - t) * 2) : 1;
      switch (p.kind) {
        case "note": {
          // quadros de art/fx/note8 e note16.aseprite (a cabeça da nota brilha)
          const grid = artFrame(p.data === 1 ? ART.note16 : ART.note8, p.age * 1000);
          drawGrid(g, grid, p.x + Math.sin(p.age * 5) * 6, p.y, Math.max(2, P - 1), p.color);
          break;
        }
        case "heart":
          drawGrid(g, artFrame(ART.heart, p.age * 1000), p.x, p.y, Math.max(2, P - 1), p.color);
          break;
        case "z":
          drawGrid(g, ART.zzz.frames[0], p.x, p.y, Math.max(2, P - 1 + Math.floor(t * 2)), "#cfe3ff");
          break;
        case "spark":
        case "trail":
          g.fillStyle = p.color;
          g.fillRect(Math.round(p.x), Math.round(p.y), P * Math.max(1, Math.round(p.size * (1 - t))), P * Math.max(1, Math.round(p.size * (1 - t))));
          break;
        case "bubble":
          pixelDisc(g, p.x, p.y, p.size, P, "#bfe9ff");
          pixelDisc(g, p.x, p.y, Math.max(0, p.size - 1), P, "#e9f8ff");
          g.fillStyle = "#ffffff";
          g.fillRect(Math.round(p.x - P), Math.round(p.y - P), P, P);
          break;
        case "fire": {
          // art/fx/fireball.aseprite, virada para onde voa; as maiores com pixel maior
          const fp = Math.max(1, Math.round((P * p.size) / 4));
          const grid = artFrame(ART.fireball, p.age * 1000);
          const w = grid[0].length * fp, h = grid.length * fp;
          drawGrid(g, grid, p.x - w / 2, p.y - h / 2, fp, p.color, "#1a1222", p.trail ?? "#ffd23f", p.vx < 0);
          break;
        }
        case "ball":
        case "orb":
          pixelDisc(g, p.x, p.y, p.size, P, p.color);
          pixelDisc(g, p.x - P, p.y - P, Math.max(1, p.size * 0.45), P, "#ffffffcc");
          break;
        case "boom": {
          // art/fx/boom.aseprite: clarão, estouro, bola de fogo e anel, esticados na vida da partícula
          const total = ART.boom.ms.reduce((a, b) => a + b, 0);
          const grid = artFrame(ART.boom, t * total, false);
          // mesmo pixel dos outros efeitos; só as explosões enormes dobram
          const bp = P * Math.max(1, Math.round(p.size / 14));
          const half = (grid.length * bp) / 2;
          drawGrid(g, grid, p.x - half, p.y - half, bp, p.color, "#1a1222", "#fff6c8");
          break;
        }
        case "beam": {
          g.fillStyle = p.color;
          const len = Math.min(1, t * 3) * (p.data ?? 200);
          g.fillRect(Math.round(p.x), Math.round(p.y - P), Math.round(len * Math.sign(p.vx || 1)), P * 2);
          g.fillStyle = "#ffffff";
          g.fillRect(Math.round(p.x), Math.round(p.y), Math.round(len * Math.sign(p.vx || 1)), P);
          break;
        }
        case "ring": {
          // círculo mágico girando (Alphamon)
          const r = p.size * Math.min(1, t * 3);
          for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2 + p.age * 3;
            g.fillStyle = i % 3 === 0 ? "#ffffff" : p.color;
            g.fillRect(Math.round(p.x + Math.cos(a) * r), Math.round(p.y + Math.sin(a) * r * 0.45), P, P);
          }
          break;
        }
        case "bolt": {
          g.fillStyle = p.color;
          let x = p.x, y = p.y;
          for (let i = 0; i < 10; i++) {
            const nx = x + (p.vx > 0 ? 14 : -14), ny = y - 10 + (Math.random() - 0.5) * 10;
            g.fillRect(Math.round(Math.min(x, nx)), Math.round(ny), Math.abs(nx - x), P);
            x = nx;
            y = ny;
          }
          break;
        }
      }
    }
    g.globalAlpha = 1;
    if (this.banner) this.drawBanner(g);
    if (this.flash > 0) {
      g.fillStyle = `rgba(255,255,255,${this.flash * 0.5})`;
      g.fillRect(0, 0, this.w, this.h);
    }
  }

  private drawBanner(g: CanvasRenderingContext2D) {
    const b = this.banner!;
    const t = b.age / b.life;
    const slide = t < 0.15 ? (1 - t / 0.15) * 60 : 0;
    g.globalAlpha = t > 0.8 ? (1 - t) / 0.2 : 1;
    g.font = "bold 20px 'Cascadia Mono', Consolas, monospace";
    g.textAlign = "center";
    const x = this.w / 2 + slide, y = 120;
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [2, 2]]) {
      g.fillStyle = "#1a1222";
      g.fillText(b.text, x + dx, y + dy);
    }
    g.fillStyle = b.color;
    g.fillText(b.text, x, y);
    g.globalAlpha = 1;
  }

  say(text: string, color = "#ffd23f", life = 1.8) {
    this.banner = { text, age: 0, life, color };
  }

  explode(x: number, y: number, color: string, size = 6) {
    this.parts.push({ kind: "boom", x, y, vx: 0, vy: 0, age: 0, life: 0.5, size: size * 2.2, color });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 120;
      this.parts.push({ kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: 0.5 + Math.random() * 0.3, size: 2, color, gravity: 200 });
    }
    this.shake = Math.max(this.shake, 0.6);
  }

  note(x: number, y: number) {
    this.parts.push({
      kind: "note", x, y, vx: (Math.random() - 0.5) * 30, vy: -40 - Math.random() * 30, age: 0, life: 2.2,
      size: 1, color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)], data: Math.random() < 0.4 ? 1 : 0,
    });
  }

  heart(x: number, y: number) {
    this.parts.push({ kind: "heart", x, y, vx: (Math.random() - 0.5) * 20, vy: -50, age: 0, life: 1.4, size: 1, color: "#ff5f8a" });
  }

  z(x: number, y: number) {
    this.parts.push({ kind: "z", x, y, vx: 12, vy: -18, age: 0, life: 2.6, size: 1, color: "#cfe3ff" });
  }

  sparkle(x: number, y: number, n = 6, color = "#fff6a8") {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 60;
      this.parts.push({ kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, age: 0, life: 0.6 + Math.random() * 0.4, size: 1.5, color });
    }
  }

  /** O golpe especial saindo da boca/mãos (`x`,`y`) na direção `dir` (±1). */
  attack(kind: AttackFx, x: number, y: number, dir: number) {
    const P = this.px;
    const proj = (p: Partial<Particle>) =>
      this.parts.push({ kind: "ball", x, y, vx: 0, vy: 0, age: 0, life: 1.4, size: 4, color: "#ff8a1e", ...p } as Particle);
    switch (kind) {
      case "wobble":
        this.sparkle(x, y, 8);
        break;
      case "bubbles":
        for (let i = 0; i < 6; i++)
          proj({ kind: "bubble", vx: dir * (90 + i * 25), vy: -40 - Math.random() * 50, size: 2 + Math.random() * 2, life: 1.2 + i * 0.08, x: x + dir * i * 4 });
        break;
      case "fireball":
      case "redfire":
        proj({ kind: "fire", vx: dir * 260, vy: -40, size: 4, color: kind === "fireball" ? "#ff9a1e" : "#ff4a2e", trail: "#ffd23f", boom: "#ff7a1e" });
        break;
      case "bigfire":
      case "bigredfire":
        proj({ kind: "fire", vx: dir * 220, vy: -30, size: 7, color: kind === "bigfire" ? "#ff8a1e" : "#ff3a24", trail: "#ffe066", boom: "#ff5a1e", life: 1.6 });
        break;
      case "missiles":
        for (let i = 0; i < 2; i++)
          proj({ x, y: y - i * 10, vx: dir * (230 + i * 30), vy: -90 + i * 40, gravity: 60, size: 3, color: "#a8b4b4", trail: "#ff9a1e", boom: "#ff7a1e", life: 1.5 });
        break;
      case "terraforce":
        proj({ kind: "orb", x, y: y - 50, vx: dir * 140, vy: -20, size: 11, color: "#ff8a1e", trail: "#ffd23f", boom: "#ff6a00", life: 2 });
        this.flash = 0.6;
        break;
      case "atomic":
        for (const off of [-6, 6])
          this.parts.push({ kind: "beam", x, y: y + off, vx: dir, vy: 0, age: 0, life: 0.9, size: 1, color: "#ff5040", data: this.w });
        this.explode(dir > 0 ? this.w - 30 : 30, y, "#ff5a1e", 8);
        break;
      case "lance":
        this.parts.push({ kind: "bolt", x, y, vx: dir, vy: 0, age: 0, life: 0.7, size: 1, color: "#fff6a8" });
        this.parts.push({ kind: "beam", x, y: y - 4, vx: dir, vy: 0, age: 0, life: 0.8, size: 1, color: "#9fd8ff", data: this.w });
        this.flash = 0.5;
        break;
      case "ironball":
        proj({ vx: dir * 230, vy: -140, gravity: 320, size: 4, color: "#6c6c78", boom: "#c9c9d6", life: 1.6 });
        break;
      case "bigiron":
        proj({ vx: dir * 200, vy: -170, gravity: 300, size: 7, color: "#5a5a66", boom: "#c9c9d6", life: 1.8 });
        break;
      case "meteor":
        proj({ x: x + dir * 160, y: -30, vx: -dir * 40, vy: 260, size: 10, color: "#6a6070", trail: "#ff9a1e", boom: "#ffb040", life: 1.4 });
        break;
      case "soul": {
        // o círculo nasce à frente, mas sempre inteiro dentro da janela
        const cx = Math.max(70, Math.min(this.w - 70, x + dir * 60));
        this.parts.push({ kind: "ring", x: cx, y: y + 10, vx: 0, vy: 0, age: 0, life: 1.6, size: 60, color: "#7dff9a" });
        for (let i = 0; i < 5; i++)
          proj({ kind: "orb", x: cx + (i - 2) * 18, y: y - 10, vx: dir * 30, vy: -160 - i * 20, size: 3, color: "#a8ffb8", trail: "#e8fff0", life: 1.2 });
        this.flash = 0.4;
        break;
      }
    }
    void P;
  }
}
