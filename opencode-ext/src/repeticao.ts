// Detecta quando o agente repete a MESMA chamada de ferramenta várias vezes
// seguidas: é o sintoma de loop que trava a conversa. Só conta chamadas
// consecutivas e idênticas (nome + entrada); qualquer chamada diferente zera a
// contagem. Quem decide interromper é quem usa o detector (extension.ts).

/** Quantas repetições idênticas seguidas ainda são toleradas antes de parar. */
export const REPETICOES_ATE_PARAR = 2;

/** JSON com chaves ordenadas: a mesma entrada sempre gera a mesma assinatura. */
function estavel(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return "[" + v.map(estavel).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + estavel(o[k])).join(",") + "}";
}

/** Identidade de uma chamada: nome da ferramenta + entrada normalizada. */
export function assinatura(nome: unknown, entrada: unknown): string {
  return `${String(nome ?? "")}:${estavel(entrada)}`;
}

export class DetectorRepeticao {
  private ultimo = new Map<string, { assinatura: string; vezes: number }>();

  constructor(
    private aoRepetir: (sessao: string, ferramenta: string) => void,
    private limite = REPETICOES_ATE_PARAR,
  ) {}

  /** Esquece a sessão (nova execução do usuário). */
  zerar(sessao: string): void {
    this.ultimo.delete(sessao);
  }

  /** Conta uma chamada; dispara `aoRepetir` na repetição que passa do limite. */
  ferramenta(sessao: string, nome: unknown, entrada: unknown): void {
    const a = assinatura(nome, entrada);
    const atual = this.ultimo.get(sessao);
    if (atual?.assinatura === a) {
      atual.vezes++;
      if (atual.vezes >= this.limite) {
        this.ultimo.delete(sessao);
        this.aoRepetir(sessao, String(nome ?? "ferramenta"));
      }
      return;
    }
    this.ultimo.set(sessao, { assinatura: a, vezes: 0 });
  }
}
