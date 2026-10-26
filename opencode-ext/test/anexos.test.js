const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classificar, comCaminhos, textoGrande } = require("../out/anexos");
const { comparar, acharVsix, repoValido } = require("../out/atualizacoes");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anexos-"));
const arq = (nome, conteudo) => {
  const p = path.join(dir, nome);
  fs.writeFileSync(p, conteudo);
  return p;
};

test("texto vai como arquivo; binário, pasta e mídia não suportada vão pelo caminho", () => {
  assert.strictEqual(classificar(arq("a.ts", "const x = 1;"), []).modo, "arquivo");
  assert.strictEqual(classificar(arq("LEIAME", "sem extensão mas é texto"), []).modo, "arquivo");
  assert.match(classificar(arq("a.ts", "x"), []).uri, /^file:\/\//);
  const zip = classificar(arq("b.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 1])), []);
  assert.deepStrictEqual([zip.modo, zip.motivo], ["caminho", "tipo não suportado"]);
  assert.strictEqual(classificar(dir, []).motivo, "pasta");
  assert.strictEqual(classificar(path.join(dir, "nao-existe.txt"), []).motivo, "não encontrado");
});

test("imagem/PDF só vão como arquivo se o modelo lê esse tipo", () => {
  const png = arq("c.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  assert.strictEqual(classificar(png, ["image"]).modo, "arquivo");
  const sem = classificar(png, []);
  assert.deepStrictEqual([sem.modo, sem.motivo], ["caminho", "o modelo não lê imagens"]);
  assert.strictEqual(classificar(arq("d.pdf", "%PDF-1.4"), ["image"]).motivo, "o modelo não lê PDF");
});

test("caminhos entram no fim da mensagem", () => {
  const t = comCaminhos("Olhe isto", [{ nome: "b.zip", modo: "caminho", caminho: "C:\\x\\b.zip", motivo: "tipo não suportado" }, { nome: "a.ts", modo: "arquivo" }]);
  assert.match(t, /^Olhe isto\n\nArquivos anexados pelo caminho/);
  assert.match(t, /- C:\\x\\b\.zip \(tipo não suportado\)/);
  assert.ok(!t.includes("a.ts"));
  assert.strictEqual(comCaminhos("só texto", []), "só texto");
});

test("texto colado grande: mais de 2 linhas ou muito longo", () => {
  assert.ok(!textoGrande("uma\nduas"));
  assert.ok(textoGrande("1\n2\n3"));
  assert.ok(textoGrande("x".repeat(1600)));
});

test("versões e releases: só o .vsix do próprio repositório, o mais novo", () => {
  assert.ok(comparar("0.4.10", "0.4.9") > 0);
  assert.strictEqual(comparar("v1.2.3", "1.2.3"), 0);
  assert.ok(comparar("0.5.0", "0.4.5") > 0);
  const repo = "ShinuuL/Digitama";
  const base = `https://github.com/${repo}/releases/download/`;
  const rels = [
    { tag_name: "v0.4.0", html_url: "p1", assets: [{ name: "digitama-opencode-0.4.5.vsix", browser_download_url: base + "v0.4.0/digitama-opencode-0.4.5.vsix" }] },
    { tag_name: "v0.5.0", draft: true, assets: [{ name: "digitama-opencode-0.9.0.vsix", browser_download_url: base + "x/digitama-opencode-0.9.0.vsix" }] },
    { tag_name: "v0.4.1", html_url: "p2", assets: [{ name: "digitama-opencode-0.5.0.vsix", browser_download_url: base + "v0.4.1/digitama-opencode-0.5.0.vsix" }, { name: "Digitama_0.4.1_x64-setup.exe", browser_download_url: base + "a.exe" }] },
    { tag_name: "falso", assets: [{ name: "digitama-opencode-9.9.9.vsix", browser_download_url: "https://evil.example/digitama-opencode-9.9.9.vsix" }] },
  ];
  const r = acharVsix(rels, repo);
  assert.deepStrictEqual([r.versao, r.tag, r.pagina], ["0.5.0", "v0.4.1", "p2"]);
  assert.ok(repoValido("ShinuuL/Digitama") && !repoValido("a/b/c") && !repoValido("x y/z"));
});
