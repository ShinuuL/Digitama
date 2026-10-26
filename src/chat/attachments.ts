// Anexos do chat: arquivos (📎, arrastar e soltar, colar), o print do recorte
// e o texto colado grande, que vira um .txt em vez de lotar a caixa. O backend
// (claude.rs) transforma cada um num bloco da mensagem: imagem, documento PDF
// ou texto com o nome do arquivo.
import type { Attachment } from "../shared/api";

/** Limites da API por anexo (imagem 5 MB, PDF 30 MB) e o nosso para texto. */
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_PDF = 30 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

const IMAGE_OK = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_EXT = new Set(
  "txt md markdown csv tsv json jsonl xml html htm css scss js mjs cjs ts tsx jsx vue svelte py rb php java kt cs go rs c h cpp hpp swift sql sh bash ps1 psm1 bat cmd yml yaml toml ini cfg conf log env properties gradle dockerfile gitignore editorconfig".split(" "),
);

/** Texto colado com mais que isso de linhas (ou muito comprido) vira anexo. */
export const PASTE_LINES = 2;
export const PASTE_CHARS = 2000;

export function isBigPaste(text: string) {
  return text.split(/\r?\n/).length > PASTE_LINES || text.length > PASTE_CHARS;
}

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ext(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

function base64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Imagem em formato que a API não lê (bmp, tiff…): vira PNG pelo canvas. */
async function toPng(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const url = c.toDataURL("image/png");
  c.width = c.height = 0;
  return url.slice(url.indexOf(",") + 1);
}

/** Um arquivo vira anexo, ou erro com o motivo (tipo ou tamanho). */
export async function fromFile(file: File): Promise<Attachment> {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) {
    if (file.size > MAX_IMAGE) throw new Error(`${file.name}: imagem acima de 5 MB`);
    if (IMAGE_OK.includes(type)) return { kind: "image", name: file.name, mediaType: type, data: base64(await file.arrayBuffer()) };
    return { kind: "image", name: file.name.replace(/\.\w+$/, "") + ".png", mediaType: "image/png", data: await toPng(file) };
  }
  if (type === "application/pdf" || ext(file.name) === "pdf") {
    if (file.size > MAX_PDF) throw new Error(`${file.name}: PDF acima de 30 MB`);
    return { kind: "pdf", name: file.name, mediaType: "application/pdf", data: base64(await file.arrayBuffer()) };
  }
  if (file.size > MAX_TEXT) throw new Error(`${file.name}: arquivo de texto acima de 1 MB`);
  const text = await file.text();
  // binário disfarçado (exe, zip, docx…): tem byte nulo ou muito caractere inválido
  const bad = (text.match(/�|\u0000/g) ?? []).length;
  if (!(type.startsWith("text/") || TEXT_EXT.has(ext(file.name))) && bad > 0)
    throw new Error(`${file.name}: só imagens, PDF e arquivos de texto`);
  if (bad > text.length / 50) throw new Error(`${file.name}: não parece ser texto`);
  return { kind: "text", name: file.name, mediaType: type || "text/plain", data: text };
}

let pasted = 0;
export function fromPaste(text: string): Attachment {
  pasted++;
  return { kind: "text", name: `colado-${pasted}.txt`, mediaType: "text/plain", data: text };
}

/** Tamanho aproximado (bytes) do conteúdo. */
export function bytesOf(a: Attachment) {
  return a.kind === "text" ? new Blob([a.data]).size : Math.floor((a.data.length * 3) / 4);
}
