const test = require("node:test");
const assert = require("node:assert");
const { assinatura, chamadaEmTexto, DetectorRepeticao } = require("../out/repeticao");

function coletor() {
  const paradas = [];
  const d = new DetectorRepeticao((sessao, ferramenta, motivo) => paradas.push({ sessao, ferramenta, motivo }));
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
  assert.deepStrictEqual(paradas, [{ sessao: "s1", ferramenta: "read", motivo: "seguidas" }]);
});

test("uma chamada diferente no meio zera a contagem de seguidas", () => {
  const { d, paradas } = coletor();
  for (let i = 0; i < 3; i++) {
    d.ferramenta("s1", "read", { file: "a.ts" });
    d.ferramenta("s1", "read", { file: "b.ts" });
  }
  assert.deepStrictEqual(paradas, [], "alternar poucas vezes ainda não é loop");
});

test("ciclo curto que volta sempre à mesma chamada interrompe", () => {
  const { d, paradas } = coletor();
  for (let i = 0; i < 3; i++) {
    d.ferramenta("s1", "read", { file: "a.ts" });
    d.ferramenta("s1", "edit", { file: "a.ts" });
  }
  assert.deepStrictEqual(paradas, []);
  d.ferramenta("s1", "read", { file: "a.ts" });
  assert.deepStrictEqual(paradas, [{ sessao: "s1", ferramenta: "read", motivo: "ciclo" }]);
});

test("chamadas espalhadas fora da janela não contam como ciclo", () => {
  const { d, paradas } = coletor();
  for (let i = 0; i < 6; i++) {
    d.ferramenta("s1", "read", { file: "a.ts" });
    for (let j = 0; j < 3; j++) d.ferramenta("s1", "grep", { pattern: `p${i}${j}` });
  }
  assert.deepStrictEqual(paradas, []);
});

test("chamada de ferramenta escrita como texto é reconhecida", () => {
  assert.ok(chamadaEmTexto('[tool_call tool=functions.write]({"path":"x.md","content":"oi"})'));
  assert.ok(chamadaEmTexto("Vou criar.\n<tool_call>\n{\"name\":\"write\"}\n</tool_call>"));
  assert.ok(chamadaEmTexto('{"name": "bash", "arguments": {"command": "ls"}}'));
  assert.ok(chamadaEmTexto('functions.edit({"file":"a"})'));
  assert.ok(!chamadaEmTexto("Criei o arquivo e rodei os testes."));
  assert.ok(!chamadaEmTexto('Exemplo:\n```json\n{"name": "bash", "arguments": {}}\n```'), "exemplo em bloco de código não conta");
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
