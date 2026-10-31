// Markdown das respostas, no que o Claude Code usa: parágrafos, títulos,
// listas (com níveis), tabelas, citações, blocos de código, `código`,
// **negrito**, *itálico* e [links](url). Tudo é escapado antes: nenhum HTML
// vindo do texto chega à página.

import { svg } from "../shared/svg";
export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Marcações de dentro da linha (o texto já vem escapado). */
function inline(s: string) {
  const codes: string[] = [];
  // o código primeiro, para nada dentro dele virar negrito ou link
  let out = s.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" title="$2">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
}

/** Listas: "- ", "* " ou "1. ", com níveis pelo recuo (2 espaços). */
function list(lines: string[]) {
  let html = "";
  const stack: { indent: number; tag: string }[] = [];
  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+([\s\S]*)$/.exec(line)!;
    const indent = m[1].replace(/\t/g, "  ").length;
    const tag = /\d/.test(m[2]) ? "ol" : "ul";
    while (stack.length && indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
    const top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      html += `<${tag}>`;
      stack.push({ indent, tag });
    } else {
      html += "</li>";
    }
    // linhas que continuam o item: texto corrido, ou citação ("> …") dentro dele
    const [first, ...more] = m[3].split("\n");
    let body = inline(first);
    const quote: string[] = [];
    for (const extra of more) {
      if (/^&gt;\s?/.test(extra)) quote.push(inline(extra.replace(/^&gt;\s?/, "")));
      else body += " " + inline(extra);
    }
    if (quote.length) body += `<blockquote>${quote.join("<br>")}</blockquote>`;
    html += `<li>${body}`;
  }
  while (stack.length) html += `</li></${stack.pop()!.tag}>`;
  return html;
}

const IS_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/** Texto (sem os blocos de código) em HTML de blocos. */
function blocks(text: string) {
  const lines = esc(text).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    // tabela: cabeçalho | separador | linhas
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j].includes("|") && lines[j].trim()) rows.push(cells(lines[j++]));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      i = j - 1;
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^&gt;\s?/, ""));
      i--;
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (IS_ITEM.test(line)) {
      flush();
      const items: string[] = [];
      // itens e as linhas recuadas que continuam um item
      while (i < lines.length && (IS_ITEM.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        if (IS_ITEM.test(lines[i])) items.push(lines[i]);
        else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      i--;
      out.push(list(items));
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("");
}

/** Botões de copiar (o clique é tratado no chat: copia o bloco ou a mensagem). */
const COPY_CODE = `<button class="copy" title="Copiar o código">${svg("copy")}</button>`;
const COPY_MSG = `<button class="copy msg-copy" title="Copiar a mensagem">${svg("copy")}</button>`;

/** Markdown de uma resposta inteira, com o botão de copiar a mensagem. */
export function mdMsg(src: string): string {
  return COPY_MSG + md(src);
}

export function md(src: string): string {
  return src
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf("\n");
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        return `<div class="code">${COPY_CODE}<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`;
      }
      return blocks(part);
    })
    .join("");
}
