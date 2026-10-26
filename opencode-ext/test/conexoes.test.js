const test = require("node:test");
const assert = require("node:assert");
const { mascarar, idDe, PADRAO } = require("../out/conexoes");

test("tokens e chaves nunca aparecem na saída", () => {
  assert.strictEqual(mascarar("Token: gho_abcdefghijklmnop123"), "Token: gho_****");
  assert.strictEqual(mascarar("github_pat_11ABCDEFG0123456789"), "github_pat_****");
  assert.strictEqual(mascarar("sk-1234567890abcdefXYZ"), "sk-****");
  assert.strictEqual(mascarar("api_key=segredo123"), "api_key=****");
  assert.strictEqual(mascarar("password: hunter2"), "password: ****");
  assert.ok(!mascarar("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123").includes("eyJhbGci"));
  assert.strictEqual(mascarar("Logged in to github.com account ShinuuL"), "Logged in to github.com account ShinuuL");
});

test("id novo não repete os existentes", () => {
  assert.strictEqual(idDe("Vercel CLI", []), "vercel-cli");
  assert.strictEqual(idDe("GitHub", PADRAO.map((c) => c.id)), "github-2");
  assert.strictEqual(idDe("!!!", []), "conexao");
});

test("conexões padrão têm status e as de login têm comando oficial", () => {
  for (const c of PADRAO) assert.ok(c.status && c.nome && c.id);
  assert.strictEqual(PADRAO.find((c) => c.id === "github").login, "gh auth login --web");
});
