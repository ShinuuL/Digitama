// Atualizações: do OpenCode (versão do serviço × a mais nova no npm; atualizar
// roda `opencode upgrade` no terminal, à vista) e desta extensão (o .vsix do
// release mais novo no GitHub do Digitama). Nada se instala sem o seu clique.

export const REPO_PADRAO = "ShinuuL/Digitama";
export const PADRAO_VSIX = /^digitama-opencode-(\d+\.\d+\.\d+)\.vsix$/;

/** Compara versões x.y.z (ignora "v" e sufixos); >0 se a > b. */
export function comparar(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export const repoValido = (r: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);

export interface ReleaseVsix {
  versao: string;
  tag: string;
  url: string;
  pagina: string;
  notas: string;
}

/** O release mais novo (não rascunho) que traz o .vsix da extensão. */
export function acharVsix(releases: any[], repo: string): ReleaseVsix | undefined {
  const base = `https://github.com/${repo}/releases/download/`;
  let melhor: ReleaseVsix | undefined;
  for (const r of releases ?? []) {
    if (r.draft) continue;
    for (const a of r.assets ?? []) {
      const m = String(a.name ?? "").match(PADRAO_VSIX);
      const url = String(a.browser_download_url ?? "");
      // só baixa do próprio repositório, nunca de um link qualquer
      if (!m || !url.startsWith(base)) continue;
      if (!melhor || comparar(m[1], melhor.versao) > 0) melhor = { versao: m[1], tag: r.tag_name, url, pagina: r.html_url, notas: String(r.body ?? "") };
    }
  }
  return melhor;
}

export async function ultimaExtensao(repo: string): Promise<ReleaseVsix | undefined> {
  if (!repoValido(repo)) throw new Error(`Repositório inválido: ${repo}`);
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=15`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "digitama-opencode" },
  });
  if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao listar os releases de ${repo}.`);
  return acharVsix(await r.json(), repo);
}

/**
 * A v2 do OpenCode é o pacote `@opencode/cli` (o antigo `opencode-ai` parou na 1.x).
 * Versões 1.x instaladas seguem comparando com o pacote antigo.
 */
export async function ultimoOpencode(atual?: string): Promise<string | undefined> {
  const pacote = atual && comparar(atual, "2.0.0") < 0 ? "opencode-ai" : "@opencode%2Fcli";
  const r = await fetch(`https://registry.npmjs.org/${pacote}/latest`, { headers: { accept: "application/json" } });
  if (!r.ok) return undefined;
  return (await r.json())?.version;
}

export async function baixar(url: string, destino: string): Promise<void> {
  const fs = await import("node:fs");
  const r = await fetch(url, { headers: { "user-agent": "digitama-opencode" } });
  if (!r.ok) throw new Error(`Download falhou (${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  // um .vsix é um zip: começa com "PK"
  if (buf.length < 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("O arquivo baixado não parece um .vsix.");
  fs.writeFileSync(destino, buf);
}
