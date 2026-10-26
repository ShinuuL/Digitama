// Anexos da conversa. Vai como arquivo o que o modelo consegue ler (texto, e
// imagem/PDF/áudio/vídeo quando o modelo lê esse tipo); o resto (binários,
// pastas, arquivos grandes demais) vai só como CAMINHO no texto da mensagem,
// em vez de dar erro: o agente pode abrir pelo caminho com as ferramentas dele.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface Anexo {
  nome: string;
  /** "arquivo" vai em `files`; "caminho" vira uma linha no texto. */
  modo: "arquivo" | "caminho";
  uri?: string;
  caminho?: string;
  tamanho?: number;
  /** Por que foi como caminho (mostrado no chip). */
  motivo?: string;
}

export const LIMITE_BYTES = 8 * 1024 * 1024;

const TEXTO = new Set(
  ("txt md markdown json jsonc yaml yml toml ini cfg conf env xml html htm css scss less js mjs cjs jsx ts tsx vue svelte " +
    "py rb php java kt kts go rs c h cpp hpp cc cs fs swift dart lua sh bash zsh ps1 psm1 bat cmd sql csv tsv log " +
    "gitignore dockerfile makefile gradle properties lock graphql proto r m tex rst adoc").split(" "),
);
const MIDIA: Record<string, string> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  pdf: "pdf",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  mp4: "video", webm: "video", mov: "video", mkv: "video",
};
const ROTULO: Record<string, string> = { image: "imagens", pdf: "PDF", audio: "áudio", video: "vídeo" };

/** Arquivo sem extensão conhecida: é texto se o começo não tem byte nulo. */
function pareceTexto(p: string): boolean {
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

/**
 * Decide como cada arquivo vai. `entrada` é o que o modelo lê além de texto
 * (capabilities.input do modelo: "image", "pdf", "audio", "video").
 */
export function classificar(p: string, entrada: string[]): Anexo {
  const nome = path.basename(p);
  const caminho = (motivo: string, tamanho?: number): Anexo => ({ nome, modo: "caminho", caminho: p, tamanho, motivo });
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return caminho("não encontrado");
  }
  if (st.isDirectory()) return caminho("pasta");
  if (st.size > LIMITE_BYTES) return caminho(`maior que ${LIMITE_BYTES / 1024 / 1024} MB`, st.size);
  const ext = (path.extname(p).slice(1) || nome).toLowerCase();
  const midia = MIDIA[ext];
  if (midia) {
    return entrada.includes(midia)
      ? { nome, modo: "arquivo", uri: pathToFileURL(p).href, caminho: p, tamanho: st.size }
      : caminho(`o modelo não lê ${ROTULO[midia]}`, st.size);
  }
  if (TEXTO.has(ext) || pareceTexto(p)) return { nome, modo: "arquivo", uri: pathToFileURL(p).href, caminho: p, tamanho: st.size };
  return caminho("tipo não suportado", st.size);
}

/** Texto colado grande demais vira um .txt anexado (como no chat do Digitama). */
export function textoGrande(texto: string): boolean {
  return texto.split(/\r?\n/).length > 2 || texto.length > 1500;
}

/** Junta os anexos que foram como caminho ao fim da mensagem. */
export function comCaminhos(texto: string, anexos: Anexo[]): string {
  const caminhos = anexos.filter((a) => a.modo === "caminho" && a.caminho);
  if (!caminhos.length) return texto;
  const linhas = caminhos.map((a) => `- ${a.caminho}${a.motivo ? ` (${a.motivo})` : ""}`).join("\n");
  return `${texto}\n\nArquivos anexados pelo caminho (abra com as ferramentas se precisar):\n${linhas}`.trim();
}
