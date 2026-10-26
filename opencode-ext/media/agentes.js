// Montador de agentes: arraste funções para o fluxo, solte um modelo em cada
// etapa e grave. O host (src/painelAgentes.ts) gera a prévia e grava os .md.
(function () {
  const vs = acquireVsCodeApi();
  const I = window.ICONE;
  const app = document.getElementById("app");

  const FUNCOES = [
    { chave: "planejador", nome: "Planejador", cor: "#3fe0ff", icone: "flow", descricao: "Entende o pedido, lê o código e devolve um plano em passos curtos, sem editar nada.", instrucoes: "Leia o pedido e o código relevante. Devolva um plano numerado, com os arquivos que mudam e os riscos. Não edite arquivos.", editar: "deny", terminal: "deny", web: "ask" },
    { chave: "pesquisador", nome: "Pesquisador", cor: "#a78bfa", icone: "globe", descricao: "Busca na documentação e na web o que for preciso e resume com as fontes.", instrucoes: "Pesquise o necessário (documentação oficial primeiro). Resuma em tópicos e cite os links usados.", editar: "deny", terminal: "deny", web: "allow" },
    { chave: "programador", nome: "Programador", cor: "#3ddc84", icone: "pencil", descricao: "Implementa o plano: edita os arquivos e roda o build.", instrucoes: "Implemente o plano recebido com mudanças pequenas e no estilo do código ao redor. Rode o build ao final e informe o resultado.", editar: "allow", terminal: "ask", web: "deny" },
    { chave: "revisor", nome: "Revisor", cor: "#ffc94a", icone: "search", descricao: "Revisa as mudanças procurando bugs, regressões e falta de testes. Não edita.", instrucoes: "Revise as mudanças atuais (git diff). Liste os problemas por gravidade, com arquivo e linha. Não edite arquivos.", editar: "deny", terminal: "ask", web: "deny" },
    { chave: "testador", nome: "Testador", cor: "#ff8a5b", icone: "terminal", descricao: "Escreve e roda os testes e relata o que falhou.", instrucoes: "Escreva testes para o que mudou, rode a suíte e relate falhas com a saída relevante.", editar: "allow", terminal: "allow", web: "deny" },
    { chave: "documentador", nome: "Documentador", cor: "#5bb8ff", icone: "file", descricao: "Atualiza README, CHANGELOG e comentários conforme as mudanças.", instrucoes: "Atualize a documentação afetada pelas mudanças, em português claro e objetivo.", editar: "allow", terminal: "deny", web: "deny" },
    { chave: "visual", nome: "Analista visual", cor: "#ff5d9e", icone: "eye", precisa: ["image"], descricao: "Analisa prints e imagens de interface e aponta problemas visuais e de usabilidade.", instrucoes: "Analise as imagens anexadas. Aponte problemas de layout, hierarquia, contraste e usabilidade, do mais grave ao menos grave.", editar: "deny", terminal: "deny", web: "deny" },
    { chave: "personalizado", nome: "Personalizado", cor: "#9aa4b2", icone: "sparkle", descricao: "", instrucoes: "", editar: "ask", terminal: "ask", web: "ask" },
  ];
  const EFEITOS = [
    { v: "allow", nome: "Livre", icone: "check" },
    { v: "ask", nome: "Perguntar", icone: "question" },
    { v: "deny", nome: "Bloqueado", icone: "x" },
  ];
  const PERMS = [
    { k: "editar", nome: "Editar arquivos", icone: "pencil" },
    { k: "terminal", nome: "Rodar comandos", icone: "terminal" },
    { k: "web", nome: "Acessar a web", icone: "globe" },
  ];

  const salvo = vs.getState() || {};
  let S = {
    fluxo: salvo.fluxo || { orquestrador: { id: "orquestrador", nome: "Orquestrador", descricao: "", modelo: "" }, etapas: [] },
    destino: salvo.destino || "projeto",
    sel: salvo.sel ?? "orq",
    soGratis: salvo.soGratis ?? true,
  };
  let D = { modelos: [], agentes: [], salvos: [], temPasta: true };
  let previa = null;

  const guardar = () => vs.setState(S);
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
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const paraId = (nome) => {
    const s = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return /^[a-z]/.test(s) ? s : s ? "a-" + s.slice(0, 38) : "agente";
  };
  const idLivre = (base) => {
    const usados = new Set([S.fluxo.orquestrador.id, ...S.fluxo.etapas.map((e) => e.id)]);
    let id = base, n = 2;
    while (usados.has(id)) id = `${base}-${n++}`;
    return id;
  };
  const modeloPorRef = (ref) => D.modelos.find((m) => `${m.providerID}/${m.id}` === (ref || "").split("#")[0]);

  // ── capacidades ──
  function badges(m, compacto) {
    const b = [];
    if (m.gratis) b.push(h("span", { class: "badge gratis" }, "grátis"));
    for (const c of m.entrada) if (CAPACIDADES[c]) b.push(h("span", { class: "badge cap", title: CAPACIDADES[c].rotulo }, I(CAPACIDADES[c].icone, 11), compacto ? null : CAPACIDADES[c].rotulo));
    if (!m.ferramentas) b.push(h("span", { class: "badge alerta", title: "Não usa ferramentas: não edita nem roda comandos" }, I("x", 11), compacto ? null : "sem ferramentas"));
    if (m.variantes.length) b.push(h("span", { class: "badge", title: "Níveis de raciocínio: " + m.variantes.join(", ") }, I("brain", 11), compacto ? m.variantes.length : `raciocínio (${m.variantes.length})`));
    b.push(h("span", { class: "badge", title: "Janela de contexto" }, fmt(m.contexto)));
    return b;
  }
  function descreverModelo(m) {
    const vê = m.entrada.map((c) => CAPACIDADES[c]?.rotulo.toLowerCase()).filter(Boolean);
    const partes = [`Contexto de ${fmt(m.contexto)} tokens, responde até ${fmt(m.saida)}.`];
    partes.push(vê.length ? `Além de texto, ${vê.join(", ")}.` : "Só lê texto (não vê imagens).");
    partes.push(m.ferramentas ? "Usa ferramentas (editar, terminal, busca)." : "Não usa ferramentas: serve só para conversar ou opinar.");
    if (m.variantes.length) partes.push(`Raciocínio ajustável: ${m.variantes.join(", ")}.`);
    return partes.join(" ");
  }
  function faltas(etapa) {
    const f = FUNCOES.find((x) => x.chave === etapa.chave);
    const m = modeloPorRef(etapa.modelo);
    const r = [];
    if (!m) return r;
    for (const c of f?.precisa || []) if (!m.entrada.includes(c)) r.push(`${m.name} não ${CAPACIDADES[c].rotulo.toLowerCase()}`);
    if (!m.ferramentas && (etapa.editar !== "deny" || etapa.terminal !== "deny")) r.push(`${m.name} não usa ferramentas`);
    return r;
  }

  // ── arrastar ──
  let arrasto = null; // { tipo: "funcao"|"modelo"|"etapa", valor }
  const arrastavel = (el, tipo, valor) => {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      arrasto = { tipo, valor };
      e.dataTransfer.effectAllowed = tipo === "etapa" ? "move" : "copy";
      e.dataTransfer.setData("text/plain", String(valor));
      document.body.dataset.arrastando = tipo;
      el.classList.add("arrastado");
    });
    el.addEventListener("dragend", () => {
      arrasto = null;
      delete document.body.dataset.arrastando;
      el.classList.remove("arrastado");
      document.querySelectorAll(".sobre").forEach((x) => x.classList.remove("sobre"));
    });
  };
  const alvo = (el, aceita, soltar) => {
    el.addEventListener("dragover", (e) => {
      if (!arrasto || !aceita.includes(arrasto.tipo)) return;
      e.preventDefault();
      el.classList.add("sobre");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("sobre");
    });
    el.addEventListener("drop", (e) => {
      if (!arrasto || !aceita.includes(arrasto.tipo)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("sobre");
      const a = arrasto;
      arrasto = null;
      soltar(a);
    });
  };

  function novaEtapa(chave, modelo) {
    const f = FUNCOES.find((x) => x.chave === chave);
    return {
      chave, id: idLivre(f.chave === "personalizado" ? "agente" : f.chave), nome: f.nome, cor: f.cor,
      descricao: f.descricao, instrucoes: f.instrucoes, modelo: modelo || "", editar: f.editar, terminal: f.terminal, web: f.web,
    };
  }
  function inserir(pos, a) {
    const es = S.fluxo.etapas;
    if (a.tipo === "funcao") {
      es.splice(pos, 0, novaEtapa(a.valor));
      S.sel = pos;
    } else if (a.tipo === "modelo") {
      es.splice(pos, 0, novaEtapa("personalizado", a.valor));
      S.sel = pos;
    } else if (a.tipo === "etapa") {
      const de = Number(a.valor);
      const [e] = es.splice(de, 1);
      const para = de < pos ? pos - 1 : pos;
      es.splice(para, 0, e);
      S.sel = para;
    }
    mudou();
  }

  // ── desenho ──
  // coluna de kanban: cabeçalho com contagem e uma pilha de cartões
  function coluna(cls, icone, titulo, conta, extra, ...cartoes) {
    return h("section", { class: "coluna " + cls },
      h("header", {}, I(icone, 14), h("h3", {}, titulo), conta !== null ? h("span", { class: "conta" }, conta) : null, h("span", { class: "flex" }), extra),
      h("div", { class: "cards" }, ...cartoes));
  }

  function colFuncoes() {
    const funcoes = FUNCOES.map((f) => {
      const el = h("div", { class: "peca funcao", style: `--cor:${f.cor}`, title: f.descricao || "Comece do zero", tabindex: "0",
        onkeydown: (e) => e.key === "Enter" && inserir(S.fluxo.etapas.length, { tipo: "funcao", valor: f.chave }) },
        h("span", { class: "bolinha" }, I(f.icone, 14)), h("div", {}, h("b", {}, f.nome), h("small", {}, f.descricao || "Comece do zero")),
        f.precisa ? h("span", { class: "badge cap", title: "Precisa de um modelo que vê imagens" }, I("eye", 11)) : null);
      arrastavel(el, "funcao", f.chave);
      return el;
    });
    return coluna("c-funcoes", "users", "Funções", FUNCOES.length, null, h("p", { class: "dica" }, "Arraste para o fluxo (ou Enter)."), ...funcoes);
  }

  function colModelos() {
    const ms = D.modelos.filter((m) => !S.soGratis || m.gratis);
    const modelos = ms.map((m) => {
      const ref = `${m.providerID}/${m.id}`;
      const el = h("div", { class: "peca modelo", title: descreverModelo(m), tabindex: "0" }, h("span", { class: "bolinha m" }, I("brain", 14)),
        h("div", {}, h("b", {}, m.name), h("div", { class: "badges" }, ...badges(m, true))));
      arrastavel(el, "modelo", ref);
      return el;
    });
    const filtro = h("label", { class: "filtro" }, h("input", { type: "checkbox", checked: S.soGratis || undefined, onchange: (e) => ((S.soGratis = e.target.checked), mudou()) }), "só grátis");
    return coluna("c-modelos", "brain", "Modelos", ms.length, filtro, h("p", { class: "dica" }, "Solte sobre uma etapa para usar o modelo nela."), ...modelos);
  }

  function cartaoOrq() {
    const o = S.fluxo.orquestrador;
    const m = modeloPorRef(o.modelo);
    const el = h("div", { class: "cartao orq" + (S.sel === "orq" ? " sel" : ""), onclick: () => ((S.sel = "orq"), mudou()) },
      h("span", { class: "bolinha o" }, I("flow", 16)),
      h("div", { class: "info" }, h("small", {}, "Agente principal"), h("b", {}, o.nome), h("div", { class: "badges" }, m ? [h("span", { class: "badge mod" }, m.name), ...badges(m, true)] : h("span", { class: "badge vazio" }, "modelo padrão"))));
    alvo(el, ["modelo"], (a) => ((o.modelo = a.valor), (S.sel = "orq"), mudou()));
    return el;
  }

  function cartaoEtapa(e, i) {
    const m = modeloPorRef(e.modelo);
    const f = FUNCOES.find((x) => x.chave === e.chave) || FUNCOES[FUNCOES.length - 1];
    const problemas = faltas(e);
    const icPerm = (k, ic) => h("span", { class: "perm " + e[k], title: `${PERMS.find((p) => p.k === k).nome}: ${EFEITOS.find((x) => x.v === e[k]).nome}` }, I(ic, 11));
    const el = h("div", { class: "cartao etapa" + (S.sel === i ? " sel" : ""), style: `--cor:${e.cor}`, onclick: () => ((S.sel = i), mudou()) },
      h("span", { class: "grip", title: "Arraste para reordenar" }, I("grip", 14)),
      h("span", { class: "num" }, i + 1),
      h("span", { class: "bolinha" }, I(f.icone, 15)),
      h("div", { class: "info" },
        h("b", {}, e.nome, h("code", {}, e.id)),
        h("small", { class: "desc" }, e.descricao || "sem descrição"),
        h("div", { class: "badges" },
          m ? [h("span", { class: "badge mod" }, m.name), ...badges(m, true)] : h("span", { class: "badge vazio" }, I("brain", 11), "solte um modelo aqui"),
          h("span", { class: "perms" }, icPerm("editar", "pencil"), icPerm("terminal", "terminal"), icPerm("web", "globe"))),
        problemas.length ? h("small", { class: "falta" }, I("question", 11), problemas.join(" · ")) : null),
      h("button", { class: "ic", title: "Remover", onclick: (ev) => {
        ev.stopPropagation();
        S.fluxo.etapas.splice(i, 1);
        S.sel = "orq";
        mudou();
      } }, I("trash", 14)));
    arrastavel(el, "etapa", i);
    alvo(el, ["modelo"], (a) => ((e.modelo = a.valor), (S.sel = i), mudou()));
    return el;
  }

  function vaga(pos, grande) {
    const el = h("div", { class: "vaga" + (grande ? " grande" : "") }, grande ? [I("plus", 18), h("span", {}, S.fluxo.etapas.length ? "Solte aqui para adicionar ao fim" : "Arraste uma função para cá")] : null);
    alvo(el, ["funcao", "modelo", "etapa"], (a) => inserir(pos, a));
    return el;
  }

  function fluxo() {
    const itens = [cartaoOrq()];
    S.fluxo.etapas.forEach((e, i) => itens.push(vaga(i), cartaoEtapa(e, i)));
    itens.push(vaga(S.fluxo.etapas.length, true));
    const salvos = D.salvos.length
      ? h("select", { class: "carregar", onchange: (e) => {
          const s = D.salvos[Number(e.target.value)];
          if (!s) return;
          S.fluxo = JSON.parse(JSON.stringify(s.fluxo));
          S.destino = s.destino;
          S.sel = "orq";
          mudou();
        } }, h("option", { value: "" }, "Abrir fluxo salvo…"), ...D.salvos.map((s, i) => h("option", { value: String(i) }, `${s.fluxo.orquestrador.nome} (${s.destino})`)))
      : null;
    const limpar = h("button", { class: "ic", title: "Limpar o fluxo", onclick: () => {
      S.fluxo = { orquestrador: { id: "orquestrador", nome: "Orquestrador", descricao: "", modelo: "" }, etapas: [] };
      S.sel = "orq";
      mudou();
    } }, I("trash", 14));
    const col = coluna("fluxo c-fluxo", "flow", "Fluxo", S.fluxo.etapas.length, h("span", { class: "acoes-col" }, salvos, limpar), ...itens);
    return col;
  }

  function campo(rot, el, dica) {
    return h("label", { class: "campo" }, h("span", {}, rot), el, dica ? h("small", {}, dica) : null);
  }
  function seletorModelo(valor, aoMudar) {
    const sel = h("select", { onchange: (e) => aoMudar(e.target.value) },
      h("option", { value: "" }, "Modelo padrão do OpenCode"),
      ...["Grátis", "Outros"].map((g) => {
        const ms = D.modelos.filter((m) => (g === "Grátis") === m.gratis);
        return ms.length ? h("optgroup", { label: g }, ...ms.map((m) => h("option", { value: `${m.providerID}/${m.id}` }, m.name))) : null;
      }).filter(Boolean));
    sel.value = (valor || "").split("#")[0];
    return sel;
  }
  function blocoModelo(ref, aoMudar) {
    const m = modeloPorRef(ref);
    const variante = (ref || "").split("#")[1] || "";
    const wrap = h("div", { class: "blocomodelo" }, seletorModelo(ref, (v) => aoMudar(v)));
    if (m) {
      wrap.append(h("div", { class: "badges" }, ...badges(m, false)), h("p", { class: "descmod" }, descreverModelo(m)));
      if (m.variantes.length) {
        wrap.append(campo("Nível de raciocínio", h("div", { class: "seg" },
          h("button", { class: variante ? "" : "ativo", onclick: () => aoMudar(`${m.providerID}/${m.id}`) }, "padrão"),
          ...m.variantes.map((v) => h("button", { class: v === variante ? "ativo" : "", onclick: () => aoMudar(`${m.providerID}/${m.id}#${v}`) }, v)))));
      }
    }
    return wrap;
  }

  function detalhes() {
    if (S.sel === "orq" || S.fluxo.etapas[S.sel] === undefined) {
      const o = S.fluxo.orquestrador;
      return h("section", { class: "coluna detalhes" },
        h("div", { class: "cab" }, h("span", { class: "bolinha o" }, I("flow", 16)), h("div", {}, h("small", {}, "Agente principal"), h("b", {}, o.nome))),
        h("p", { class: "dica" }, "É ele que você escolhe no chat. Ele chama as etapas na ordem do fluxo e só pode chamar esses subagentes."),
        campo("Nome", h("input", { type: "text", value: o.nome, oninput: (e) => { o.nome = e.target.value; o.id = paraId(e.target.value) || "orquestrador"; mudouLeve(); } }), "Id: " + o.id),
        campo("Descrição", h("textarea", { rows: "2", placeholder: "Em branco = gerada a partir das etapas", oninput: (e) => ((o.descricao = e.target.value), mudouLeve()) }, o.descricao)),
        campo("Modelo", blocoModelo(o.modelo, (v) => ((o.modelo = v), mudou()))));
    }
    const e = S.fluxo.etapas[S.sel];
    const f = FUNCOES.find((x) => x.chave === e.chave);
    return h("section", { class: "coluna detalhes", style: `--cor:${e.cor}` },
      h("div", { class: "cab" }, h("span", { class: "bolinha" }, I(f?.icone || "sparkle", 16)), h("div", {}, h("small", {}, `Etapa ${S.sel + 1} · subagente`), h("b", {}, e.nome)),
        h("input", { type: "color", value: e.cor, title: "Cor", oninput: (ev) => ((e.cor = ev.target.value), mudouLeve()) })),
      campo("Nome", h("input", { type: "text", value: e.nome, oninput: (ev) => { e.nome = ev.target.value; e.id = idLivre(paraId(ev.target.value)) ; mudouLeve(); } }), "Id: " + e.id),
      campo("O que faz", h("textarea", { rows: "2", placeholder: "Uma frase: o orquestrador usa isto para saber quando chamar", oninput: (ev) => ((e.descricao = ev.target.value), mudouLeve()) }, e.descricao)),
      campo("Modelo", blocoModelo(e.modelo, (v) => ((e.modelo = v), mudou()))),
      faltas(e).length ? h("p", { class: "falta" }, I("question", 12), faltas(e).join(" · ")) : null,
      h("div", { class: "campo" }, h("span", {}, "Permissões"),
        ...PERMS.map((p) => h("div", { class: "linhaperm" }, h("span", {}, I(p.icone, 13), p.nome), h("div", { class: "seg" },
          ...EFEITOS.map((x) => h("button", { class: (e[p.k] === x.v ? "ativo " : "") + x.v, title: x.nome, onclick: () => ((e[p.k] = x.v), mudou()) }, I(x.icone, 12), x.nome)))))),
      campo("Instruções", h("textarea", { rows: "6", placeholder: "Como esse agente deve trabalhar", oninput: (ev) => ((e.instrucoes = ev.target.value), mudouLeve()) }, e.instrucoes), "Vira o prompt de sistema do agente."));
  }

  function rodape() {
    return h("footer", {},
      h("div", { class: "seg destino" },
        h("button", { class: S.destino === "projeto" ? "ativo" : "", disabled: !D.temPasta || undefined, title: "Grava em .opencode/agents/ da pasta aberta", onclick: () => ((S.destino = "projeto"), mudou()) }, I("folder", 13), "Este projeto"),
        h("button", { class: S.destino === "global" ? "ativo" : "", title: "Grava em ~/.config/opencode/agents/", onclick: () => ((S.destino = "global"), mudou()) }, I("globe", 13), "Todos os projetos")),
      h("span", { class: "flex" }),
      h("span", { class: "resumo" }, `${S.fluxo.etapas.length} etapa(s) · ${S.fluxo.etapas.length + 1} arquivo(s)`),
      h("button", { class: "pri", disabled: !S.fluxo.etapas.length || undefined, onclick: () => enviar({ tipo: "previa", fluxo: S.fluxo, destino: S.destino }) }, I("eye", 14), "Prévia e gravar"));
  }

  function modalPrevia() {
    if (!previa) return null;
    const { arquivos, erros, gravado } = previa;
    let aberto = arquivos[0]?.caminho;
    const conteudo = h("pre", { class: "conteudo" });
    const lista = h("div", { class: "arquivos" });
    const mostrar = () => {
      lista.replaceChildren(...arquivos.map((a) => h("button", { class: "arquivo " + (a.caminho === aberto ? "ativo" : ""), onclick: () => ((aberto = a.caminho), mostrar()) },
        I("file", 13), h("span", {}, a.nome), h("span", { class: "estado " + a.estado }, { novo: "novo", atualiza: "atualiza", igual: "igual", bloqueado: "bloqueado" }[a.estado]))));
      conteudo.textContent = arquivos.find((a) => a.caminho === aberto)?.conteudo || "";
    };
    mostrar();
    const fechar = () => ((previa = null), desenhar());
    return h("div", { class: "modal", onclick: (e) => e.target.classList.contains("modal") && fechar() },
      h("div", { class: "janela" },
        h("div", { class: "cab" }, h("b", {}, gravado ? "Gravado!" : "Prévia dos arquivos"), h("span", { class: "flex" }), h("button", { class: "ic", title: "Fechar", onclick: fechar }, I("x", 16))),
        erros.length ? h("ul", { class: "erros" }, ...erros.map((e) => h("li", {}, e))) : null,
        gravado ? h("p", { class: "ok" }, I("check", 14), `Pronto. Escolha "${S.fluxo.orquestrador.nome}" na lista de agentes do chat.`) : null,
        h("div", { class: "corpo" }, lista, conteudo),
        h("div", { class: "acoes" },
          gravado
            ? [h("button", { class: "neg", onclick: () => enviar({ tipo: "abrirArquivo", caminho: aberto }) }, I("external", 14), "Abrir no editor"), h("button", { class: "pri", onclick: fechar }, "Fechar")]
            : [h("button", { class: "neg", onclick: fechar }, "Voltar"),
               h("button", { class: "pri", disabled: erros.length || undefined, onclick: () => enviar({ tipo: "gravar", fluxo: S.fluxo, destino: S.destino }) }, I("check", 14), "Gravar arquivos")])));
  }

  let foco = null;
  function desenhar() {
    // preserva o foco e o cursor de quem está digitando nos detalhes
    const ativo = document.activeElement;
    const det = ativo?.closest?.(".detalhes");
    if (det && (ativo.tagName === "INPUT" || ativo.tagName === "TEXTAREA")) {
      const campos = [...det.querySelectorAll("input,textarea")];
      foco = { i: campos.indexOf(ativo), ini: ativo.selectionStart, fim: ativo.selectionEnd };
    } else foco = null;
    const passos = h("div", { class: "passos" },
      h("span", {}, h("b", {}, "1"), "Arraste funções para o Fluxo"), I("chevron", 12),
      h("span", {}, h("b", {}, "2"), "Solte um modelo em cada etapa"), I("chevron", 12),
      h("span", {}, h("b", {}, "3"), "Ajuste nos Detalhes e grave"));
    app.replaceChildren(passos, h("div", { class: "quadro" }, colFuncoes(), colModelos(), fluxo(), detalhes()), rodape(), modalPrevia() || "");
    if (foco) {
      const el = [...app.querySelectorAll(".detalhes input,.detalhes textarea")][foco.i];
      if (el) {
        el.focus();
        try { el.setSelectionRange(foco.ini, foco.fim); } catch {}
      }
    }
  }
  function mudou() {
    guardar();
    desenhar();
  }
  // digitação: atualiza só o fluxo do meio, sem perder o foco do campo
  function mudouLeve() {
    guardar();
    const novo = fluxo();
    app.querySelector(".fluxo")?.replaceWith(novo);
    app.querySelector("footer")?.replaceWith(rodape());
  }

  window.addEventListener("message", ({ data: m }) => {
    if (m.tipo === "dados") {
      D = m;
      if (!D.temPasta) S.destino = "global";
      desenhar();
    } else if (m.tipo === "previa") {
      previa = { arquivos: m.arquivos, erros: m.erros, gravado: false };
      desenhar();
    } else if (m.tipo === "gravado") {
      previa = { ...(previa || { arquivos: [] }), erros: [], gravado: true };
      enviar({ tipo: "pronto" });
    } else if (m.tipo === "erro") {
      previa = { arquivos: previa?.arquivos || [], erros: [m.texto], gravado: false };
      desenhar();
    }
  });

  desenhar();
  enviar({ tipo: "pronto" });
})();
