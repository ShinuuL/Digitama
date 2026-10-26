// Animação do pet como função pura do tempo: dado o movimento e o instante,
// devolve a pose, o quadro e os deslocamentos. O pet e a página de prévia
// (dev/anim.html) usam exatamente isto.
//
// Como no Digimon World DS, o sprite de batalha é uma imagem só; a fluidez vem
// do movimento: respiração em quadros (o tronco sobe 1–2 px), arcos de pulo,
// preparo → investida rápida com rastro → pausa no impacto → volta suave.
import type { Pose } from "./render";

export type Base = "idle" | "walk" | "hop" | "dance" | "vibe" | "work" | "sleep" | "egg";
export type Shot = "attack" | "happy" | "poke" | "hurt" | "dizzy" | "alert";

export interface Look {
  pose: Pose;
  /** Quadro do ciclo de passos (pose "walk"). */
  step: number;
  /** Quadro de respiração: 0 (solto) … 2 (peito cheio). */
  breath: number;
  /** Relógio do idle do jogo (um quadro a cada ~150 ms, como no DS). */
  cycle: number;
  dx: number;
  dy: number;
  rot: number;
  red: number;
  white: number;
  /** Força o lado (dança); null = o lado de andar. */
  flip: boolean | null;
  /** Rastro: deslocamentos (em px) de cópias fantasmas atrás do corpo. */
  ghosts: number[];
  /** Momento de soltar o projétil do golpe. */
  fire: boolean;
}

