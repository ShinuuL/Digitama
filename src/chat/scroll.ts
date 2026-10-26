// Rolagem que respeita a leitura: a conversa só acompanha o fim se você já
// está lá. Rolou para cima para ler? Aparece "↓ novas mensagens" em vez de a
// tela pular a cada pedaço de resposta.

let log: HTMLElement | null = null;
let jump: HTMLElement | null = null;
/** Você está no fim da conversa (medido a cada rolagem). */
let stuck = true;

export function initScroll(logEl: HTMLElement, jumpEl: HTMLElement) {
  log = logEl;
  jump = jumpEl;
  log.addEventListener("scroll", () => {
    stuck = log!.scrollHeight - log!.scrollTop - log!.clientHeight < 60;
    if (stuck) jump!.classList.add("hidden");
  });
  jump.onclick = () => toEnd();
}

/** Algo novo entrou: desce junto se você estava no fim; senão, avisa. */
export function follow() {
  if (!log) return;
  if (stuck) log.scrollTop = log.scrollHeight;
  else jump?.classList.remove("hidden");
}

export function toEnd() {
  if (!log) return;
  stuck = true;
  log.scrollTop = log.scrollHeight;
  jump?.classList.add("hidden");
}
