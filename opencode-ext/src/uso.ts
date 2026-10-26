// Uso dos modelos numa janela móvel de 5 h.
//
// O USO vem do próprio serviço do OpenCode (/api/experimental/session/stats),
// que soma todas as sessões: todas as janelas do VS Code, o TUI, o celular e os
// subagentes. O LIMITE não é publicado, então é aprendido: quando o provedor
// recusa por cota (FreeUsageLimitError, "rate limit", 429), o uso daquele momento
// vira o limite da cota e ela fica esgotada até o primeiro uso sair da janela.
// Limites e bloqueios ficam num arquivo compartilhado entre as janelas.

export const JANELA_MS = 5 * 60 * 60 * 1000;

export interface Compartilhado {
  /** Tokens usados na janela quando veio a recusa: o limite aprendido, por cota. */
  limites: Record<string, number>;
  /** Até quando a cota está esgotada (ms), por cota. */
  bloqueios: Record<string, number>;
}

export interface Situacao {
  usado: number;
  limite?: number;
  /** 0–100, só quando o limite já foi aprendido. */
  pct?: number;
  esgotadoAte?: number;
}

export const vazio = (): Compartilhado => ({ limites: {}, bloqueios: {} });

/** O que conta para a cota: o que entra e o que sai (cache lido não conta). */
export function tokensDoPasso(t: { input?: number; output?: number; reasoning?: number } | undefined): number {
  if (!t) return 0;
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

/** Erros de cota/limite de taxa dos provedores (pelo tipo, status ou texto). */
export function erroDeLimite(msg: string | undefined, status?: number, tipo?: string): boolean {
  if (status === 429) return true;
  if (tipo && /UsageLimit|RateLimit|Quota/i.test(tipo)) return true;
  return !!msg && /exceed|rate.?limit|quota|too many requests|\b429\b|limit reached|insufficient.?(credit|balance)|usage limit/i.test(msg);
}

/** Soma as estatísticas do servidor por modelo (variantes juntas) e por cota. */
export function somar(modelos: { model: { id: string; providerID: string }; tokens: any }[], cotaDe: (ref: string) => string) {
  const porModelo: Record<string, number> = {};
  const porCota: Record<string, number> = {};
  for (const m of modelos ?? []) {
    const ref = `${m.model.providerID}/${m.model.id}`;
    const n = tokensDoPasso(m.tokens);
    porModelo[ref] = (porModelo[ref] ?? 0) + n;
    const c = cotaDe(ref);
    porCota[c] = (porCota[c] ?? 0) + n;
  }
  return { porModelo, porCota };
}

/** Junta o que outra janela gravou com o desta: o maior limite e o bloqueio mais longo vencem. */
export function mesclar(a: Compartilhado, b: Compartilhado, agora: number): Compartilhado {
  const r = vazio();
  for (const x of [a, b]) {
    for (const [k, v] of Object.entries(x?.limites ?? {})) r.limites[k] = Math.max(r.limites[k] ?? 0, v);
    for (const [k, v] of Object.entries(x?.bloqueios ?? {})) if (v > agora) r.bloqueios[k] = Math.max(r.bloqueios[k] ?? 0, v);
  }
  return r;
}

/** Recusa por cota: aprende o limite (só sobe) e bloqueia até `ate`. */
export function marcarLimite(d: Compartilhado, cota: string, usado: number, ate: number) {
  if (usado > 0) d.limites[cota] = Math.max(d.limites[cota] ?? 0, usado);
  d.bloqueios[cota] = Math.max(d.bloqueios[cota] ?? 0, ate);
}

export function situacao(d: Compartilhado, cota: string, usado: number, agora: number): Situacao {
  const limite = d.limites[cota];
  const ate = d.bloqueios[cota];
  return {
    usado,
    limite,
    pct: limite ? Math.min(100, Math.round((usado / limite) * 100)) : undefined,
    esgotadoAte: ate && ate > agora ? ate : undefined,
  };
}

/**
 * Quando foi o primeiro uso dentro da janela: bisseção sobre "houve passos em
 * [início, t]?". A cota libera 5 h depois dele.
 */
export async function primeiroUso(temPassos: (de: number, ate: number) => Promise<boolean>, agora: number, precisaoMs = 60_000): Promise<number | undefined> {
  let lo = agora - JANELA_MS;
  let hi = agora;
  if (!(await temPassos(lo, hi))) return undefined;
  while (hi - lo > precisaoMs) {
    const meio = Math.floor((lo + hi) / 2);
    if (await temPassos(agora - JANELA_MS, meio)) hi = meio;
    else lo = meio;
  }
  return hi;
}
