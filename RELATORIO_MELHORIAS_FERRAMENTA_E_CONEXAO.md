# Relatório de melhorias - Digitama (Ferramenta + Conexão com Agentes)

Data: 27/10/2026

## 1) Visão geral

O Digitama não é "só" um servidor MCP. É uma ponte entre agentes de IA e um pet/UX na área de trabalho.

Componentes principais:

| Componente | Função |
|---|---|
| hook/ (digitama-hook) | Relay via named pipe, servidor MCP (--mcp) e statusline. É o ponto central de comunicação entre agentes e o app. |
| src-tauri/ | App Tauri (pet, Digivice, chat, captura, sprites, mídia Windows). Responsável por ouvir o pipe e reagir aos eventos. |
| Plugin OpenCode | Conecta o OpenCode ao relay via digitama-hook.exe --agent opencode. Escuta eventos como session.idle, permissões e perguntas. |
| Hooks Claude Code | Chama digitama-hook.exe <Evento> em pontos chave (Stop, Notification, PermissionRequest, PostToolUse, etc). |
| Chat integrado | Roda claude.exe -p ou opencode run --format json direto da UI, com suporte a sessões do VS Code. |

## 2) Como a conexão funciona hoje

| Aspecto | Estado atual | Observação |
|---|---|---|
| Transporte | \\.\pipe\digitama-<SID> | Nome do pipe usa o SID do Windows. Ótimo pra isolar por usuário. |
| Segurança | Verificação de mesmo usuário | Tanto hook/app conferem se rodam com o mesmo usuário. Evita conexões cruzadas. |
| Fire-and-forget | FIRE_AND_FORGET_BUDGET = 2s | Eventos como Stop, PostToolUse não travam o agente. Se o Digitama estiver fechado, sai com 0 na hora. |
| Espera por decisão | DECISION_BUDGET = 110s | Só PermissionRequest espera resposta. Se não houver resposta no balão, o agente segue pelo terminal/chat. |
| MCP | RPC_BUDGET = 20s | Chamadas MCP tem prazo controlado. screenshot de janela pode demorar um pouco e já considera isso. |
| Agente | digitama_agent injetado | Permite o pet distinguir Claude/OpenCode e tratar regras diferentes (ex: AskUserQuestion só faz sentido pro Claude). |

## 3) Pontos fortes

- Nunca trava o agente: regra bem aplicada. Pipe inexistente não bloqueia.
- Separação clara: relay não toma decisão sozinho, só entrega pro app.
- MCP prático: screenshot com captura por janela/minimizada é muito útil pra validação.
- Integração com OpenCode: plugin funcional e com resposta direta no balão pra permissões.
- Chat próprio: consegue usar a sessão logada do Claude ou qualquer provedor do OpenCode sem precisar de chave extra.
- Limpeza de payload: remove campos pesados (tool_response, tool_output, transcript_path) antes de enviar pelo pipe.

## 4) Melhorias sugeridas

### 4.1 Conexão com OpenCode

| Melhoria | Prioridade | Detalhes |
|---|---|---|
| Healthcheck | Alta | Ter um ping/status entre plugin OpenCode e app. Hoje só funciona por evento. Se o plugin ficar "mudo", fica difícil saber se está conectado. |
| Reconexão automática | Alta | Se o pipe cair/reconectar (app reiniciado), o plugin deveria tentar reconectar sem precisar reiniciar o OpenCode. |
| Melhor mapeamento de eventos | Alta | Mapear melhor eventos do OpenCode (session.idle, permission.updated, message.*) pra não perder balões/permissões em mudanças de versão do OpenCode. |
| Sincronia com API | Média-Alta | Ao aprovar/negar no balão, já existe integração com API do OpenCode. Vale padronizar tratamento de erros (rede/sem sessão) com mensagem mais clara pro usuário. |

### 4.2 Ferramenta / Extensão (UX para o agente)

| Melhoria | Prioridade | Detalhes |
|---|---|---|
| Ação silenciosa | Alta | Evitar escrever comandos/instruções no chat. Usar as tools (edit, shell, execute) direto. O Digitama já ajuda nisso com hooks, mas o fluxo "validar no aparelho" ainda fica verboso as vezes. |
| Checklist automatizado | Alta | Ter um fluxo padrão: logcat -> edit -> build -> install -> ui_tree/screenshot. Hoje funciona, mas não tem atalho/checklist unificado. |
| Melhor visibilidade de estado | Média-Alta | Mostrar no Digivice ou balão "Digitama conectado ao OpenCode/Claude" com ultimo evento recebido (timestamp). Ajuda a diagnosticar quando "parou de funcionar". |
| Menos resets acidentais | Alta | Evitar ações destrutivas sem aviso explícito (pm clear, uninstall/reinstall) e explicar impacto antes de rodar. |

