// Ícones de interface em SVG (traço de 24×24, cor do texto). Substituem os
// emojis nos botões e avisos: ficam iguais em qualquer Windows e no tema.

const PATHS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  paperclip: '<path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4L15 7.6"/>',
  camera: '<path d="M4 7.5h3.5L9 5h6l1.5 2.5H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  "chev-down": '<path d="M6 9l6 6 6-6"/>',
  "chev-right": '<path d="M9 6l6 6-6 6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  off: '<circle cx="12" cy="12" r="9"/>',
  warn: '<path d="M12 3 2 20h20zM12 10v4M12 17v.5"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  previous: '<path d="M5 4h2v16H5zM20 4v16L9 12z" fill="currentColor" stroke="none"/>',
  next: '<path d="M17 4h2v16h-2zM4 4v16l11-8z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
};

export type SvgName = keyof typeof PATHS;

/** O SVG como texto, para `innerHTML` (só nomes fixos daqui, nada vindo de fora). */
export function svg(name: SvgName, size = 14): string {
  return `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}

/** O SVG como elemento. */
export function svgEl(name: SvgName, size = 14): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = svg(name, size);
  return t.content.firstElementChild as SVGSVGElement;
}

/** Ícone seguido de texto (o texto entra como texto, nunca como HTML). */
export function withIcon(target: HTMLElement, name: SvgName, text: string, size = 14) {
  target.replaceChildren(svgEl(name, size), document.createTextNode(text ? ` ${text}` : ""));
}
