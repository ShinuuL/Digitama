// Uso dos modelos numa janela móvel de 5 h.
//
// O USO vem do próprio serviço do OpenCode (/api/experimental/session/stats),
// que soma todas as sessões: todas as janelas do VS Code, o TUI, o celular e os
// subagentes. O limite não é publicado e não é adivinhado: só mostramos o usado.
//
// QUANDO VOLTA vem do servidor: a recusa por cota (provider.free-limit,
// provider.rate-limit, 429) chega com `retryAfterMs`, tirado do cabeçalho
// retry-after. Recusas seguidas apontam para o mesmo instante, então
// recusa + retryAfterMs é o horário exato em que a cota libera. Sem esse campo,
// estimamos o fim da janela de 5 h e marcamos como aproximado.
// Os bloqueios ficam num arquivo compartilhado entre as janelas.

export const JANELA_MS = 5 * 60 * 60 * 1000;

export interface Bloqueio {
  /** Quando a cota libera (ms). */
  ate: number;
  /** true quando veio do servidor (retryAfterMs); false quando é a estimativa de 5 h. */
  exato: boolean;
}

export interface Compartilhado {
  /** Cotas esgotadas, por cota. */
  bloqueios: Record<string, Bloqueio>;
}

export interface Situacao {
  usado: number;
  esgotadoAte?: number;
  /** O horário de volta veio do servidor. */
  exato?: boolean;
}

export const vazio = (): Compartilhado => ({ bloqueios: {} });

/** O que conta para a cota: o que entra e o que sai (cache lido não conta). */
export function tokensDoPasso(t: { input?: number; output?: number; reasoning?: number } | undefined): number {
  if (!t) return 0;
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

/** Erros de cota/limite de taxa dos provedores (pelo tipo, status ou texto). */
export function erroDeLimite(msg: string | undefined, status?: number, tipo?: string): boolean {
  if (status === 429) return true;
  if (tipo && /UsageLimit|RateLimit|Quota|free-limit|rate-limit/i.test(tipo)) return true;
  return !!msg && /exceed|rate.?limit|quota|too many requests|\b429\b|limit reached|insufficient.?(credit|balance)|usage limit/i.test(msg);
}

/** Quando a cota libera, pelo que o servidor mandou na recusa; sem o campo, estima 5 h. */
export function liberaEm(retryAfterMs: unknown, agora: number): Bloqueio {
  const ms = Number(retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return { ate: agora + ms, exato: true };
  return { ate: agora + JANELA_MS, exato: false };
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

/** Qual bloqueio vale: o do servidor vence a estimativa; entre iguais, o mais longo. */
function melhor(a: Bloqueio | undefined, b: Bloqueio): Bloqueio {
  if (!a) return b;
  if (a.exato !== b.exato) return a.exato ? a : b;
  return b.ate > a.ate ? b : a;
}

/** Aceita só bloqueios no formato atual (o uso.json antigo guardava números soltos). */
function valido(b: any): b is Bloqueio {
  return !!b && typeof b === "object" && typeof b.ate === "number";
}

/** Junta o que outra janela gravou com o desta, descartando bloqueios vencidos. */
export function mesclar(a: Compartilhado, b: Compartilhado, agora: number): Compartilhado {
  const r = vazio();
  for (const x of [a, b]) {
    for (const [k, v] of Object.entries(x?.bloqueios ?? {})) {
      if (!valido(v) || v.ate <= agora) continue;
      r.bloqueios[k] = melhor(r.bloqueios[k], { ate: v.ate, exato: !!v.exato });
    }
  }
  return r;
}

/** Recusa por cota: bloqueia até o horário que o servidor deu (ou a estimativa). */
export function marcarLimite(d: Compartilhado, cota: string, b: Bloqueio) {
  // a resposta mais recente do servidor é a verdade: substitui a anterior
  d.bloqueios[cota] = b.exato ? b : melhor(d.bloqueios[cota], b);
}

export function situacao(d: Compartilhado, cota: string, usado: number, agora: number): Situacao {
  const b = d.bloqueios[cota];
  if (!b || b.ate <= agora) return { usado };
  return { usado, esgotadoAte: b.ate, exato: b.exato };
}
