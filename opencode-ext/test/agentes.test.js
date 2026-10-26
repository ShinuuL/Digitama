const test = require("node:test");
const assert = require("node:assert");
const { gerar, lerFluxo, paraId, validar, MARCA } = require("../out/agentes");
const { regrasDoModo } = require("../out/opencode");

const etapa = (id, extra = {}) => ({ id, nome: id, descricao: `faz ${id}`, instrucoes: "", modelo: "", cor: "#3fe0ff", editar: "deny", terminal: "ask", web: "allow", ...extra });
const fluxo = (etapas) => ({ orquestrador: { id: "orq", nome: "Orq", descricao: "", modelo: "opencode/big-pickle" }, etapas });

test("ids viram minúsculas sem acento", () => {
  assert.strictEqual(paraId("Revisor de Código"), "revisor-de-codigo");
  assert.strictEqual(paraId("123 x"), "a-123-x");
  assert.strictEqual(paraId("!!"), "");
});

test("gera um subagente por etapa e um orquestrador que só chama essas etapas", () => {
  const arqs = gerar(fluxo([etapa("planejador", { modelo: "opencode/deepseek-v4.1-flash-free#high" }), etapa("revisor")]));
  assert.deepStrictEqual(arqs.map((a) => a.nome), ["planejador.md", "revisor.md", "orq.md"]);
  const p = arqs[0].conteudo;
  assert.match(p, /^---\ndescription: "faz planejador"\nmode: subagent\nmodel: "opencode\/deepseek-v4.1-flash-free#high"/);
  assert.match(p, /action: "edit"\n {4}resource: "\*"\n {4}effect: deny/);
  assert.ok(p.includes(MARCA));
  const o = arqs[2].conteudo;
  assert.match(o, /mode: primary/);
  assert.match(o, /action: "subagent"\n {4}resource: "\*"\n {4}effect: deny/);
  assert.match(o, /resource: "revisor"\n {4}effect: allow/);
  assert.match(o, /1\. \*\*planejador\*\*/);
});

test("texto com aspas e quebras não quebra o frontmatter", () => {
  const [a] = gerar(fluxo([etapa("x", { descricao: 'diz "oi"\n---\nmode: primary' })]));
  const fm = a.conteudo.split("\n---\n")[0];
  assert.ok(!/^mode: primary/m.test(fm.replace("mode: subagent", "")));
});

test("o fluxo volta do arquivo do orquestrador", () => {
  const f = fluxo([etapa("a"), etapa("b")]);
  const orq = gerar(f).at(-1).conteudo;
  assert.deepStrictEqual(lerFluxo(orq), f);
  assert.strictEqual(lerFluxo("sem marca"), undefined);
});

test("validação aponta fluxo vazio, ids repetidos e descrição faltando", () => {
  assert.ok(validar(fluxo([])).length);
  assert.ok(validar(fluxo([etapa("a"), etapa("a")])).some((e) => e.includes("repetidos")));
  assert.ok(validar(fluxo([etapa("a", { descricao: " " })])).some((e) => e.includes("descrição")));
  assert.deepStrictEqual(validar(fluxo([etapa("a")])), []);
});

test("modos de permissão: a última regra vence e fora do projeto sempre pergunta", () => {
  for (const modo of ["perguntar", "edicoes", "auto"]) {
    const r = regrasDoModo(modo);
    assert.deepStrictEqual(r.at(-1), { action: "external_directory", resource: "*", effect: "ask" });
  }
  assert.strictEqual(regrasDoModo("perguntar")[0].effect, "ask");
  assert.ok(!regrasDoModo("perguntar").some((x) => x.action === "edit"));
  assert.ok(regrasDoModo("edicoes").some((x) => x.action === "edit" && x.effect === "allow"));
  assert.strictEqual(regrasDoModo("auto")[0].effect, "allow");
});
