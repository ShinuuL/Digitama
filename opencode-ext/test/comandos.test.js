const test = require("node:test");
const assert = require("node:assert");
const { COMANDOS, lerComando, lerShell } = require("../out/comandos");

test("comandos locais pelo nome e pelo apelido em inglês", () => {
  assert.strictEqual(lerComando("/recarregar").cmd.nome, "recarregar");
  assert.strictEqual(lerComando("/reload").cmd.nome, "recarregar");
  assert.strictEqual(lerComando("/UNDO").cmd.nome, "desfazer");
  assert.deepStrictEqual(lerComando("/renomear  Meu título ").args, "Meu título");
  assert.strictEqual(lerComando("/init"), undefined); // é do servidor
  assert.strictEqual(lerComando("texto /reload"), undefined);
});

test("nomes e apelidos não se repetem", () => {
  const todos = COMANDOS.flatMap((c) => [c.nome, ...c.apelidos]);
  assert.strictEqual(new Set(todos).size, todos.length);
});

test("! vira comando de terminal", () => {
  assert.strictEqual(lerShell("!git status"), "git status");
  assert.strictEqual(lerShell("! ls -la"), "ls -la");
  assert.strictEqual(lerShell("oi!"), undefined);
});