/** Duração (s) de cada movimento de uma vez só. */
export const SHOT_DUR: Record<Shot, number> = { attack: 1.0, happy: 0.8, poke: 0.42, hurt: 0.65, dizzy: 2.2, alert: 0.9 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const outCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const inOutSine = (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2;
const outBack = (x: number) => {
  const c = 1.7, k = clamp01(x) - 1;
  return 1 + (c + 1) * k * k * k + c * k * k;
};
/** Arco de pulo: 0 → 1 → 0, com a forma de uma parábola (gravidade). */
const arc = (x: number) => 4 * clamp01(x) * (1 - clamp01(x));

/** Ciclo de respiração, como um sprite de 4 quadros a ~180 ms. */
const breathAt = (t: number, period = 0.18) => [0, 1, 2, 1][Math.floor(t / period) % 4];

const blank = (): Look => ({ pose: "idle", step: 0, breath: 0, cycle: 0, dx: 0, dy: 0, rot: 0, red: 0, white: 0, flip: null, ghosts: [], fire: false });

/** O movimento contínuo (o que ele está fazendo quando nada especial acontece). */
export function base(mode: Base, t: number, walked: number): Look {
  const l = blank();
  l.cycle = Math.floor(t / 0.15);
  switch (mode) {
    case "idle":
      l.breath = breathAt(t);
      break;
    case "walk": {
      // 8 quadros (src/pet/walk.ts), um a cada ~3 px andados; o corpo sobe
      // 1 px enquanto um pé está no ar
      l.pose = "walk";
      l.step = Math.floor(walked / 3) % 8;
      l.dy = l.step % 4 === 0 ? 0 : -1;
      break;
    }
    case "hop": {
      // bebês andam saltitando: um arco a cada ~26 px, achatando na aterrissagem
      const ph = (walked / 26) % 1;
      l.dy = -arc(ph) * 8;
      l.breath = ph < 0.15 || ph > 0.85 ? 0 : 2;
      break;
    }
    case "dance": {
      const beat = t * 2.1; // ~126 bpm
      const b = Math.floor(beat), ph = beat % 1;
      l.dy = -arc(ph) * 11;
      l.dx = (b % 2 === 0 ? -1 : 1) * 9 * inOutSine(ph) + (b % 2 === 0 ? 4.5 : -4.5);
      l.flip = Math.floor(beat / 2) % 2 === 0;
      l.pose = b % 2 === 1 && ph > 0.2 && ph < 0.65 ? "attack" : "idle";
      l.breath = ph < 0.12 ? 0 : 2;
      break;
    }
    case "vibe": {
      const ph = (t * 2.1) % 1;
      l.dy = -arc(ph) * 2;
      l.breath = ph < 0.5 ? 2 : 0;
      break;
    }
    case "work": {
      // treinando: respiração rápida e pulinhos curtos
      l.breath = breathAt(t, 0.09);
      l.dy = -arc((t * 2.4) % 1) * 3;
      break;
    }
    case "sleep":
      l.breath = breathAt(t, 0.7) > 0 ? 1 : 0;
      l.dy = 1;
      break;
    case "egg": {
      // balança de vez em quando, como um ovo que vai chocar
      const burst = (t % 3.2) / 0.6;
      l.rot = burst < 1 ? Math.sin(burst * Math.PI * 4) * 0.08 * (1 - burst) : 0;
      break;
    }
  }
  return l;
}

/** Um movimento de uma vez só, no progresso `p` (0..1), virado para `dir`. */
export function shot(name: Shot, p: number, dir: number): Partial<Look> {
  const s = p * SHOT_DUR[name];
  switch (name) {
    case "attack": {
      if (s < 0.22) {
        // preparo: recua agachando
        return { dx: -dir * 7 * outCubic(s / 0.22), breath: 0, dy: 1 };
      }
      if (s < 0.32) {
        // investida: muito rápida, com rastro
        const k = (s - 0.22) / 0.1;
        const dx = dir * (-7 + 33 * outCubic(k));
        return { pose: "attack", dx, ghosts: [-dir * 8, -dir * 16, -dir * 24].map((g) => g * (1 - k * 0.3)) };
      }
      if (s < 0.42) {
        // impacto: pausa curta e clarão (o golpe sai aqui)
        return { pose: "attack", dx: dir * 26, fire: true, white: s < 0.36 ? 0.55 : 0, breath: 2 };
      }
      // volta suave para o lugar
      const k = (s - 0.42) / (SHOT_DUR.attack - 0.42);
      return { pose: k < 0.4 ? "attack" : "idle", dx: dir * 26 * (1 - inOutSine(k)), dy: -arc(k) * 3 };
    }
    case "happy": {
      const ph = (p * 2) % 1;
      const h = arc(ph);
      return { dy: -h * 15, pose: h > 0.55 ? "attack" : "idle", breath: ph < 0.1 || ph > 0.9 ? 0 : 2 };
    }
    case "poke":
      return { pose: p < 0.55 ? "hit" : "idle", dx: -dir * 4 * arc(p), dy: -arc(p) * 5 };
    case "hurt": {
      const knock = s < 0.18 ? outCubic(s / 0.18) : 1 - inOutSine((s - 0.18) / (SHOT_DUR.hurt - 0.18));
      return { pose: "hit", dx: -dir * 14 * knock, red: Math.floor(s / 0.06) % 2 === 0 ? 0.6 * (1 - p) : 0 };
    }
    case "dizzy":
      return { pose: "hit", rot: Math.sin(s * 9) * 0.16 * (1 - p * 0.6), dx: Math.sin(s * 4.5) * 5 };
    case "alert": {
      const h = arc(clamp01(p * 1.7));
      return { pose: h > 0.2 ? "attack" : "idle", dy: -h * 14, breath: 2 };
    }
  }
}

/** Base + movimento de uma vez só (o de uma vez manda no que define). */
export function compose(b: Look, s: Partial<Look> | null): Look {
  if (!s) return b;
  return {
    ...b,
    ...s,
    dx: b.dx + (s.dx ?? 0),
    dy: (s.dy ?? 0) + (s.pose && s.pose !== "walk" ? 0 : b.dy),
    step: s.pose ? 0 : b.step,
    pose: s.pose ?? (b.pose === "walk" ? "idle" : b.pose),
    breath: s.breath ?? b.breath,
    ghosts: s.ghosts ?? [],
    fire: !!s.fire,
  };
}

export { outBack };
