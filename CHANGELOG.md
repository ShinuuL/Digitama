# Changelog

## v0.4.1 — 26/10/2026

- **Extensão Digitama OpenCode 0.5.1** (`digitama-opencode-0.5.1.vsix` no release):
  - **Anexos:** clipe na caixa de mensagem, com vários arquivos de uma vez. Texto, e imagem/PDF/áudio/vídeo quando o modelo lê esse tipo, vão como arquivo; binários, pastas e arquivos acima de 8 MB vão pelo caminho no texto, em vez de dar erro. Texto colado com mais de 2 linhas vira um `.txt` anexado.
  - **Atualizações:** a extensão verifica os releases deste repositório e se atualiza com um clique (baixa e instala o `.vsix`). Também compara o OpenCode com o npm (`@opencode/cli`) e roda `opencode upgrade` no terminal. A verificação automática roda a cada 6 h, numa janela só. Está em Configurações → Atualizações e em `/atualizar`.
  - Correções: as cores do tema e das etapas voltaram (a CSP bloqueava `style` inline), as Configurações pararam de piscar e as seções por provedor do menu de modelos recolhem.

## v0.4.0 — 26/10/2026

- **OpenCode v2:** o plugin do pet foi refeito para a v2 (`{ id, setup(ctx) }`, eventos `session.execution.*`, `session.tool.*`, `permission.asked`); a permissão clicada no balão volta por `ctx.permission.reply`. Instale de novo em Digivice → OpenCode.
- **MCP do pet no OpenCode:** Digivice → MCP → "Registrar no OpenCode" roda `opencode mcp add --global digitama` (com confirmação), e o pet passa a valer também nas sessões do OpenCode.
- **Extensão Digitama OpenCode** (`opencode-ext/`, instalador `.vsix` no release): interface do OpenCode v2 no VS Code.
  - Conversas da pasta aberta (criar, retomar, excluir uma ou várias), respostas em tempo real com ferramentas e raciocínio, e o `/pair` para parear celular ou navegador.
  - Bola de contexto e uso da cota grátis na janela de 5 h, somando todas as janelas do VS Code, o TUI e o celular. O limite é aprendido no `FreeUsageLimitError`, e a cota fica marcada como esgotada até liberar.
  - Modos de permissão (Perguntar, Editar livre, Automático), cartões de permissão com o diff e perguntas com opções clicáveis.
  - Menu de modelos com busca, filtro "só grátis" e seções por provedor, mostrando o que cada modelo lê (imagem, áudio, vídeo, PDF).
  - Montador de agentes em kanban: arraste funções e modelos e grave um orquestrador com os subagentes em `.opencode/agents/`.
  - Configurações: tema, conexões (GitHub, Cloudflare Tunnel, Docker, npm, Git e as suas, com o login no terminal) e MCPs.
  - Comandos `/` como os do TUI, em português (`/recarregar`, `/desfazer`, `/bifurcar`…), e `!comando` no terminal.

## v0.3.0 — 26/10/2026

- **Várias conversas no chat, como na extensão:** cada conversa tem o seu Claude Code, a sua pasta e o seu histórico; dá para abrir outra ou trocar enquanto uma responde. A lista mostra quem está trabalhando e quem está esperando você (o pet avisa), e as conversas abertas voltam quando o app reabre.
- **Perguntas do Claude no chat:** o AskUserQuestion aparece com as opções em botões (várias, com Confirmar), resposta livre e Pular, na conversa que perguntou.

- **Ícones e fonte do Digivice feitos no Aseprite:** 25 ícones novos em 16×16 (contorno, sombra e brilho) no Digivice, no menu do pet e na captura, e a fonte pixel "Digivice" (maiúsculas, minúsculas, números e acentos do português) nos títulos e faixas. Fontes em `art/icons/` e `art/font/`.
- **Retrato no lugar da miniatura encolhida:** os Digimon grandes (Supremos, Perfeitos) aparecem pelo rosto em tamanho real no chat, no status e no Digivice, em vez de encolhidos e quebrados.

