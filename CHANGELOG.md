# Changelog

## v0.4.3 — 28/10/2026

- **Prints e imagens em miniatura no chat:** antes, as imagens das suas mensagens ocupavam a largura toda da conversa. Agora aparecem em miniatura (até 160×120, lado a lado). Clicar abre em tamanho real por cima do chat, e um clique ou Esc fecham.
- **Pet não fica mais mudo com o OpenCode:** quando a assinatura de eventos do OpenCode cai, o plugin assina de novo sozinho, com espera crescente de 1 s a 30 s. Antes, o pet parava de reagir até reiniciar o OpenCode. **Para valer, reinstale o plugin:** em Configurações → OpenCode, o app mostra "desatualizado: instale de novo". Depois, reinicie o OpenCode.
- **Extensão Digitama OpenCode 0.5.7** (`digitama-opencode-0.5.7.vsix` no release): `@arquivo` e `@agente`, arrastar e soltar, fila de mensagens, faixa de desfeitas, aviso de chamada de ferramenta escrita como texto, loop em ciclo e uso desde o reinício diário da cota. Detalhes na entrada da 0.5.7 abaixo.

## Extensão Digitama OpenCode 0.5.7 — 28/10/2026

- **`@` na mensagem:** `@` abre a lista de arquivos do projeto e de agentes. O arquivo escolhido vira anexo, com a mesma regra do clipe: vai em `files` ou, se o modelo não lê aquele tipo, pelo caminho. A busca usa a lista do próprio VS Code, sem `node_modules`, `.git`, `target`, `out` e `dist`, e acha também por letras na ordem ("extts" → `extension.ts`). O `@agente` faz o OpenCode chamar aquele agente nesta mensagem, sem trocar o da conversa; se o servidor recusar a menção, a mensagem sai sem ela. Setas, Enter e Tab navegam pela lista. Ideia trazida do OpenChamber (MIT).
- **Arrastar e soltar** arquivos na caixa de mensagem. Do Explorer do VS Code, segure Shift ao soltar. Pastas não são anexadas.
- **Fila:** com o agente trabalhando, Enter guarda a mensagem numa faixa "na fila", e ela sai sozinha quando ele terminar. Dá para editar ou tirar da fila. Ctrl+Enter manda na hora. Comandos `/` e `!` não entram na fila.
- **Faixa depois de `/desfazer`:** mostra "N mensagens desfeitas" com o botão **Refazer**.
- **Chamada de ferramenta escrita como texto:** alguns modelos "imprimem" a chamada (`[tool_call tool=functions.write](…)`, `<tool_call>`, `{"name":…, "arguments":…}`) e nada é executado. A extensão percebe isso no fim da resposta e avisa, com o botão **Executar de verdade**. Exemplos dentro de bloco de código não contam.
- **Loop em ciclo:** além de três chamadas iguais seguidas, a execução agora para quando o agente volta 4 vezes à mesma chamada nas últimas 8 (ler → editar → ler → editar…).
- **Uso desde o reinício da cota:** a cota grátis do OpenCode reinicia uma vez por dia, às 00:00 UTC (20:59 em Brasília), e não numa janela de 5 h; as recusas de 26, 27 e 28/10 apontaram todas para esse horário. A primeira recusa ensina o reinício, e a pílula passa a mostrar "desde 20:59: X". Antes de qualquer recusa, continua mostrando "5 h". O limite segue sem ser adivinhado: entre um dia e outro, a cota acabou com 4 milhões e com 1 milhão de tokens.
- **Testes:** `test/mencoes.test.js` (ranking e menções), ciclo e chamada escrita como texto em `test/repeticao.test.js`, reinício diário em `test/uso.test.js`. 47 passando.
- **App (entra no próximo release do Digitama):** o plugin do OpenCode assina os eventos de novo quando a assinatura cai, com espera crescente de 1 s a 30 s. Antes, o pet ficava mudo até reiniciar o OpenCode.

## Extensão Digitama OpenCode 0.5.6 — 27/10/2026

