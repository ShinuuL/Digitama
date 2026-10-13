// O menu circular do pet, no estilo do Digivice: hexágonos num arco em volta
// do Digimon, abrindo em giro, com a faixa azul mostrando o item sob o mouse.
import { iconImg } from "../shared/icons";

export interface RingItem {
  icon: string;
  label: string;
  color?: string;
  danger?: boolean;
  run: () => void;
}

export class Ring {
  readonly root = document.createElement("div");
  private banner = document.createElement("div");
  private orbit = document.createElement("div");
  onChange: () => void = () => {};

  constructor(host: HTMLElement) {
    this.root.className = "ring hidden";
    this.orbit.className = "ring-orbit";
    this.banner.className = "dv-banner ring-banner";
    host.appendChild(this.root);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  get visible() {
    return !this.root.classList.contains("hidden");
  }

  /** Abre centrado em (cx, cy), contido na janela de `w`×`h`. */
  open(cx: number, cy: number, radius: number, items: RingItem[], w: number, h: number) {
    const R = radius;
    const x = Math.max(R + 34, Math.min(w - R - 34, cx));
    // o círculo inteiro precisa caber na janela (a faixa fica acima dele)
    const y = Math.max(R + 70, Math.min(h - R - 22, cy));
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
    // a caixa cobre o anel e a faixa: é a área clicável enquanto o menu está aberto
    this.root.style.setProperty("--d", `${R * 2 + 150}px`);
    this.orbit.style.width = this.orbit.style.height = `${R * 2}px`;
    this.root.replaceChildren(this.orbit);
    this.banner.textContent = items[0]?.label ?? "";
    this.banner.style.top = `${-R - 58}px`;
    this.root.append(this.banner);
    // arco de 220°: da esquerda (um pouco abaixo) por cima até a direita
    const from = -200, to = 20;
    items.forEach((item, i) => {
      const a = ((from + ((to - from) * i) / Math.max(1, items.length - 1)) * Math.PI) / 180;
      const b = document.createElement("button");
      b.className = `hex ring-item${item.danger ? " danger" : ""}`;
      b.style.setProperty("--x", `${Math.cos(a) * R}px`);
      b.style.setProperty("--y", `${Math.sin(a) * R}px`);
      b.style.setProperty("--i", String(i));
      b.title = item.label;
      b.append(iconImg(item.icon, item.color ?? "#ffd23f", 3));
      b.onmouseenter = () => {
        this.banner.textContent = item.label;
        this.root.querySelectorAll(".ring-item.on").forEach((e) => e.classList.remove("on"));
        b.classList.add("on");
      };
      b.onclick = (e) => {
        e.stopPropagation();
        this.close();
        item.run();
      };
      this.root.append(b);
    });
    this.root.classList.remove("hidden");
    // reinicia a animação de abertura
    this.root.classList.remove("opening");
    void this.root.offsetWidth;
    this.root.classList.add("opening");
    this.onChange();
  }

  close() {
    if (!this.visible) return;
    this.root.classList.add("hidden");
    this.onChange();
  }
}