### 4.3 MCP e captura

| Melhoria | Prioridade | Detalhes |
|---|---|---|
| `screenshot` mais resiliente | Alta | Já tem captura por janela/minimizada. Melhorar mensagens quando janela não encontrada (sugerir janela_id da lista) e tratar casos com múltiplos monitores. |
| Evidências padronizadas | Média-Alta | Manter salvar_em: validacao/<chamado>/img funcionando sempre. Ótimo pra rastreabilidade. Poderia ter nome automático com timestamp + app. |
| Nova tool `logcat`/`ui_tree` via MCP? | Média | Hoje usamos screen-mirror separado. Unificar com Digitama facilitaria validar direto pelo agente sem trocar de contexto/ferramentas. |

### 4.4 Robustez e observabilidade

| Melhoria | Prioridade | Detalhes |
|---|---|---|
| Logs do relay | Alta | Ter log opcional (%LOCALAPPDATA%\br.com.mastersys.digitama\logs\hook-YYYY-MM-DD.log) com conexões, timeouts, RPCs. Hoje difícil debugar sem rodar manualmente. |
| Métricas de conexão | Média | Contar falhas de conexão, timeouts por evento e quando cai pro "modo sem resposta". Ajuda a identificar regressões. |
| Tratamento de erros mais claro | Média | Em vez de "O Digitama não está aberto...", mostrar também "Verifique se app está rodando" + sugestão pra reiniciar. |
| Testes | Média | Os testes no hook/src/main.rs são bons (truncamento, AskUserQuestion, agente). Vale adicionar testes pra RPC e pra parsing de args do plugin OpenCode. |

## 5) Plano prático de ação

| Ordem | Ação | Motivo |
|---|---|---|
| 1 | Adicionar healthcheck + logs | Base pra diagnosticar sem ficar adivinhando. |
| 2 | Reforçar reconexão OpenCode | Elimina necessidade de reiniciar tudo quando app fecha/abre. |
| 3 | Padronizar fluxo "validar no aparelho" | Checklist + uso direto das tools. Evita escrever comandos no chat. |
| 4 | Melhorar mensagens de erro | Menos frustração quando pipe não conecta. |
| 5 | Unificar ferramentas de validação | Considerar expor logcat/ui_tree/screenshot via MCP do Digitama pra centralizar tudo num lugar só. |

## 6) Conclusão

O Digitama já está muito bem arquitetado. A maior melhoria hoje é observabilidade + reconexão.

- Pra conexão com OpenCode: foco em healthcheck + reconexão automática. Assim fica resiliente a reinícios do app.
- Pra ferramenta/agente: foco em "ação silenciosa" + checklist padronizado. Menos texto no chat, mais ação direta via tools e validação real no aparelho.

A arquitetura com pipe nomeado por SID + budgets + "nunca travar o agente" está certíssima. Com esses ajustes fica ainda mais confiável pra uso diário com Claude Code e OpenCode.

---

## 7) Análise de viabilidade (28/10/2026)

Conferido contra o código. Esforço: P = pequeno, M = médio, G = grande.

**Correção de premissa:** o plugin do OpenCode não mantém pipe aberto. Cada evento roda um `digitama-hook --agent opencode` novo (`src-tauri/src/opencode.rs`, `relay()`), então "reconectar o pipe" não se aplica: com o app reiniciado, o próximo evento já chega. O ponto frágil real é a assinatura de eventos (`ctx.event.subscribe`): se ela cai, o erro é engolido por `.catch(()=>{})` e o laço não é refeito, e o plugin fica mudo até reiniciar o OpenCode.

