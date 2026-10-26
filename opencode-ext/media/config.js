// Configurações: abas Tema, Conexões e MCPs. Só desenha; o host
// (src/painelConfig.ts) consulta estados, abre terminais e grava.
(function () {
  const vs = acquireVsCodeApi();
  const I = window.ICONE;
  const app = document.getElementById("app");
  const enviar = (m) => vs.postMessage(m);
  const h = (tag, attrs = {}, ...filhos) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      // a CSP da webview bloqueia o atributo style: aplica pelo CSSOM, que é permitido
      else if (k === "style") { for (const d of String(v).split(";")) { const i = d.indexOf(":"); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } }
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const f of filhos.flat()) if (f !== undefined && f !== null && f !== false) el.append(f instanceof Node ? f : String(f));
    return el;
  };

  const ACENTOS = [
    { nome: "Digivice", cor: "#3fe0ff" },
    { nome: "Ametista", cor: "#a78bfa" },
    { nome: "Brasa", cor: "#ff8a5b" },
    { nome: "Coral", cor: "#ff6b8b" },
    { nome: "Folha", cor: "#3ddc84" },
    { nome: "Ouro", cor: "#ffc94a" },
  ];
  const ABAS = [
    { id: "tema", nome: "Tema", icone: "sparkle" },
    { id: "conexoes", nome: "Conexões", icone: "globe" },
    { id: "mcps", nome: "MCPs", icone: "tool" },
  ];

  let S = { aba: (vs.getState() || {}).aba || "tema", tema: null, conexoes: [], estados: {}, mcps: null, provedores: [], relay: false, erro: "", nova: null, novoMcp: null, removendo: null };
  const guardar = () => vs.setState({ aba: S.aba });
  let ultimaAba = null;

  // ── tema ──
  function abaTema() {
    const t = S.tema;
    if (!t) return h("p", { class: "muted" }, "Carregando…");
    const set = (parcial) => enviar({ tipo: "tema", tema: parcial });
    return h("div", { class: "secoes" },
      secao("Cor de destaque", "Contorno da caixa de mensagem, botões de agente e modelo, bola de contexto e menus.",
        h("div", { class: "cores" },
          ...ACENTOS.map((a) => h("button", { class: "cor" + (t.acento === a.cor ? " ativa" : ""), style: `--c:${a.cor}`, title: a.nome, onclick: () => set({ acento: a.cor }) },
            h("span", { class: "amostra" }, t.acento === a.cor ? I("check", 14) : null), a.nome)),
          h("label", { class: "cor livre", title: "Escolher outra cor" }, h("input", { type: "color", value: t.acento, onchange: (e) => set({ acento: e.target.value }) }), "Outra"))),
      secao("Densidade", "Espaçamento das mensagens e da caixa de texto.",
        seg([["confortavel", "Confortável"], ["compacta", "Compacta"]], t.densidade, (v) => set({ densidade: v }))),
      secao("Animações", "Onda da bola de contexto, entradas e pulsos. Desligar alivia o PC.",
        seg([[true, "Ligadas"], [false, "Desligadas"]], t.animacoes, (v) => set({ animacoes: v }))),
      h("div", { class: "previa", style: `--acento:${t.acento}` },
        h("div", { class: "caixa-previa" }, h("span", { class: "ph" }, "Pergunte ou peça algo…"),
          h("div", { class: "linha" }, h("span", { class: "chip" }, "Build"), h("span", { class: "chip" }, I("brain", 12), "Big Pickle"), h("span", { class: "flex" }), h("span", { class: "env" }, I("send", 13)))),
        h("small", {}, "Prévia da caixa de mensagem com foco")));
  }

  function secao(titulo, desc, ...corpo) {
    return h("section", { class: "secao" }, h("div", { class: "tit" }, h("h3", {}, titulo), desc ? h("p", {}, desc) : null), h("div", { class: "corpo" }, ...corpo));
  }
  function seg(opcoes, atual, aoMudar) {
    return h("div", { class: "seg" }, ...opcoes.map(([v, nome]) => h("button", { class: v === atual ? "ativo" : "", onclick: () => aoMudar(v) }, nome)));
  }

  // ── conexões ──
  function cartaoConexao(c) {
    const e = S.estados[c.id] || { carregando: true };
    const st = e.carregando ? "carregando" : !e.instalado ? "ausente" : e.logado ? "ok" : "pendente";
    const rotulo = { carregando: "verificando…", ausente: "não instalado", ok: "conectado", pendente: "desconectado" }[st];
    const acoes = [];
    if (st === "ausente" && c.instalar) acoes.push(h("button", { class: "sec", onclick: () => enviar({ tipo: "login", id: c.id, acao: "instalar" }), title: c.instalar }, I("external", 13), "Instalar"));
    if (st === "pendente" && c.login) acoes.push(h("button", { class: "pri", onclick: () => enviar({ tipo: "login", id: c.id }), title: c.login }, I("zap", 13), "Conectar"));
    if (st === "ok" && c.login) acoes.push(h("button", { class: "neg", onclick: () => enviar({ tipo: "login", id: c.id }), title: c.login }, "Trocar conta"));
    if (st === "ok" && c.logout) acoes.push(h("button", { class: "neg", onclick: () => enviar({ tipo: "login", id: c.id, acao: "logout" }), title: c.logout }, "Sair"));
    acoes.push(h("button", { class: "ic", title: "Verificar de novo", onclick: () => enviar({ tipo: "checar", id: c.id }) }, I("refresh", 14)));
    if (c.personalizada) acoes.push(h("button", { class: "ic perigo-ic", title: "Remover esta conexão", onclick: () => enviar({ tipo: "removerConexao", id: c.id }) }, I("trash", 14)));
    return h("div", { class: "conexao", "data-st": st },
      h("span", { class: "selo" }, I(c.icone, 18)),
      h("div", { class: "info" },
        h("div", { class: "nome" }, h("b", {}, c.nome), h("span", { class: "status" }, h("span", { class: "ponto" }), rotulo)),
        h("small", {}, e.detalhe && !e.carregando ? e.detalhe : c.descricao),
        h("code", { class: "cmd", title: "Comando usado para verificar" }, c.status)),
      h("div", { class: "acoes" }, ...acoes));
  }

  function formNova() {
    const n = S.nova;
    const campo = (rot, k, ph, dica) => h("label", { class: "campo" }, h("span", {}, rot), h("input", { type: "text", value: n[k] || "", placeholder: ph, oninput: (e) => (n[k] = e.target.value) }), dica ? h("small", {}, dica) : null);
    return h("div", { class: "conexao nova" },
      h("div", { class: "form" },
        campo("Nome", "nome", "Ex.: Vercel"),
        campo("Comando de status", "status", "Ex.: vercel whoami", "Saída 0 = conectado. Roda nesta máquina; tokens na saída são mascarados."),
        campo("Comando de login (opcional)", "login", "Ex.: vercel login", "Roda no terminal do VS Code, à sua vista."),
        campo("Descrição (opcional)", "descricao", "Para que serve"),
        h("div", { class: "acoes" },
          h("button", { class: "neg", onclick: () => ((S.nova = null), desenhar()) }, "Cancelar"),
          h("button", { class: "pri", onclick: () => enviar({ tipo: "addConexao", ...n }) }, I("plus", 13), "Adicionar"))));
  }

  function abaConexoes() {
    const prov = S.provedores;
    return h("div", { class: "secoes" },
      h("p", { class: "intro" }, "Conectar abre o login oficial de cada ferramenta no terminal do VS Code. A extensão só consulta o estado: nunca vê senha nem token."),
      h("div", { class: "lista" }, ...S.conexoes.map(cartaoConexao), S.nova ? formNova() : h("button", { class: "adicionar", onclick: () => ((S.nova = {}), desenhar()) }, I("plus", 16), "Adicionar ferramenta")),
      secao("Provedores do OpenCode", "Contas de modelos conectadas ao OpenCode (além dos grátis).",
        h("div", { class: "chips" }, ...(prov.length ? prov.map((p) => h("span", { class: "tag ok" }, I("check", 11), p.name)) : [h("span", { class: "muted" }, "Só os modelos grátis do OpenCode.")])),
        h("button", { class: "sec", onclick: () => enviar({ tipo: "provedorLogin" }) }, I("zap", 13), "Conectar provedor (opencode auth login)")));
  }

  // ── MCPs ──
  function abaMcps() {
    const lista = S.mcps;
    const nm = S.novoMcp;
    const linhas = lista === null ? [h("p", { class: "muted" }, "Carregando…")] : lista.length ? lista.map((m) => {
      const ligado = m.status === "connected" || m.status === "pending";
      return h("div", { class: "mcp", "data-st": m.status },
        h("span", { class: "ponto" }),
        h("div", { class: "info" }, h("b", {}, m.name), h("small", {}, { connected: "conectado", pending: "conectando…", disabled: "desligado", failed: "falhou" + (m.erro ? ": " + m.erro : ""), needs_auth: "precisa de login" }[m.status] || m.status)),
        S.removendo === m.name
          ? [h("span", { class: "aviso-inline" }, "Remover?"), h("button", { class: "neg", onclick: () => ((S.removendo = null), desenhar()) }, "Não"), h("button", { class: "perigo", onclick: () => ((S.removendo = null), enviar({ tipo: "mcpRemover", nome: m.name })) }, "Remover")]
          : [h("button", { class: "interruptor" + (ligado ? " on" : ""), role: "switch", "aria-checked": String(ligado), title: ligado ? "Desligar" : "Ligar", onclick: () => enviar({ tipo: "mcpAlternar", nome: m.name, ligar: !ligado }) }, h("span")),
             h("button", { class: "ic perigo-ic", title: "Remover", onclick: () => ((S.removendo = m.name), desenhar()) }, I("trash", 14))]);
    }) : [h("p", { class: "muted" }, "Nenhum servidor MCP configurado no OpenCode.")];

    return h("div", { class: "secoes" },
      h("div", { class: "lista" }, ...linhas),
      S.relay && !(lista || []).some((m) => m.name === "digitama")
        ? h("div", { class: "destaque" }, I("egg", 18), h("div", {}, h("b", {}, "MCP do pet Digitama"), h("small", {}, "screenshot, print_janela, pet_say e pet_status no OpenCode.")),
            h("button", { class: "pri", onclick: () => enviar({ tipo: "mcpAdicionar", nome: "digitama", digitama: true }) }, I("plus", 13), "Adicionar"))
        : null,
      nm
        ? h("div", { class: "conexao nova" }, h("div", { class: "form" },
            h("label", { class: "campo" }, h("span", {}, "Nome"), h("input", { type: "text", value: nm.nome || "", placeholder: "ex.: context7", oninput: (e) => (nm.nome = e.target.value) })),
            seg([["local", "Local (comando)"], ["remote", "Remoto (URL)"]], nm.modo, (v) => ((nm.modo = v), desenhar())),
            nm.modo === "remote"
              ? h("label", { class: "campo" }, h("span", {}, "URL"), h("input", { type: "text", value: nm.url || "", placeholder: "https://…/mcp", oninput: (e) => (nm.url = e.target.value) }))
              : h("label", { class: "campo" }, h("span", {}, "Comando"), h("input", { type: "text", value: nm.comando || "", placeholder: "npx -y @upstash/context7-mcp", oninput: (e) => (nm.comando = e.target.value) })),
            h("small", { class: "muted" }, "Chaves de API: use {env:NOME} em vez de colar a chave."),
            h("div", { class: "acoes" }, h("button", { class: "neg", onclick: () => ((S.novoMcp = null), desenhar()) }, "Cancelar"), h("button", { class: "pri", onclick: () => enviar({ tipo: "mcpAdicionar", ...nm }) }, I("plus", 13), "Adicionar"))))
        : h("button", { class: "adicionar", onclick: () => ((S.novoMcp = { modo: "local" }), desenhar()) }, I("plus", 16), "Adicionar servidor MCP"),
      h("button", { class: "neg pequeno", onclick: () => enviar({ tipo: "atualizarMcps" }) }, I("refresh", 13), "Atualizar"));
  }

  function desenhar() {
    const corpo = S.aba === "tema" ? abaTema() : S.aba === "conexoes" ? abaConexoes() : abaMcps();
    // anima só ao trocar de aba: redesenhos por estado de conexão não piscam
    if (S.aba !== ultimaAba) corpo.classList.add("entra");
    ultimaAba = S.aba;
    app.style.setProperty("--acento", S.tema?.acento || "#3fe0ff");
    app.replaceChildren(
      h("nav", { class: "abas", role: "tablist" },
        h("div", { class: "marca" }, I("egg", 18), h("b", {}, "Configurações")),
        ...ABAS.map((a) => h("button", { role: "tab", "aria-selected": String(S.aba === a.id), class: "aba" + (S.aba === a.id ? " ativa" : ""), onclick: () => ((S.aba = a.id), guardar(), desenhar()) }, I(a.icone, 15), a.nome))),
      h("main", { class: "conteudo" },
        h("h2", {}, ABAS.find((a) => a.id === S.aba).nome),
        S.erro ? h("div", { class: "erro" }, I("question", 14), S.erro, h("button", { class: "ic", onclick: () => ((S.erro = ""), desenhar()) }, I("x", 13))) : null,
        corpo));
  }

  window.addEventListener("message", ({ data: m }) => {
    if (m.tipo === "dados") {
      S.tema = m.tema;
      S.conexoes = m.conexoes;
      S.relay = m.relay;
      if (m.aba) S.aba = m.aba;
    } else if (m.tipo === "tema") S.tema = m.tema;
    else if (m.tipo === "estado") S.estados[m.id] = m;
    else if (m.tipo === "conexoes") {
      S.conexoes = m.conexoes;
      S.nova = null;
    } else if (m.tipo === "mcps") {
      S.mcps = m.lista;
      S.provedores = m.provedores;
      if (m.adicionado) S.novoMcp = null;
    } else if (m.tipo === "aba") S.aba = m.aba;
    else if (m.tipo === "erro") S.erro = m.texto;
    // estado de conexão chegando enquanto você digita num formulário: guarda e redesenha depois
    if (m.tipo === "estado" && document.activeElement?.closest?.(".form")) return void document.activeElement.addEventListener("blur", desenhar, { once: true });
    desenhar();
  });

  desenhar();
  enviar({ tipo: "pronto" });
})();