- **Google Cloud e Firebase nas Conexões:** cartões prontos com estado ao vivo. O Google Cloud mostra a conta ativa e o projeto (`gcloud config get-value project`); o Firebase mostra a conta do `firebase-tools`. "Conectar" roda `gcloud auth login` / `firebase login` no terminal do VS Code; "Instalar" sugere `winget install --id Google.CloudSDK` / `npm i -g firebase-tools`.
- **Logado só com conta impressa:** as duas CLIs saem com código 0 mesmo deslogadas, então o estado vem do e-mail na saída, não do código de saída.
- **Atenção:** com a conta logada, o agente pode rodar `gcloud` e `firebase` em seu nome. Em projetos com dados de clientes, mantenha o modo "perguntar".

## Extensão Digitama OpenCode 0.5.5 — 27/10/2026

- **Horário de volta vindo do servidor:** a recusa `provider.free-limit` traz `retryAfterMs` (cabeçalho `retry-after`). Recusa + `retryAfterMs` é o horário exato em que a cota libera — duas recusas reais com 8 min de diferença apontaram para o mesmo instante. A pílula mostra "esgotado até 14:39"; sem o campo, estima 5 h e mostra "~14:39".
- **Cálculo de uso limpo:** saíram o limite "aprendido" (que gerava a pílula "cota 2,8M/~793k" em 100% sem bloqueio nenhum), a barra/percentual e a bisseção que fazia dezenas de consultas ao servidor para estimar o fim da janela. A pílula mostra só o usado nas últimas 5 h. O `uso.json` antigo é ignorado.
- **Serviço sobe sozinho:** ao abrir, a extensão verifica `opencode service status` e, se não houver serviço, roda `opencode service start` desanexado. Entre várias janelas, só uma sobe (trava `subindo.lock` com prazo de 30 s); as outras esperam o endereço aparecer. A reconexão faz a mesma checagem se o serviço cair.
- **Testes:** `test/uso.test.js` usa as recusas reais (horário exato, reserva de 5 h, mescla entre janelas, formato antigo); `test/opencode.test.js` cobre a trava (só uma janela pega, abandonada é retomada).

## Extensão Digitama OpenCode 0.5.4 — 26/10/2026

- **Agente em loop:** quando o agente chama a mesma ferramenta com a mesma entrada três vezes seguidas (e nada entre elas), a extensão interrompe a execução e explica o que houve, em vez de deixar rodando. Chamadas diferentes zeram a contagem, então alternar entre dois arquivos não é loop. Cada mensagem nova recomeça a contagem, e cada conversa é contada em separado.
- **Raciocínio como animação:** o bloco começa fechado e mostra só um indicador animado ("Raciocinando" com ondas e pulso). Nada de texto é escrito na tela durante a geração: o raciocínio só é montado quando você abre o bloco, ou quando ele termina. Ao terminar, o bloco continua fechado (sem fechar na cara de quem abriu para acompanhar).
- **Lista de agentes:** ao reconectar ao serviço, a extensão relê os agentes, em vez de ficar com a lista do primeiro connect. Se a leitura falhar, o erro aparece na conversa e a lista anterior é mantida — antes a falha era engolida em silêncio e o menu ficava preso nos agentes embutidos.
- **Testes:** `test/repeticao.test.js` cobre a assinatura estável das chamadas (ordem das chaves não importa), o limite de repetições, a troca de ferramenta/entrada, o isolamento por sessão e o reinício após interromper.

## v0.4.2 — 26/10/2026

- **Extensão Digitama OpenCode 0.5.3** (`digitama-opencode-0.5.3.vsix` no release; quem tem a 0.5.x recebe o aviso de atualização):
  - **Ctrl+C no Explorer, Ctrl+V no chat:** o arquivo entra pelo caminho real, lido da área de transferência do Windows, sem cópia e sem limite de tamanho. Um `.zip`, por exemplo, vai como caminho.
  - **Ctrl+V de prints** e de arquivos sem caminho: vira anexo (até 8 MB), com a mesma regra do clipe.
  - **Botão de copiar** em cada resposta do modelo.
  - O seletor do clipe volta a mostrar os arquivos (no Windows, arquivos + pastas no mesmo seletor virava um seletor só de pastas).

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
