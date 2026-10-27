const test = require("node:test");
const assert = require("node:assert");
const { assinatura, DetectorRepeticao } = require("../out/repeticao");

function coletor() {
  const paradas = [];
  const d = new DetectorRepeticao((sessao, ferramenta) => paradas.push({ sessao, ferramenta }));
  return { d, paradas };
}

test("assinatura é estável: a ordem das chaves não muda a identidade", () => {
  assert.strictEqual(
    assinatura("read", { a: 1, b: { c: 2, d: [3] } }),
    assinatura("read", { b: { d: [3], c: 2 }, a: 1 }),
  );
  assert.notStrictEqual(assinatura("read", { file: "a" }), assinatura("read", { file: "b" }));
  assert.notStrictEqual(assinatura("read", { file: "a" }), assinatura("grep", { file: "a" }));
});

test("duas chamadas iguais são toleradas; a terceira seguida interrompe", () => {
  const { d, paradas } = coletor();
  d.ferramenta("s1", "read", { file: "a.ts" });
  d.ferramenta("s1", "read", { file: "a.ts" });
  assert.deepStrictEqual(paradas, []);
  d.ferramenta("s1", "read", { file: "a.ts" });
  assert.deepStrictEqual(paradas, [{ sessao: "s1", ferramenta: "read" }]);
});

test("uma chamada diferente no meio zera a contagem", () => {
  const { d, paradas } = coletor();
  for (let i = 0; i < 5; i++) {
    d.ferramenta("s1", "read", { file: "a.ts" });
    d.ferramenta("s1", "read", { file: "b.ts" });
  }
  assert.deepStrictEqual(paradas, [], "alternar entre duas chamadas não é loop");
});

test("mudar a entrada conta como chamada nova", () => {
  const { d, paradas } = coletor();
  d.ferramenta("s1", "grep", { pattern: "a" });
  d.ferramenta("s1", "grep", { pattern: "b" });
  d.ferramenta("s1", "grep", { pattern: "c" });
  assert.deepStrictEqual(paradas, []);
});

test("cada sessão conta separado e zerar esquece", () => {
  const { d, paradas } = coletor();
  d.ferramenta("s1", "read", { file: "a" });
  d.ferramenta("s1", "read", { file: "a" });
  d.ferramenta("s2", "read", { file: "a" });
  assert.deepStrictEqual(paradas, []);
  d.zerar("s1");
  d.ferramenta("s1", "read", { file: "a" });
  d.ferramenta("s1", "read", { file: "a" });
  assert.deepStrictEqual(paradas, []);
});

test("depois de interromper, recomeça a contagem do zero", () => {
  const { d, paradas } = coletor();
  for (let i = 0; i < 3; i++) d.ferramenta("s1", "read", { file: "a" });
  assert.strictEqual(paradas.length, 1);
  d.ferramenta("s1", "read", { file: "a" });
  d.ferramenta("s1", "read", { file: "a" });
  assert.strictEqual(paradas.length, 1, "não dispara de novo sem três novas chamadas");
});
