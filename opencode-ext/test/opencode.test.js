const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { contextoUsado, cortarSse, dadosSse, urlDoStatus, travaValida, pegarTrava, TRAVA_MS } = require("../out/opencode");

test("contexto soma entrada, cache e saída do último passo", () => {
  assert.strictEqual(contextoUsado({ input: 131, output: 11, reasoning: 134, cache: { read: 6482, write: 0 } }), 6624);
  assert.strictEqual(contextoUsado(undefined), 0);
});

test("SSE: corta blocos completos e guarda o resto", () => {
  const { blocos, resto } = cortarSse('data: {"type":"a"}\n\n: heartbeat\n\ndata: {"ty');
  assert.deepStrictEqual(blocos, ['data: {"type":"a"}', ": heartbeat"]);
  assert.strictEqual(resto, 'data: {"ty');
  assert.deepStrictEqual(cortarSse("data: 1\r\n\r\n").blocos, ["data: 1"]);
});

test("SSE: heartbeat e JSON quebrado viram undefined", () => {
  assert.deepStrictEqual(dadosSse('data: {"type":"session.text.delta"}'), { type: "session.text.delta" });
  assert.strictEqual(dadosSse(": heartbeat"), undefined);
  assert.strictEqual(dadosSse("data: {x"), undefined);
});

test("endereço do serviço vem do status", () => {
  assert.strictEqual(urlDoStatus("http://127.0.0.1:28894\n"), "http://127.0.0.1:28894");
  assert.strictEqual(urlDoStatus("not running"), undefined);
});

test("argumento para o cmd: aspas com espaço, recusa o que o cmd interpreta", () => {
  const { argCmd } = require("../out/opencode");
  assert.strictEqual(argCmd("--mcp"), "--mcp");
  assert.strictEqual(argCmd("C:\\Users\\Zé Silva\\x.exe"), '"C:\\Users\\Zé Silva\\x.exe"');
  for (const ruim of ["a&b", "x|y", "%PATH%", 'a"b', "c>d", "e^f", "!x!"]) assert.throws(() => argCmd(ruim));
});

test("trava de subida: só uma janela pega; abandonada é retomada", () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "digitama-")), "sub", "subindo.lock");
  assert.ok(pegarTrava(arq));
  assert.ok(!pegarTrava(arq), "segunda janela espera");
  const velha = new Date(Date.now() - TRAVA_MS - 1000);
  fs.utimesSync(arq, velha, velha);
  assert.ok(pegarTrava(arq), "trava abandonada");
  assert.ok(!travaValida(undefined, 0));
  assert.ok(travaValida(0, TRAVA_MS - 1));
  assert.ok(!travaValida(0, TRAVA_MS));
  assert.ok(travaValida(10, 0), "mtime poucos ms à frente do relógio ainda vale");
  assert.ok(!travaValida(TRAVA_MS, 0), "data muito no futuro não vale");
});
