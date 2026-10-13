// Efeitos sonoros em chiptune, gerados na hora com WebAudio (nada de arquivos).

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "square", vol = 0.06, slideTo?: number) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + start;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(start: number, dur: number, vol = 0.05) {
  const a = ac();
  if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  const gain = a.createGain();
  gain.gain.value = vol;
  src.buffer = buf;
  src.connect(gain).connect(a.destination);
  src.start(a.currentTime + start);
}

export const sfx = {
  poke: () => tone(660, 0, 0.08, "square", 0.05, 880),
  blip: () => tone(880, 0, 0.05, "square", 0.04),
  attack: () => {
    tone(220, 0, 0.12, "sawtooth", 0.05, 880);
    tone(880, 0.12, 0.25, "square", 0.05, 110);
    noise(0.3, 0.35, 0.07);
  },
  done: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.12, "square", 0.05)),
  ask: () => {
    tone(988, 0, 0.1, "square", 0.05);
    tone(1319, 0.12, 0.16, "square", 0.05);
  },
  hurt: () => tone(330, 0, 0.25, "sawtooth", 0.05, 90),
  evolve: () => {
    [262, 330, 392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 0.14, "square", 0.045));
    tone(1568, 0.95, 0.6, "triangle", 0.06);
  },
  hatch: () => {
    noise(0, 0.15, 0.06);
    [392, 523, 784].forEach((f, i) => tone(f, 0.15 + i * 0.1, 0.15, "square", 0.05));
  },
};
