const test = require("node:test");
const assert = require("node:assert");
const { pontuar, buscar, mencoesDeAgentes } = require("../out/mencoes");

const arquivos = ["src/extension.ts", "src/uso.ts", "test/uso.test.js", "media/main.js", "README.md", "src/deep/a/b/uso.ts"];

test("nome igual > começa com > contém > trecho do caminho > letras na ordem", () => {
  assert.ok(pontuar("src/uso.ts", "uso.ts") > pontuar("test/uso.test.js", "uso"));
  assert.ok(pontuar("src/uso.ts", "uso") > pontuar("src/extension.ts", "ten"));
  assert.ok(pontuar("src/extension.ts", "ten") > pontuar("src/extension.ts", "src/ext"));
  assert.ok(pontuar("src/extension.ts", "extts") > 0, "letras na ordem com buracos");
  assert.strictEqual(pontuar("README.md", "zzz"), 0);
});

test("buscar ordena, desempata pelo mais raso e corta no limite", () => {
  assert.deepStrictEqual(buscar(arquivos, "uso").slice(0, 2), ["src/uso.ts", "src/deep/a/b/uso.ts"]);
  assert.strictEqual(buscar(arquivos, "", 3).length, 3);
  assert.deepStrictEqual(buscar(arquivos, "nada-disso"), []);
  assert.deepStrictEqual(buscar(arquivos, "src\\uso"), ["src/uso.ts"], "barra invertida do Windows");
});

test("menções de agentes: só nomes conhecidos, palavra inteira, com a posição", () => {
  const t = "@explore veja isso e chame @general, não @desconhecido nem email@explore.com";
  const r = mencoesDeAgentes(t, ["explore", "general"]);
  assert.deepStrictEqual(r.map((m) => m.name), ["explore", "general"]);
  assert.deepStrictEqual(r[0].mention, { start: 0, end: 8, text: "@explore" });
  assert.strictEqual(t.slice(r[1].mention.start, r[1].mention.end), "@general");
  assert.deepStrictEqual(mencoesDeAgentes("@src/uso.ts", ["explore"]), [], "@arquivo não vira agente");
});
