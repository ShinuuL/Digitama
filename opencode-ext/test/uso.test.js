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

test("janelas diferentes: mescla pelo maior limite e bloqueio vigente", () => {
  const a = { limites: { c: 1000 }, bloqueios: { c: 5 * H, velho: 1 } };
  const b = { limites: { c: 3000, d: 10 }, bloqueios: { c: 4 * H } };
  assert.deepStrictEqual(u.mesclar(a, b, 2 * H), { limites: { c: 3000, d: 10 }, bloqueios: { c: 5 * H } });
});

test("recusa aprende o limite (só sobe) e bloqueia; situação mostra pct e esgotado", () => {
  const d = u.vazio();
  u.marcarLimite(d, "c", 5000, 6 * H);
  u.marcarLimite(d, "c", 0, 6 * H);
  assert.strictEqual(d.limites.c, 5000);
  assert.deepStrictEqual(u.situacao(d, "c", 2500, 3 * H), { usado: 2500, limite: 5000, pct: 50, esgotadoAte: 6 * H });
  assert.strictEqual(u.situacao(d, "c", 0, 7 * H).esgotadoAte, undefined);
});

test("primeiro uso da janela por bisseção (libera 5 h depois dele)", async () => {
  const agora = 10 * H;
  const primeiro = 7 * H + 12 * 60_000;
  const temPassos = async (de, ate) => ate >= primeiro && de <= agora;
  const achado = await u.primeiroUso(temPassos, agora);
  assert.ok(Math.abs(achado - primeiro) <= 60_000, String(achado - primeiro));
  assert.strictEqual(await u.primeiroUso(async () => false, agora), undefined);
});
