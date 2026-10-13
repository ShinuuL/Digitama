# Digitama

Um pet em pixel art, inspirado em Digimon, que vive na área de trabalho do Windows e acompanha o Claude Code:

- **Ataca quando o Claude termina** uma tarefa (Pepper Breath, Pyro Sphere, Metal Cannon… conforme o Digimon) e ganha XP.
- **Mostra um balão interativo quando o Claude pergunta** (`AskUserQuestion`) ou pede permissão: você responde ali mesmo, ou clica em "Responder no chat" e o pet traz a janela do Claude Code (VS Code) para frente.
- **Chat com o Claude pelo seu Claude Code logado** (OAuth da assinatura claude.ai, sem chave de API), com print da tela, persona do Digimon e os seus servidores MCP e conectores.
- **Servidor MCP próprio**: o Claude ganha as ferramentas `screenshot`, `pet_say`, `pet_attack` e `pet_status`.
- **Dança com notas musicais** quando o Spotify está tocando e em foco, e balança no ritmo quando está tocando em segundo plano. Os controles ⏮ ⏯ ⏭ aparecem ao passar o mouse.
- **Três linhas evolutivas**, do ovo ao Supremo:
  - Botamon → Koromon → **Agumon** → Greymon → MetalGreymon → **WarGreymon**
  - Jyarimon → Gigimon → **Guilmon** → Growlmon → WarGrowlmon → **Gallantmon**
  - Dodomon → Dorimon → **Dorumon** → Dorugamon → DoruGreymon → **Alphamon**

## Rodar

