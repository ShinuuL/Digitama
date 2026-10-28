// Menções com "@" na caixa de mensagem: @arquivo (anexa o arquivo) e @agente
// (o OpenCode chama aquele agente nesta mensagem, sem trocar o da conversa).
// Ideia trazida do OpenChamber (MIT); a busca é nossa: lista de arquivos do
// próprio VS Code (respeita files.exclude e .gitignore via search.exclude) e
// ranking simples, sem depender de rota do servidor.

export interface Achado {
  /** Caminho relativo à pasta do projeto, com "/". */
  rel: string;
  pontos: number;
}

/** Pontua um caminho para a busca: nome que começa igual vale mais que trecho no meio do caminho. */
export function pontuar(rel: string, q: string): number {
  const alvo = rel.toLowerCase();
  const nome = alvo.slice(alvo.lastIndexOf("/") + 1);
  const busca = q.toLowerCase().replace(/\\/g, "/");
  if (!busca) return 1;
  if (nome === busca) return 1000;
  if (nome.startsWith(busca)) return 800 - nome.length;
  if (nome.includes(busca)) return 600 - nome.length;
  if (alvo.includes(busca)) return 400 - alvo.length / 10;
  // letras na ordem, com buracos ("extts" acha "extension.ts")
  let i = 0;
  for (const c of nome) if (c === busca[i]) i++;
  if (i === busca.length) return 200 - nome.length;
  return 0;
}

/** Os melhores caminhos para a busca, em ordem. Rasos primeiro no empate. */
export function buscar(caminhos: string[], q: string, limite = 30): string[] {
  const achados: Achado[] = [];
  for (const rel of caminhos) {
    const pontos = pontuar(rel, q);
    if (pontos > 0) achados.push({ rel, pontos });
  }
  achados.sort((a, b) => b.pontos - a.pontos || a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
  return achados.slice(0, limite).map((a) => a.rel);
}

export interface MencaoAgente {
  name: string;
  mention: { start: number; end: number; text: string };
}

/** Acha "@nome" de agentes conhecidos no texto (palavra inteira), na ordem em que aparecem. */
export function mencoesDeAgentes(texto: string, nomes: string[]): MencaoAgente[] {
  const r: MencaoAgente[] = [];
  const conhecidos = new Set(nomes);
  for (const m of texto.matchAll(/(^|\s)@([\w.-]+)(?=$|[\s,.;:!?)])/g)) {
    const nome = m[2];
    if (!conhecidos.has(nome)) continue;
    const start = m.index! + m[1].length;
    r.push({ name: nome, mention: { start, end: start + nome.length + 1, text: "@" + nome } });
  }
  return r;
}
