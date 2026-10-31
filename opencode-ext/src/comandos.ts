// Comandos de barra da extensão (os do TUI do OpenCode, em português, com os
// nomes em inglês como apelido). Os do servidor (/init, /review…) e "!comando"
// (terminal) são tratados à parte no host.

export interface Comando {
  nome: string;
  apelidos: string[];
  descricao: string;
  icone: string;
  /** Texto de exemplo depois do comando, mostrado na sugestão. */
  args?: string;
  /** Precisa de uma conversa aberta. */
  sessao?: boolean;
}

export const COMANDOS: Comando[] = [
  { nome: "recarregar", apelidos: ["reload"], descricao: "Recarrega a conversa, agentes, modelos e a configuração do OpenCode", icone: "refresh" },
  { nome: "nova", apelidos: ["new", "clear"], descricao: "Começa uma conversa nova", icone: "plus" },
  { nome: "sessoes", apelidos: ["sessions", "resume"], descricao: "Escolhe uma conversa desta pasta", icone: "folder" },
  { nome: "parar", apelidos: ["stop", "interrupt"], descricao: "Interrompe a resposta atual", icone: "stop", sessao: true },
  { nome: "compactar", apelidos: ["compact", "summarize"], descricao: "Resume a conversa para liberar contexto", icone: "compress", sessao: true },
  { nome: "desfazer", apelidos: ["undo"], descricao: "Desfaz a última mensagem e as mudanças nos arquivos", icone: "refresh", sessao: true },
  { nome: "refazer", apelidos: ["redo"], descricao: "Volta o que o /desfazer tirou", icone: "refresh", sessao: true },
  { nome: "bifurcar", apelidos: ["fork"], descricao: "Copia a conversa numa nova, para tentar outro caminho", icone: "flow", sessao: true },
  { nome: "renomear", apelidos: ["rename", "title"], descricao: "Dá um título à conversa", icone: "pencil", args: "<título>", sessao: true },
  { nome: "arquivar", apelidos: ["archive"], descricao: "Arquiva a conversa (sai da lista)", icone: "trash", sessao: true },
  { nome: "exportar", apelidos: ["export"], descricao: "Abre a conversa inteira num editor (JSON)", icone: "file", sessao: true },
  { nome: "modelos", apelidos: ["models", "model"], descricao: "Troca o modelo", icone: "brain" },
  { nome: "agentes", apelidos: ["agents", "agent"], descricao: "Troca o agente", icone: "sparkle" },
  { nome: "montar", apelidos: ["builder"], descricao: "Abre o montador de agentes", icone: "users" },
  { nome: "modo", apelidos: ["mode", "permissions"], descricao: "Permissões: perguntar, edicoes ou auto", icone: "shield", args: "<perguntar|edicoes|auto>" },
  { nome: "skill", apelidos: [], descricao: "Usa uma skill nesta mensagem", icone: "sparkle", args: "<id> <mensagem>" },
  { nome: "mcp", apelidos: [], descricao: "Mostra os servidores MCP e o estado de cada um", icone: "tool" },
  { nome: "status", apelidos: [], descricao: "Versão, serviço, modelo e contexto", icone: "question" },
  { nome: "pair", apelidos: ["parear"], descricao: "Pareia celular ou navegador", icone: "phone" },
  { nome: "config", apelidos: ["settings", "configuracoes", "conexoes"], descricao: "Tema, conexões (GitHub, Cloudflare…) e MCPs", icone: "gear" },
  { nome: "atualizar", apelidos: ["upgrade", "update", "atualizacoes"], descricao: "Versões do OpenCode e da extensão, e atualizar", icone: "refresh" },
  { nome: "ajuda", apelidos: ["help", "?"], descricao: "Lista todos os comandos", icone: "question" },
];

/** Reconhece "/comando args" pelos nomes e apelidos; o resto não é comando local. */
export function lerComando(texto: string): { cmd: Comando; args: string } | undefined {
  const m = texto.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return undefined;
  const nome = m[1].toLowerCase();
  const cmd = COMANDOS.find((c) => c.nome === nome || c.apelidos.includes(nome));
  return cmd ? { cmd, args: m[2].trim() } : undefined;
}

/** As skills citadas como "/id" em qualquer ponto do texto (no começo ou no meio da frase). */
export function skillsCitadas(texto: string, ids: string[]): string[] {
  const conhecidas = new Set(ids);
  const achadas = [...texto.matchAll(/(?:^|\s)\/([\w:.-]+)(?=\s|$|[,.;!?])/g)].map((m) => m[1].replace(/[.:]+$/, "")).filter((id) => conhecidas.has(id));
  return [...new Set(achadas)];
}

/** "!git status" roda no terminal da sessão, como no TUI. */
export function lerShell(texto: string): string | undefined {
  const m = texto.trim().match(/^!\s*(.+)$/s);
  return m ? m[1].trim() : undefined;
}