| Item | Situação | Viável / esforço | Recomendação |
|---|---|---|---|
| 4.1 Healthcheck | Não existe | Sim, P | Heartbeat do plugin + "último evento: agente + horário" no app |
| 4.1 Reconexão | Pipe: não precisa. Assinatura de eventos: falta | Sim, P | Refazer o `for await` em laço com espera crescente até `abort()` |
| 4.1 Mapeamento de eventos | Parcial; o relatório cita nomes antigos (`session.idle`, `permission.updated`, `message.*`) | Sim, P–M | Aceitar aliases e registrar eventos desconhecidos no log |
| 4.1 Erros da API | `permission.reply` com `catch` silencioso | Sim, P | Avisar no balão quando a resposta falhar |
| 4.2 Ação silenciosa / checklist / resets | Comportamento do modelo, não código do Digitama | Parcial | Feito na extensão: detecta chamada de ferramenta escrita como texto e loops em ciclo. O resto vai como instrução (AGENTS.md/skill) no projeto validado |
| 4.2 Visibilidade de estado | Extensão↔serviço já mostra conectado/reconectar; plugin↔app não | Sim, P | Junto do healthcheck |
| 4.3 Janela não encontrada | Mensagem sem sugestões | Sim, P | Listar janelas visíveis parecidas |
| 4.3 Múltiplos monitores | Já existe (`monitor: cursor\|all`) | — | Só testar DPI misto |
| 4.3 Nome automático | Já existe (`{data}_{titulo}.png`) | — | Nada a fazer |
| 4.3 logcat/ui_tree no MCP do Digitama | Não; é do screen-mirror | G, fora do escopo | Manter os dois MCPs |
| 4.4 Logs do relay | Não existe | Sim, P–M | Log opcional por variável de ambiente em %LOCALAPPDATA% |
| 4.4 Métricas | Não existe | Sim, M | Depois dos logs |
| 4.4 Erro mais claro | Já sugere abrir o app | Sim, P | Separar "pipe não existe" de "timeout" |
| 4.4 Testes | Parciais | Sim, M | Testar `plugin_source()` e o parse de `--agent opencode` |

Os budgets citados (2 s / 110 s / 20 s) conferem com `hook/src/main.rs`.

**Ordem sugerida:** (1) reassinatura de eventos do plugin + heartbeat; (2) log opcional do relay; (3) avisos de erro no `permission.reply`; (4) sugestões no screenshot.

## 8) Uso da cota grátis (dados reais de 26 a 28/10/2026)

- A cota grátis do OpenCode **não é uma janela móvel de 5 h**: todas as recusas (`provider.free-limit`, 429) liberaram às **20:59 (BRT) = 00:00 UTC**. É uma cota diária. O `retryAfterMs` do servidor estava certo, e a extensão já mostrava o horário de volta exato.
- O "usado" era contado nas últimas 5 h. Em 27/10, o uso foi das 21:00 às 00:15 (menos de 5 h), então o número exibido bateu por coincidência: **≈ 983 mil tokens** (entrada + saída + raciocínio). Fora desse caso, a conta misturava o uso de antes do reinício.
- **O limite não dá para deduzir dos tokens:** o ciclo de 26–27/10 parou em ≈ 4,04 mi tokens (1.133 chamadas, ≈ 92,9 mi com cache lido), e o de 27–28/10 parou em ≈ 0,98 mi (927 chamadas, ≈ 74,1 mi com cache). O servidor deve medir outra coisa (custo ponderado por modelo e/ou cache). Seguimos mostrando só o usado, sem inventar porcentagem.
- **Corrigido na extensão (`opencode-ext/src/uso.ts`):** a recusa exata grava o instante de reinício; a partir dele, o uso conta "desde 20:59" (o reinício mais recente). Sem nenhuma recusa ainda, continua "últimas 5 h".

## 9) Ideias do OpenChamber (MIT, github.com/btriapitsyn/openchamber)

Licença MIT: dá para copiar a lógica, mantendo o aviso de copyright. A interface deles é React; a nossa é `main.js` sem framework, então vale portar a lógica e não os componentes.

| Recurso | Nossa extensão | Esforço | Prioridade |
|---|---|---|---|
| `@arquivo` com busca no servidor (`file.find`; `/api/find/file` não existe no v2) | Não tem | M | 1 |
| `@agente` (vai em `agents[{name, mention}]` no prompt) | Só o seletor | P | 2 |
| Arrastar e soltar arquivos (`drop` com `text/uri-list`) | Não tem | P | 3 |
| Fila de mensagens com o agente ocupado (`delivery` do v2) | Não tem | M | 4 |
| Faixa "N mensagens desfeitas · Refazer" | API já usada, falta a faixa | P | 5 |
| Anexos com aviso de tipo não suportado | Já tem, com plano B pelo caminho (melhor que o deles) | — | — |
| Comandos `/`, contexto e tokens | Já tem | — | — |
