// Exibição do uso do plano do Claude (janela de 5 horas e semanal).
import type { Usage, UsageWindow } from "./api";

export function pct(w?: UsageWindow): number | null {
  return typeof w?.used_percentage === "number" ? Math.max(0, Math.min(100, w.used_percentage)) : null;
}

/** "reseta às 14:30" / "reseta seg 09:00". */
export function resetText(w?: UsageWindow): string {
  if (!w?.resets_at) return "";
  const d = new Date(w.resets_at * 1000);
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `reseta às ${hm}` : `reseta ${d.toLocaleDateString("pt-BR", { weekday: "short" })} ${hm}`;
}

/** Uma barra no estilo HP/SP com rótulo e porcentagem. */
export function usageRow(label: string, w: UsageWindow | undefined, kind: "hp" | "sp"): HTMLElement {
  const row = document.createElement("div");
  row.className = "usage-row";
  const p = pct(w);
  const name = document.createElement("span");
  name.className = "usage-label";
  name.textContent = label;
  const bar = document.createElement("div");
  bar.className = `dv-bar ${kind === "sp" ? "sp" : ""} ${p !== null && p >= 80 ? "danger" : ""}`;
  const fill = document.createElement("i");
  fill.style.width = `${p ?? 0}%`;
  bar.append(fill);
  const val = document.createElement("span");
  val.className = "usage-val";
  val.textContent = p === null ? "—" : `${Math.round(p)}%`;
  row.title = resetText(w);
  row.append(name, bar, val);
  return row;
}

export function usageBlock(u: Usage | null): HTMLElement {
  const box = document.createElement("div");
  box.className = "usage";
  if (!u || (pct(u.five_hour) === null && pct(u.seven_day) === null)) {
    box.textContent = "Uso do Claude: aparece depois que o Claude Code responder com a barra de status do Digitama ativa.";
    box.classList.add("usage-empty");
    return box;
  }
  box.append(usageRow("5h", u.five_hour, "hp"), usageRow("Semana", u.seven_day, "sp"));
  const r = [resetText(u.five_hour) && `5h ${resetText(u.five_hour)}`, resetText(u.seven_day) && `semana ${resetText(u.seven_day)}`]
    .filter(Boolean)
    .join(" · ");
  if (r) {
    const note = document.createElement("div");
    note.className = "usage-reset";
    note.textContent = r;
    box.append(note);
  }
  return box;
}