Requisitos: Windows 10/11, [Rust](https://rustup.rs), Node 20+ e o [Claude Code](https://code.claude.com) instalado e logado (`claude` → `/login`).

```powershell
npm install
npm run tauri dev     # desenvolvimento (compila o relay digitama-hook antes)
npm run pack          # instalador NSIS em target/release/bundle/nsis/
```

Testes: `cargo test --workspace` (relay e app) e `npx tsc --noEmit` (frontend).

## Primeiros passos

1. Abra o Digitama. Ele começa como Digitama (ovo) no canto inferior direito.
2. Botão direito no pet → **Configurações**:
   - Escolha a linha evolutiva, o apelido e o tamanho.
   - **Claude Code — hooks → Ver prévia e instalar**: mostra o diff do `%USERPROFILE%\.claude\settings.json` e só grava depois do clique em *Confirmar e gravar*, com backup datado ao lado (`settings.json.digitama-AAAAMMDD-HHMMSS.bak`). Os hooks de outras ferramentas (o coucou, por exemplo) não são tocados.
   - **MCP do Digitama → Registrar agora** (opcional): roda `claude mcp add --scope user digitama -- "<relay>" --mcp`.
3. Use o Claude Code normalmente. Cada tarefa concluída rende +10 XP, cada ferramenta +1 e cada pergunta respondida pelo balão +3. O ovo choca com 20 XP; o Supremo chega com 2500.

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

Os atalhos usam Shift porque o coucou já ocupa quase todos os Ctrl+Alt+letra.

### Chat

O chat roda `claude.exe -p` em modo stream-json, no seu login. Então:

- consome a sua assinatura, não uma chave de API (a opção *Forçar login OAuth* remove `ANTHROPIC_API_KEY` do ambiente do chat);
- enxerga os mesmos servidores MCP e conectores do claude.ai que o seu Claude Code (a barra do chat mostra quais conectaram);
- só usa as ferramentas liberadas nas configurações (padrão: `Read,Glob,Grep,WebSearch,WebFetch`). Para liberar um MCP, adicione `mcp__nome-do-servidor`;
- roda em `%APPDATA%\br.com.mastersys.digitama\chat`, nunca dentro dos seus projetos;
- com *persona* ligada, o Claude responde no papel do Digimon atual, mas a resposta técnica vem primeiro.

O botão **📷 Print** abre a captura (veja abaixo); "Perguntar ao Claude" anexa o recorte à próxima mensagem.

### Sprites

Os Digimon usam os **sprites de batalha do Digimon World DS** (pose parada, ataque e dano), baixados do [Wikimon](https://wikimon.net) para a sua pasta local, fora do repositório:

```powershell
node scripts/fetch-sprites.mjs      # → %APPDATA%r.com.mastersys.digitama\sprites\<id>\{idle,attack,hit}.png
```

O app remove o fundo, recorta as bordas e anima: respiração parada, troca para a pose de ataque no golpe e para a de dano quando cutucado, alterna as poses na dança e pisca em silhueta branca ao evoluir. Como os sprites de batalha não têm quadros de caminhada, o ciclo de passos é gerado a partir da pose parada (as pernas sobem alternadamente). Bebês andam saltitando e o ovo só balança no lugar.

Para trocar qualquer sprite, ponha um PNG em `sprites\<id>\idle.png` (ou `attack.png`, `hit.png`), ou `sprites\<id>.png`. Sem pacote, o app usa o desenho em código de [src/pet/sprites.ts](src/pet/sprites.ts) (prévia: `node scripts/preview-sprites.mjs preview.png 4`). Uso pessoal: não distribua os sprites oficiais.

### Captura (estilo Lightshot)

**Print Screen** (ou Ctrl+Alt+Shift+P, o menu do pet, o 📷 do chat): a tela congela com visual de Digivice, você arrasta a área (dá para mover e redimensionar), anota com lápis, linha, seta, retângulo, marca-texto ou texto, e escolhe **copiar** (Ctrl+C ou duplo clique), **salvar** em `Imagens\Digitama` (Ctrl+S) ou **perguntar ao Claude** (Ctrl+Enter, anexa no chat). Ctrl+Z desfaz, Esc sai.

Se o Lightshot estiver aberto, ele segura a tecla Print Screen: feche-o (ou tire a tecla dele) e reabra o Digitama. A opção fica em Digivice → Captura.

### Digivice

O botão direito no pet abre um **anel de hexágonos** (conversar, captura, ataque, música, status, Digivice, esconder). A janela **Digivice** (configurações) é um anel com as seções em volta do seu Digimon animado e painéis no estilo do "Battle" do Cyber Sleuth.

## Como funciona

```
Claude Code ──hook──▶ digitama-hook.exe ──named pipe \\.\pipe\digitama-<SID>──▶ Digitama (Rust/Tauri)
                         ▲   (PermissionRequest espera o clique no balão)            │ eventos
Claude Code ──MCP stdio──┘   digitama-hook --mcp  (screenshot, pet_say…)             ▼
                                                                        janela do pet (TS + canvas)
Digitama ──stdin/stdout stream-json──▶ claude.exe -p  (chat, OAuth)
```

- **Nunca trava o Claude Code**: se o Digitama estiver fechado, o relay sai na hora sem opinião. Um pedido só espera o humano depois que o balão confirma que está na tela; sem resposta em ~108 s, o Claude Code pergunta no próprio chat.
- **Nada permite algo sem clique**: sem decisão, o relay não imprime nada.
- **O pipe leva o SID do usuário** no nome, e os dois lados conferem se o outro processo roda como o mesmo usuário do Windows.
- **Clique-através**: fora do pet, do balão e dos menus, a janela transparente deixa o clique passar.
- **Música**: lida pela API de sessões de mídia do Windows (a mesma do painel de volume), sem conta nem rede.

| Pasta | O quê |
|---|---|
| [hook/](hook/) | `digitama-hook`: relay dos hooks e servidor MCP |
| [src-tauri/src/](src-tauri/src/) | app: pipe, instalador de hooks, chat (`claude.rs`), print (`screen.rs`), mídia, Win32 |
| [src/pet/](src/pet/) | janela do pet: sprites, efeitos, balão, máquina de estados |
| [src/shared/lore.ts](src/shared/lore.ts) | Digimon, estágios, XP, falas, ataques e persona do chat |
| [src/chat/](src/chat/), [src/settings/](src/settings/) | janelas de chat e configurações |

## Créditos e licenças

- Partes do relay de hooks, do pipe nomeado, do instalador de hooks e do foco do VS Code foram adaptadas do [Coucou](https://github.com/Louis-CFM/coucou) (código MIT, © Louis Raillé). O nome, o personagem Mochi e os sons do Coucou **não** são usados.
- Digimon e os nomes relacionados são © Bandai / Toei Animation. Projeto pessoal de fã, sem fins comerciais; não distribua com sprites oficiais.
