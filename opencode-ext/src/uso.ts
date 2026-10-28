// Uso dos modelos desde o último reinício da cota.
//
// O USO vem do próprio serviço do OpenCode (/api/experimental/session/stats),
// que soma todas as sessões: todas as janelas do VS Code, o TUI, o celular e os
// subagentes. O limite não é publicado e não é adivinhado: só mostramos o usado.
//
// DESDE QUANDO: a cota grátis do OpenCode não é uma janela móvel de 5 h; ela
// reinicia uma vez por dia (as recusas de 26, 27 e 28/10/2026 apontaram todas
// para 00:00 UTC). O instante exato vem da recusa (recusa + retryAfterMs) e fica
// guardado em `reinicios`; daí em diante a conta começa no reinício mais recente
// (o guardado ± dias inteiros). Sem nenhuma recusa ainda, usamos as últimas 5 h.
//
// QUANDO VOLTA vem do servidor: a recusa por cota (provider.free-limit,
// provider.rate-limit, 429) chega com `retryAfterMs`, tirado do cabeçalho
// retry-after. Recusas seguidas apontam para o mesmo instante, então
// recusa + retryAfterMs é o horário exato em que a cota libera. Sem esse campo,
// estimamos o fim da janela de 5 h e marcamos como aproximado.
// Os bloqueios ficam num arquivo compartilhado entre as janelas.

export const JANELA_MS = 5 * 60 * 60 * 1000;
export const DIA_MS = 24 * 60 * 60 * 1000;

export interface Bloqueio {
  /** Quando a cota libera (ms). */
  ate: number;
  /** true quando veio do servidor (retryAfterMs); false quando é a estimativa de 5 h. */
  exato: boolean;
}

export interface Compartilhado {
  /** Cotas esgotadas, por cota. */
  bloqueios: Record<string, Bloqueio>;
  /** Um instante em que a cota reiniciou (informado pelo servidor), por cota. */
  reinicios?: Record<string, number>;
}

export interface Situacao {
  usado: number;
  /** Desde quando o uso foi contado (ms). */
  desde?: number;
  /** true quando `desde` é o reinício diário informado pelo servidor; false = últimas 5 h. */
  diaria?: boolean;
  esgotadoAte?: number;
  /** O horário de volta veio do servidor. */
  exato?: boolean;
}

export const vazio = (): Compartilhado => ({ bloqueios: {}, reinicios: {} });

/** Início da contagem: o reinício diário mais recente (se conhecido) ou as últimas 5 h. */
export function inicioDaJanela(reinicio: number | undefined, agora: number): { desde: number; diaria: boolean } {
  if (typeof reinicio !== "number" || !Number.isFinite(reinicio)) return { desde: agora - JANELA_MS, diaria: false };
  const dias = Math.floor((agora - reinicio) / DIA_MS);
  return { desde: reinicio + dias * DIA_MS, diaria: true };
}

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
    // reinícios não vencem: qualquer um serve de referência; fica o mais recente
    for (const [k, v] of Object.entries(x?.reinicios ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) r.reinicios![k] = Math.max(r.reinicios![k] ?? 0, v);
    }
  }
  return r;
}

/** Recusa por cota: bloqueia até o horário que o servidor deu (ou a estimativa). */
export function marcarLimite(d: Compartilhado, cota: string, b: Bloqueio) {
  // a resposta mais recente do servidor é a verdade: substitui a anterior
  d.bloqueios[cota] = b.exato ? b : melhor(d.bloqueios[cota], b);
  // a hora em que libera é a hora do reinício: a conta passa a começar nela
  if (b.exato) (d.reinicios ??= {})[cota] = b.ate;
}

export function situacao(d: Compartilhado, cota: string, usado: number, agora: number): Situacao {
  const janela = inicioDaJanela(d.reinicios?.[cota], agora);
  const b = d.bloqueios[cota];
  if (!b || b.ate <= agora) return { usado, ...janela };
  return { usado, ...janela, esgotadoAte: b.ate, exato: b.exato };
}
