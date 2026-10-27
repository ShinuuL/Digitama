const test = require("node:test");
const assert = require("node:assert");
const u = require("../out/uso");

const H = 60 * 60 * 1000;

test("reconhece o erro do OpenCode pelo tipo e pelo texto", () => {
  assert.ok(u.erroDeLimite("qualquer", undefined, "FreeUsageLimitError"));
  assert.ok(u.erroDeLimite("Free usage limit reached. Free models work in OpenCode"));
  for (const m of ["Rate limit reached", "429 Too Many Requests", "quota exceeded", "You have exceeded your usage limit"]) assert.ok(u.erroDeLimite(m), m);
  assert.ok(u.erroDeLimite("", 429));
  assert.ok(!u.erroDeLimite("ENOENT: arquivo não encontrado", 500, "ToolError"));
});

test("soma as estatísticas do servidor por modelo (variantes juntas) e por cota", () => {
  const cotaDe = (ref) => (ref.startsWith("opencode/") ? "opencode:gratis" : ref);
  const t = (i, o = 0, r = 0) => ({ input: i, output: o, reasoning: r, cache: { read: 9999 } });
  const s = u.somar([
    { model: { id: "big-pickle", providerID: "opencode", variant: "default" }, tokens: t(100, 10) },
    { model: { id: "big-pickle", providerID: "opencode" }, tokens: t(50) },
    { model: { id: "deepseek-v4.1-flash-free", providerID: "opencode", variant: "high" }, tokens: t(20, 0, 5) },
    { model: { id: "gpt-x", providerID: "openai" }, tokens: t(7) },
  ], cotaDe);
  assert.deepStrictEqual(s.porModelo, { "opencode/big-pickle": 160, "opencode/deepseek-v4.1-flash-free": 25, "openai/gpt-x": 7 });
  assert.deepStrictEqual(s.porCota, { "opencode:gratis": 185, "openai/gpt-x": 7 });
});

test("o tipo do OpenCode (provider.free-limit) é recusa por cota", () => {
  assert.ok(u.erroDeLimite("Free usage limit reached.", undefined, "provider.free-limit"));
  assert.ok(u.erroDeLimite("", undefined, "provider.rate-limit"));
});

test("horário de volta vem do retryAfterMs do servidor (recusa real gravada)", () => {
  // duas recusas reais, com 8 min de diferença, apontam para o mesmo instante
  const a = u.liberaEm(26336000, 1793119257732);
  const b = u.liberaEm(25822000, 1793119771967);
  assert.deepStrictEqual(a, { ate: 1793145593732, exato: true });
  assert.ok(Math.abs(a.ate - b.ate) < 1000);
});

test("sem retryAfterMs: estima 5 h e marca como aproximado", () => {
  for (const v of [undefined, null, 0, -5, "abc"]) assert.deepStrictEqual(u.liberaEm(v, 1000), { ate: 1000 + u.JANELA_MS, exato: false }, String(v));
  assert.deepStrictEqual(u.liberaEm("60000", 0), { ate: 60000, exato: true });
});

test("situação: só o usado; esgotado com o horário enquanto o bloqueio vale", () => {
  const d = u.vazio();
  assert.deepStrictEqual(u.situacao(d, "c", 500, 0), { usado: 500 });
  u.marcarLimite(d, "c", { ate: 2 * H, exato: true });
  assert.deepStrictEqual(u.situacao(d, "c", 500, 1 * H), { usado: 500, esgotadoAte: 2 * H, exato: true });
  assert.deepStrictEqual(u.situacao(d, "c", 500, 2 * H), { usado: 500 });
});

test("a resposta nova do servidor substitui a anterior; estimativa não sobrepõe a exata", () => {
  const d = u.vazio();
  u.marcarLimite(d, "c", { ate: 3 * H, exato: true });
  u.marcarLimite(d, "c", { ate: 9 * H, exato: false });
  assert.deepStrictEqual(d.bloqueios.c, { ate: 3 * H, exato: true });
  u.marcarLimite(d, "c", { ate: 2 * H, exato: true });
  assert.deepStrictEqual(d.bloqueios.c, { ate: 2 * H, exato: true });
});

test("mesclar entre janelas: exato vence estimativa, vencido e formato antigo saem", () => {
  const a = { bloqueios: { c: { ate: 5 * H, exato: false }, velho: { ate: 1, exato: true } } };
  const b = { bloqueios: { c: { ate: 4 * H, exato: true }, d: { ate: 3 * H, exato: false } } };
  const antigo = { limites: { c: 1000 }, limitesEm: { c: 1 }, bloqueios: { c: 6 * H } };
  const r = u.mesclar(u.mesclar(a, b, 1 * H), antigo, 1 * H);
  assert.deepStrictEqual(r, { bloqueios: { c: { ate: 4 * H, exato: true }, d: { ate: 3 * H, exato: false } } });
});