- **O chat não perde mais a conversa:** se a página recarregar (o Vite no `tauri dev` recarrega tudo quando um arquivo do app muda), a conversa, os cartões e as permissões pendentes voltam; se o app reabrir, a próxima mensagem continua a conversa anterior.
- **Pastas de projeto:** 📁 (ou "＋" num projeto da lista) abre uma conversa trabalhando naquela pasta; continuar uma sessão do VS Code trabalha na pasta dela.
- **Comandos de barra** (`/watch:watch`, `/compact`, as skills…) com sugestões ao digitar "/"; **MCPs e conectores** do Claude Code num painel, com interruptor por servidor.
- **Spotify no cabeçalho** do chat, com capa do álbum e controles; **GitHub**: repositório, branch, PR com os checks do CI e suas issues (pelo `gh`), e o Claude usa o `gh` (consultas liberadas, mudanças pedem permissão).

- **Chat como a extensão do VS Code:** "pensando…" com tempo e tokens, cada ferramenta num cartão (o comando, o arquivo, o padrão) com a saída recolhida, e os pedidos de permissão no próprio chat (Permitir, Sempre, Negar). Modos de permissão (Perguntar, Auto, Aceitar edições, Planejar), modelo (Fable, Opus, Sonnet, Haiku) e quanto ele pensa, direto na barra da mensagem.
- **Anexos no chat:** imagens, PDF e arquivos de texto pelo 📎, arrastando ou colando; texto colado com mais de 2 linhas vira um .txt. 🎤 abre o ditado do Windows. Uso do plano (5h e semana) no cabeçalho.
- **Sessões por projeto:** agrupadas por pasta, recolhíveis; clicar numa sessão já a continua no chat.
- **Recorte em todas as telas:** o Print Screen congela todos os monitores (dá para recortar um pedaço de cada).

- **Chat com as sessões do VS Code:** visual novo no estilo do Digivice e uma faixa com as sessões do Claude Code no VS Code: as abertas agora (trabalhando, esperando você) e as dos últimos 7 dias, com busca. Cada uma tem "VS Code" (traz a janela certa para frente) e "Continuar aqui" (uma cópia da conversa no chat do pet, com todo o contexto, sem mexer na original).

- **Aberto o dia inteiro sem pesar:** o pet desenha a 8–30 fps conforme o que acontece (antes, a cada quadro do monitor); a leitura do Spotify reaproveita o gerenciador de mídia do Windows em vez de criar um por segundo; o clique-através não passa mais pela thread principal 30 vezes por segundo; a captura para de redesenhar e solta o print da memória ao fechar; o pet carrega só os sprites da linha atual e libera os antigos.
- **O pet não some mais:** volta o "sempre por cima" se o Windows o tirar, volta para a tela se o monitor sumir, e a página é recarregada (ou o app reiniciado) se o WebView2 cair. Tudo registrado em `digitama.log`.
- **Consulta de uso e relay:** a consulta ao Claude tem prazo de verdade (não trava se o `claude.exe` ficar calado) e uma conexão parada no pipe cai em 10 s.
- **Animações:** passos de verdade em 8 quadros, feitos só deslocando os pés do próprio sprite do DS (nada redesenhado; cada quadro mantém ≥95% do desenho intacto, conferido por `scripts/check-walk.mjs`); o ovo racha conforme chega perto de chocar e a casca estoura na eclosão; bola de fogo animada, explosão em quadros, notas, coração e "!" com brilho. O golpe vira para o lado com espaço na janela (os do Gallantmon e do Alphamon nasciam fora dela e sumiam), e o medidor de uso não é mais cortado na borda. As artes novas ficam em `art/fx/*.aseprite` (`node scripts/export-art.mjs`).

## v0.2.0 — 14/10/2026

- **Agentes:** OpenCode (plugin com balão de permissão, ataques e XP) além do Claude Code; chat pelo Claude Code ou pelo OpenCode.
- **Uso do Claude:** janelas de 5h e semanal no pet e no Digivice, consultadas a cada X minutos (funciona com a extensão do VS Code).
- **Animações:** idle animado com os quadros do Digimon World DS, golpe com preparo, rastro e pausa no impacto, respiração sem cortar o pixel art, passos e pulos em arco.
- **Digivice:** menu circular no pet e configurações em anel, com Primeiros passos, Agentes, Chat, Captura e Sprites.
- **Captura estilo Lightshot**, com anotações, copiar, salvar ou mandar para a IA.
- **Qualquer PC Windows:** instalador com os sprites embutidos, detecção do Claude Code e do OpenCode, iniciar com o Windows.

## v0.1.0 — 13/10/2026

- Primeira versão: pet com três linhas evolutivas, hooks do Claude Code, chat via OAuth, MCP próprio e Spotify.
