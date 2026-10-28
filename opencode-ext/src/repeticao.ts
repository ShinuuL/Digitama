// Detecta quando o agente fica preso repetindo chamadas de ferramenta: é o
// sintoma de loop que trava a conversa. Dois jeitos de cair em loop:
//  - a MESMA chamada várias vezes seguidas (A, A, A);
//  - um ciclo curto que volta sempre à mesma chamada (A, B, A, B, A, B, A).
// Identidade = nome + entrada normalizada. Quem decide interromper é quem usa o
// detector (extension.ts). Também reconhece a chamada de ferramenta "escrita"
// como texto na resposta, que nunca executa de verdade.

/** Quantas repetições idênticas seguidas ainda são toleradas antes de parar. */
export const REPETICOES_ATE_PARAR = 2;
/** Quantas chamadas recentes entram na conta do ciclo. */
export const JANELA_CICLO = 8;
/** Quantas vezes a mesma chamada pode aparecer na janela antes de parar. */
export const VEZES_NO_CICLO = 4;

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

export type MotivoRepeticao = "seguidas" | "ciclo";

export class DetectorRepeticao {
  private ultimo = new Map<string, { assinatura: string; vezes: number }>();
  private recentes = new Map<string, string[]>();

  constructor(
    private aoRepetir: (sessao: string, ferramenta: string, motivo: MotivoRepeticao) => void,
    private limite = REPETICOES_ATE_PARAR,
  ) {}

  /** Esquece a sessão (nova execução do usuário). */
  zerar(sessao: string): void {
    this.ultimo.delete(sessao);
    this.recentes.delete(sessao);
  }

  /** Conta uma chamada; dispara `aoRepetir` quando passa do limite. */
  ferramenta(sessao: string, nome: unknown, entrada: unknown): void {
    const a = assinatura(nome, entrada);
    const janela = this.recentes.get(sessao) ?? [];
    janela.push(a);
    if (janela.length > JANELA_CICLO) janela.shift();
    this.recentes.set(sessao, janela);

    const atual = this.ultimo.get(sessao);
    if (atual?.assinatura === a) {
      atual.vezes++;
      if (atual.vezes >= this.limite) return this.parar(sessao, nome, "seguidas");
      return;
    }
    this.ultimo.set(sessao, { assinatura: a, vezes: 0 });
    if (janela.filter((x) => x === a).length >= VEZES_NO_CICLO) this.parar(sessao, nome, "ciclo");
  }

  private parar(sessao: string, nome: unknown, motivo: MotivoRepeticao) {
    this.zerar(sessao);
    this.aoRepetir(sessao, String(nome ?? "ferramenta"), motivo);
  }
}

// Formatos de chamada de ferramenta que alguns modelos "imprimem" em vez de
// chamar: [tool_call tool=functions.write](...), <tool_call>, <function=...>,
// functions.edit({...}), {"name": "...", "arguments": ...}.
const CHAMADA_EM_TEXTO = [
  /\[tool_call\b/i,
  /<\/?tool_call>/i,
  /<function=\w+/i,
  /<\|tool_call/i,
  /\bfunctions\.\w+\s*\(\s*\{/,
  /\{\s*"name"\s*:\s*"[\w.-]+"\s*,\s*"(arguments|parameters|input)"\s*:/,
];

/**
 * A resposta tem uma chamada de ferramenta escrita como texto? Ignora blocos
 * de código (```), onde o agente pode estar só mostrando um exemplo.
 */
export function chamadaEmTexto(texto: string): boolean {
  const semCodigo = texto.replace(/```[\s\S]*?(```|$)/g, "");
  return CHAMADA_EM_TEXTO.some((r) => r.test(semCodigo));
}
