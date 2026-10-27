# Digitama OpenCode

Interface do OpenCode v2 no painel lateral do VS Code.

- **Conversas** da pasta aberta: lista, nova conversa, retomar uma anterior e excluir (lixeira em cada uma, ou "Selecionar" para excluir várias; sempre com confirmação).
- **Agente e modelo** por conversa. O menu de modelos tem busca, filtro "só grátis" e seções por provedor que abrem e fecham (a do modelo atual vem aberta e primeiro).
- **Bola de contexto:** enche conforme os tokens do último passo em relação a `limit.context` do modelo. Ciano até 60%, dourado até 85%, vermelho acima disso. Ela aparece também na barra de status.
- **Uso dos modelos grátis (janela de 5 h):** os modelos grátis de um provedor dividem a mesma cota (trocar Big Pickle por DeepSeek não escapa do bloqueio); cada modelo mostra o uso da cota e o seu próprio. O uso vem do próprio serviço do OpenCode (`/api/experimental/session/stats`), então soma todas as janelas do VS Code, o TUI, o celular e os subagentes; o limite aprendido e o bloqueio ficam num arquivo compartilhado entre as janelas. O limite não é publicado, então é aprendido: na primeira recusa por cota (`FreeUsageLimitError`, "rate limit", 429) a extensão guarda o uso daquele momento como limite, marca a cota inteira como esgotada até a janela liberar e oferece trocar de modelo. Daí em diante aparece a barra "usado de ~limite". O uso aparece no topo do painel (pílula ao lado do contexto) e, por modelo, no menu de modelos.
- **Anexos:** clipe na caixa de mensagem (vários arquivos de uma vez). Texto e arquivos que o modelo lê (imagem, PDF, áudio, vídeo, conforme o modelo) vão como arquivo; o resto (binários como .zip, mídia que o modelo não lê, mais de 8 MB) vai como caminho no texto, para o agente abrir. Texto colado com mais de 2 linhas vira um `.txt` anexado. **Ctrl+C num arquivo do Explorer e Ctrl+V no chat** anexa pelo **caminho real** (lido da área de transferência do Windows, sem copiar nada e sem limite de tamanho), com a mesma regra do clipe. O que não tem caminho, como um print, é gravado numa pasta da extensão (apagada depois de 1 dia), até 8 MB. Cada resposta tem um botão de copiar, e o Ctrl+C na seleção é o nativo.
- **Respostas em tempo real**, com as ferramentas usadas e o raciocínio recolhível. Enquanto o modelo pensa, o raciocínio aparece só como indicador animado (ondas e pulso) — o texto não é despejado na tela; abre quando você clica, ou quando termina.
- **Loop interrompido:** se o agente chamar a mesma ferramenta com a mesma entrada três vezes seguidas, a execução é interrompida com um aviso, em vez de repetir indefinidamente. Chamadas diferentes zeram a contagem.
- **Modos de permissão** (vão como regras da sessão, valem até com o painel fechado):
  - *Perguntar*: confirma edições, comandos e web; leituras seguem livres.
  - *Editar livre*: edita arquivos do projeto sem perguntar; comandos e web ainda confirmam.
  - *Automático*: faz tudo sem perguntar, menos mexer fora da pasta do projeto.
- **Permissões e perguntas** viram cartões: diff da edição, Permitir/Sempre/Negar, e perguntas com opções clicáveis e resposta livre.
- **Montar agentes** (ícone de pessoas): arraste funções (Planejador, Programador, Revisor…) para o fluxo, solte um modelo em cada etapa (com o que ele lê: imagem, áudio, vídeo, PDF, raciocínio e contexto) e grave. Vira um orquestrador primário que chama os subagentes em ordem, em `.opencode/agents/` do projeto ou em `~/.config/opencode/agents/`. Só arquivos gerados pelo painel são sobrescritos.
- **`/pair`:** gera o link de pareamento de uso único, que expira em 5 min, para o celular ou o navegador.
- **Configurações** (engrenagem no topo ou `/config`):
  - *Tema*: cor de destaque, densidade e animações, com prévia.
  - *Conexões*: GitHub, Cloudflare Tunnel, Docker, npm e Git, com estado ao vivo. "Conectar" abre o login oficial no terminal do VS Code (`gh auth login --web`, `cloudflared tunnel login`…); dá para adicionar suas próprias ferramentas com um comando de status. A extensão nunca vê senha nem token, e a saída é mascarada.
  - *MCPs*: liga/desliga, remove e adiciona servidores (local ou remoto), gravados com `opencode mcp add --global` em `~/.config/opencode/opencode.json` (remover faz backup datado antes), e registra o MCP do pet Digitama com um clique.
- **Atualizações** (Configurações → Atualizações, ou `/atualizar`): compara a extensão com o `.vsix` do release mais novo no GitHub (`digitamaOpencode.atualizacoes.repositorio`, padrão `ShinuuL/Digitama`) e o OpenCode com o npm (`@opencode/cli`). Verifica sozinho a cada 6 h, numa janela só; instala só com o seu clique. O OpenCode atualiza com `opencode upgrade` no terminal.
- **Comandos `/`** como os do TUI, em português com apelidos em inglês: `/recarregar` (`/reload`), `/nova`, `/sessoes`, `/parar`, `/compactar`, `/desfazer`, `/refazer`, `/bifurcar`, `/renomear`, `/arquivar`, `/exportar`, `/modelos`, `/agentes`, `/montar`, `/modo`, `/skill`, `/mcp`, `/status`, `/pair` e `/ajuda`, mais os do OpenCode (`/init`, `/review`). `!comando` roda no terminal da conversa.

## Como funciona

A extensão conversa com o serviço em segundo plano do OpenCode (`opencode service`). Ela **não lê** a senha do `~/.config/opencode/service.json`. Em vez disso, pareia como qualquer outro dispositivo: `opencode api server.pair` gera um código, o `/auth/connect/{code}` troca esse código por um token, e as requisições seguem com `Basic opencode:<token>`. O token fica só na memória.

A conversa trabalha na primeira pasta aberta no VS Code. Sem pasta aberta, não cria conversa.

## Pareamento (`/pair`) e segurança

O serviço escuta apenas em `127.0.0.1`. O link funciona direto neste PC. Para o celular entrar, ele precisa alcançar esta máquina, seja pela rede local, seja por um túnel que você mesmo configurar. Quem abre o link controla o OpenCode nesta máquina, com acesso aos arquivos dela. Não compartilhe o link e não exponha o serviço na internet.

## Desenvolvimento

```
npm install
npm test          # compila e roda os testes
npm run package   # gera o .vsix
code --install-extension digitama-opencode-0.5.3.vsix
```
