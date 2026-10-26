# Digitama

Um pet em pixel art, inspirado em Digimon, que vive na área de trabalho do Windows e acompanha os seus agentes de IA — **Claude Code** e **OpenCode**:

- **Ataca quando o agente termina** uma tarefa (Pepper Breath, Pyro Sphere, Metal Cannon… conforme o Digimon) e ganha XP.
- **Mostra um balão interativo quando o agente pergunta ou pede permissão**: você responde ali mesmo (Permitir/Negar, ou as opções de um `AskUserQuestion` do Claude Code), ou clica em "Responder no…" e o pet traz a janela do agente para frente.
- **Chat com a IA pelo agente que você já usa**: o Claude Code logado (assinatura claude.ai, sem chave de API) ou o OpenCode (qualquer provedor configurado nele — OpenAI, Gemini, Anthropic, Ollama…), com print da tela e a persona do Digimon.
- **Captura estilo Lightshot**, com anotações, copiar, salvar ou mandar para a IA.
- **Servidor MCP próprio**: o Claude ganha as ferramentas `screenshot`, `pet_say`, `pet_attack` e `pet_status`. O `screenshot` também tira print de uma janela só (`janela: "PDV"`), mesmo minimizada e sem roubar o foco, e grava o PNG como evidência (`salvar_em: "validacao/<chamado>/img"`).
- **Dança com notas musicais** quando o Spotify está tocando e em foco.
- **Três linhas evolutivas**, do ovo ao Supremo, com os sprites do Digimon World DS:
  - Botamon → Koromon → **Agumon** → Greymon → MetalGreymon → **WarGreymon**
  - Jyarimon → Gigimon → **Guilmon** → Growlmon → WarGrowlmon → **Gallantmon**
  - Dodomon → Dorimon → **Dorumon** → Dorugamon → DoruGreymon → **Alphamon**

## Instalar em qualquer PC Windows

Requisitos da máquina: Windows 10 ou 11 (o WebView2 vem com o Windows 11; no 10, o instalador baixa se faltar). Pelo menos um agente:

