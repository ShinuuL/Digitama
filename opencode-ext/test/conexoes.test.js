const test = require("node:test");
const assert = require("node:assert");
const { mascarar, idDe, PADRAO, contasDe } = require("../out/conexoes");

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

test("Google Cloud e Firebase: logado só com conta impressa na saída", () => {
  assert.deepStrictEqual(contasDe("dev@empresa.com.br\n"), ["dev@empresa.com.br"]);
  assert.deepStrictEqual(contasDe("Logged in as dev@empresa.com.br\nLogged in as dev@empresa.com.br"), ["dev@empresa.com.br"]);
  assert.deepStrictEqual(contasDe(""), [], "gcloud sem conta ativa sai com 0 e nada impresso");
  assert.deepStrictEqual(contasDe("No authorized accounts, run \"firebase login\""), []);
  for (const id of ["gcloud", "firebase"]) {
    const c = PADRAO.find((x) => x.id === id);
    assert.ok(c && c.login && c.logout && c.instalar, id);
  }
});