- [Claude Code](https://code.claude.com), logado (`claude` → `/login`), e/ou
- [OpenCode](https://opencode.ai) (`npm i -g opencode-ai`, Scoop, Chocolatey ou o instalador oficial), com um provedor configurado (`opencode auth login`).

1. Rode o instalador `Digitama_<versão>_x64-setup.exe` (instala só para o usuário, sem pedir administrador).
2. Na primeira abertura, o Digivice abre em **Início**: ele detecta o Claude Code e o OpenCode, baixa os sprites dos Digimon (precisa de internet uma vez) e oferece **iniciar com o Windows**.
3. Em **Agentes**, conecte cada agente — sempre com prévia antes de gravar:
   - **Claude Code**: hooks no `%USERPROFILE%\.claude\settings.json`, com backup datado (`settings.json.digitama-AAAAMMDD-HHMMSS.bak`); hooks de outras ferramentas não são tocados.
   - **OpenCode**: plugin em `%USERPROFILE%\.config\opencode\plugins\digitama.js`. Reinicie o OpenCode depois.
4. Use os agentes normalmente. Tarefa concluída +10 XP, ferramenta +1, pergunta respondida pelo balão +3. O ovo choca com 20 XP; o Supremo chega com 2500.

Nada depende de caminhos desta máquina: o relay vai para `%LOCALAPPDATA%\br.com.mastersys.digitama\bin`, os dados para `%APPDATA%\br.com.mastersys.digitama`, e os executáveis dos agentes são procurados no PATH e nos lugares de instalação comuns (ou no caminho que você informar no Digivice).

## Desenvolver

Requisitos: [Rust](https://rustup.rs), Node 20+.

```powershell
npm install
npm run tauri dev     # desenvolvimento (compila o relay digitama-hook antes)
npm run pack          # instalador NSIS em target/release/bundle/nsis/
```

Testes: `cargo test --workspace` (relay e app) e `npx tsc --noEmit` (frontend).

Artes: os efeitos do pet ficam em `art/fx/*.aseprite` e os ícones do Digivice em `art/icons/*.aseprite`; depois de editar no Aseprite, `node scripts/export-art.mjs` gera `src/pet/art.gen.ts` e `src/shared/icons.gen.ts`. A fonte pixel "Digivice" é a folha `art/font/digivice.aseprite` (ordem dos glifos em `charset.txt`); `python scripts/build-font.py` (Pillow + fontTools) gera `src/shared/fonts/*.ttf`. `node scripts/check-walk.mjs` confere os passos gerados a partir dos sprites do DS da sua pasta local (fidelidade por quadro, folha de prévia e GIFs).

## Como usar

| Ação | O que acontece |
|---|---|
| Clique no pet | cutuca (fala e reação); 5 cliques rápidos deixam ele tonto |
| Duplo clique | ataque especial |
| Botão direito | anel do Digivice: conversar, captura, ataque, música, status, Digivice, esconder |
| Arrastar | move o pet; a posição é lembrada |
| **Ctrl+Alt+Shift+D** | abre o chat |
| **Print Screen** / **Ctrl+Alt+Shift+P** | captura estilo Lightshot |
| Ícone na bandeja | os mesmos atalhos, mostrar/esconder e sair |

### Agentes

| Agente | Como conecta | O pet faz |
|---|---|---|
| Claude Code | hooks (`digitama-hook.exe <Evento>`) | ataque ao terminar, XP, balão de permissão e de `AskUserQuestion` com resposta direta, aviso de "esperando você" |
| OpenCode | plugin (`digitama.js`), que chama `digitama-hook.exe --agent opencode` | ataque ao terminar (`session.idle`), XP, balão de permissão com Permitir/Negar (responde pela API do próprio OpenCode), aviso de pergunta |

Quem responder primeiro vale: se você aprovar no terminal do OpenCode, o balão some sozinho.

### Chat

Escolha quem responde no topo do chat (ou em Digivice → Chat):

- **Claude Code**: roda `claude.exe -p` em modo stream-json, no seu login. Usa a sua assinatura, não uma chave (a opção *Forçar login OAuth* remove `ANTHROPIC_API_KEY` do ambiente do chat), enxerga os seus servidores MCP e conectores, e só usa as ferramentas liberadas (padrão `Read,Glob,Grep,WebSearch,WebFetch`; para um MCP, `mcp__servidor`).
- **OpenCode**: cada mensagem é um `opencode run --format json` (mensagem pelo stdin, print com `-f`, conversa continuada com `--session`). O modelo é qualquer `provedor/modelo` do seu OpenCode — **Carregar modelos** lista os disponíveis.

O chat roda em `%APPDATA%\br.com.mastersys.digitama\chat`, nunca dentro dos seus projetos. Com *persona* ligada, a IA responde no papel do Digimon atual, mas a resposta técnica vem primeiro.

**Sessões do VS Code:** a faixa à esquerda do chat (☰ esconde) lista as sessões do Claude Code abertas pela extensão do VS Code: as ativas agora, com o que estão fazendo, e as dos últimos 7 dias. **VS Code** traz a janela daquela sessão para frente; **Continuar aqui** abre uma cópia da conversa no chat (`--resume … --fork-session`), com todo o contexto, sem alterar a do VS Code. Só o título, a pasta e o branch são lidos para a lista.

### Captura (estilo Lightshot)

**Print Screen** (ou Ctrl+Alt+Shift+P, o menu do pet, o 📷 do chat): a tela congela com visual de Digivice, você arrasta a área (dá para mover e redimensionar), anota com lápis, linha, seta, retângulo, marca-texto ou texto, e escolhe **copiar** (Ctrl+C ou duplo clique), **salvar** em `Imagens\Digitama` (Ctrl+S) ou **perguntar à IA** (Ctrl+Enter, anexa no chat). Ctrl+Z desfaz, Esc sai.

Se outro programa (como o Lightshot) estiver segurando a tecla Print Screen, feche-o e reabra o Digitama, ou use Ctrl+Alt+Shift+P. A opção fica em Digivice → Captura.

### Sprites

Os Digimon usam os **sprites de batalha do Digimon World DS** (pose parada, ataque e dano), baixados do [Wikimon](https://wikimon.net) pelo próprio app na primeira abertura, para `%APPDATA%\br.com.mastersys.digitama\sprites\<id>\{idle,attack,hit}.png` (Digivice → Sprites baixa de novo). O app remove o fundo, recorta as bordas e anima: respiração, pose de ataque no golpe, pose de dano quando cutucado, poses alternadas na dança, silhueta branca ao evoluir e um ciclo de passos gerado a partir da pose parada. Bebês andam saltitando e o ovo só balança no lugar.

Para trocar qualquer sprite, ponha um PNG em `sprites\<id>\idle.png` (ou `attack.png`, `hit.png`), ou `sprites\<id>.png`. Sem pacote, o app usa o desenho em código de [src/pet/sprites.ts](src/pet/sprites.ts). Para desenvolver sem abrir o app: `node scripts/fetch-sprites.mjs`. Uso pessoal: os sprites oficiais não vão no instalador nem no repositório.

### Digivice

O botão direito no pet abre um **anel de hexágonos**. A janela **Digivice** (configurações) é um anel com as seções — Início, Digimon, Agentes, Chat, MCP, Captura, Sprites, Atalhos, Sobre — em volta do seu Digimon animado, com painéis no estilo do "Battle" do Cyber Sleuth.

## Como funciona

```
Claude Code ──hook──────────────┐
OpenCode ──plugin (--agent)─────┤
                                ▼
                       digitama-hook.exe ──named pipe \\.\pipe\digitama-<SID>──▶ Digitama (Rust/Tauri)
                         ▲ (PermissionRequest espera o clique no balão)                │ eventos
Claude Code ──MCP stdio──┘ digitama-hook --mcp (screenshot, pet_say…)                  ▼
                                                                          janela do pet (TS + canvas)
Digitama ──stdin/stdout──▶ claude.exe -p  |  opencode run --format json   (chat)
```

- **Nunca trava o agente**: se o Digitama estiver fechado, o relay sai na hora sem opinião. Um pedido só espera o humano depois que o balão confirma que está na tela; sem resposta em ~108 s, o agente pergunta no próprio terminal/chat. O plugin do OpenCode não espera nada dentro do OpenCode.
- **Nada permite algo sem clique**: sem decisão, o relay não imprime nada.
- **O pipe leva o SID do usuário** no nome, e os dois lados conferem se o outro processo roda como o mesmo usuário do Windows.
- **Clique-através**: fora do pet, do balão e dos menus, a janela transparente deixa o clique passar.
- **Música**: lida pela API de sessões de mídia do Windows, sem conta nem rede.

| Pasta | O quê |
|---|---|
| [hook/](hook/) | `digitama-hook`: relay dos hooks/plugin e servidor MCP |
| [src-tauri/src/](src-tauri/src/) | app: pipe, hooks do Claude Code, plugin do OpenCode (`opencode.rs`), chat (`claude.rs`), sprites, print (`screen.rs`), mídia, Win32 |
| [src/pet/](src/pet/) | janela do pet: sprites, efeitos, balão, anel, máquina de estados |
| [src/shared/lore.ts](src/shared/lore.ts) | Digimon, estágios, XP, falas, ataques e persona do chat |
| [src/chat/](src/chat/), [src/settings/](src/settings/), [src/snip/](src/snip/) | chat, Digivice e captura |

## Créditos e licenças

- Partes do relay de hooks, do pipe nomeado, do instalador de hooks, do plugin do OpenCode e do foco do VS Code foram adaptadas do [Coucou](https://github.com/Louis-CFM/coucou) (código MIT, © Louis Raillé). O nome, o personagem Mochi e os sons do Coucou **não** são usados.
- Digimon e os nomes relacionados são © Bandai / Toei Animation. Projeto pessoal de fã, sem fins comerciais; não distribua com sprites oficiais.
