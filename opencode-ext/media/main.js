// Webview da conversa: só desenha. Tudo que fala com o OpenCode passa pelo host
// (src/extension.ts) via postMessage.
(function () {
  const vs = acquireVsCodeApi();
  const app = document.getElementById("app");
  const I = window.ICONE;
  let E = { conectado: false, sessoes: [], modelos: [], agentes: [], comandos: [], ctx: { usado: 0, limite: 0 }, modo: "perguntar" };
  const vivos = new Map(); // assistantMessageID → { el, partes, tools }
  // respostas em andamento por formulário: sobrevivem aos redesenhos das pendências
  const respostas = new Map();
  let assinaturaPend = "";
  let pairTimer;

  const h = (tag, attrs = {}, ...filhos) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      // a CSP da webview bloqueia o atributo style: aplica pelo CSSOM, que é permitido
      else if (k === "style") { for (const d of String(v).split(";")) { const i = d.indexOf(":"); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } }
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const f of filhos.flat()) if (f !== undefined && f !== null && f !== false) el.append(f instanceof Node ? f : String(f));
    return el;
  };
  const enviar = (m) => vs.postMessage(m);
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const botaoIcone = (icone, titulo, onclick, cls = "") => h("button", { class: "ic " + cls, title: titulo, "aria-label": titulo, onclick }, I(icone, 16));

  // ── markdown mínimo: blocos de código, listas, títulos, código inline, negrito ──
  function inline(texto, p) {
    for (const pedaco of texto.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
      if (pedaco.length > 1 && pedaco.startsWith("`") && pedaco.endsWith("`")) p.append(h("code", {}, pedaco.slice(1, -1)));
      else if (pedaco.startsWith("**") && pedaco.endsWith("**") && pedaco.length > 4) p.append(h("strong", {}, pedaco.slice(2, -2)));
      else if (pedaco) p.append(pedaco);
    }
    return p;
  }
  function md(texto) {
    const frag = document.createDocumentFragment();
    const partes = String(texto).split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
    for (let i = 0; i < partes.length; i += 3) {
      for (const par of partes[i].split(/\n{2,}/)) {
        if (!par.trim()) continue;
        const linhas = par.split("\n");
        if (linhas.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
          const ol = /^\s*\d+\./.test(linhas[0]);
          frag.append(h(ol ? "ol" : "ul", {}, ...linhas.map((l) => inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""), h("li")))));
        } else if (/^#{1,4}\s/.test(par)) frag.append(inline(par.replace(/^#+\s/, ""), h("h4")));
        else frag.append(inline(par, h("p")));
      }
      if (i + 2 < partes.length) {
        const codigo = partes[i + 2];
        const pre = h("pre", {}, h("code", {}, codigo));
        const copiar = botaoIcone("copy", "Copiar", () => enviar({ tipo: "copiar", texto: codigo }), "copiar");
        frag.append(h("div", { class: "bloco" }, partes[i + 1] ? h("span", { class: "lang" }, partes[i + 1]) : null, copiar, pre));
      }
    }
    return frag;
  }

  // ── esqueleto ──
  const bola = h("div", { class: "bola", role: "meter", "aria-label": "Contexto usado" });
  bola.innerHTML =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><clipPath id="cl"><circle cx="24" cy="24" r="19.5"/></clipPath>' +
    '<radialGradient id="brilho" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
    '<circle class="vidro" cx="24" cy="24" r="21"/>' +
    '<g clip-path="url(#cl)"><g class="liquido"><path class="onda tras" d="M-48 2 q6 -3 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 V70 H-48 Z"/>' +
    '<path class="onda" d="M-48 0 q6 -3.5 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 V70 H-48 Z"/></g></g>' +
    '<circle cx="24" cy="24" r="21" fill="url(#brilho)"/><circle class="aro" cx="24" cy="24" r="21"/></svg><span class="pct">0%</span>';

  // conversa: botão com o mesmo menu próprio (o <select> nativo destoava)
  const selSessao = h("button", { class: "sessao", "aria-haspopup": "listbox", "aria-label": "Conversa", onclick: () => abrirMenu("sessao") });
  const ponto = h("button", { class: "ponto", onclick: () => enviar({ tipo: "reconectar" }) });
  const pastaEl = h("span", { class: "pasta" });
  const ctxEl = h("span", { class: "ctxnum" });
  // uso da cota (janela de 5 h) do modelo atual; clicar abre o menu de modelos com o detalhe
  const usoEl = h("button", { class: "usopill", hidden: true, onclick: () => abrirMenu("modelo") });
  const topo = h("header", {},
    bola,
    h("div", { class: "meio" }, selSessao, h("div", { class: "sub" }, ponto, I("folder", 12), pastaEl, h("span", { class: "sep" }, "·"), ctxEl, usoEl)),
    h("div", { class: "botoes" },
      botaoIcone("users", "Montar agentes", () => enviar({ tipo: "agentes" })),
      botaoIcone("gear", "Configurações", () => enviar({ tipo: "config" })),
      botaoIcone("phone", "Parear dispositivo (/pair)", () => enviar({ tipo: "pair" })),
      botaoIcone("plus", "Nova conversa", () => enviar({ tipo: "nova" }))),
  );
  const pairBox = h("div", { class: "pair", hidden: true });
  const aviso = h("div", { class: "aviso", role: "status", hidden: true });
  const lista = h("main", { class: "lista", "aria-live": "polite" });
  const pend = h("section", { class: "pend" });
  const sugest = h("div", { class: "sugest", role: "listbox", hidden: true });
  const texto = h("textarea", { rows: "1", placeholder: "Pergunte ou peça algo…  ( / comandos · ! terminal )", "aria-label": "Mensagem" });
  // agente e modelo: botões com menu próprio (o <select> nativo cortava e encolhia)
  const chipAgente = h("button", { class: "chip", "aria-haspopup": "listbox", onclick: () => abrirMenu("agente") });
  const chipModelo = h("button", { class: "chip", "aria-haspopup": "listbox", onclick: () => abrirMenu("modelo") });
  const menu = h("div", { class: "menu", role: "listbox", hidden: true });
  const botao = h("button", { class: "enviar", onclick: () => (E.rodando ? enviar({ tipo: "interromper" }) : mandar()) });

  const MODOS = [
    { id: "perguntar", icone: "shield", nome: "Perguntar", dica: "Pede confirmação para editar, rodar comandos e acessar a web. Leituras seguem livres." },
    { id: "edicoes", icone: "pencil", nome: "Editar livre", dica: "Edita arquivos do projeto sem perguntar; comandos e web ainda pedem confirmação." },
    { id: "auto", icone: "zap", nome: "Automático", dica: "Faz tudo sem perguntar. Só pede confirmação para mexer fora da pasta do projeto." },
  ];
  const modosEl = h("div", { class: "modos", role: "radiogroup", "aria-label": "Permissões" });

  // anexos da próxima mensagem: arquivos escolhidos no clipe e textos colados grandes (viram .txt)
  let anexos = [];
  let colados = 0;
  const anexosEl = h("div", { class: "anexos", hidden: true });
  function desenharAnexos() {
    anexosEl.hidden = !anexos.length;
    anexosEl.replaceChildren(...anexos.map((a, i) => h("span", { class: "anexo" + (a.modo === "caminho" ? " caminho" : ""), title: a.modo === "caminho" ? "Vai pelo caminho no texto (" + (a.motivo || "") + "): " + (a.caminho || "") : a.caminho || a.nome },
      I(a.modo === "caminho" ? "folder" : "file", 12), h("span", { class: "nm" }, a.nome),
      a.modo === "caminho" ? h("small", {}, "caminho") : a.tamanho ? h("small", {}, a.tamanho > 1024 ? Math.round(a.tamanho / 1024) + " KB" : a.tamanho + " B") : null,
      h("button", { class: "tira", title: "Remover", "aria-label": "Remover " + a.nome, onclick: () => ((anexos = anexos.filter((_, j) => j !== i)), desenharAnexos()) }, I("x", 11)))));
  }
  const paraBase64 = (t) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  // base64 em pedaços: String.fromCharCode(...bytes) estoura a pilha em arquivo grande
  function bytesBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const LIMITE_COLAR = 8 * 1024 * 1024;
  let prints = 0;
  /** Ctrl+V de arquivos copiados no Explorer ou de um print: o host grava e decide (arquivo ou caminho). */
  async function colarArquivos(files) {
    const itens = [];
    const grandes = [];
    for (const f of files) {
      if (f.size > LIMITE_COLAR) {
        grandes.push(f.name || "arquivo");
        continue;
      }
      const nome = f.name && f.name !== "image.png" ? f.name : "print-" + ++prints + "." + ((f.type.split("/")[1] || "png").replace("jpeg", "jpg"));
      itens.push({ nome, b64: bytesBase64(new Uint8Array(await f.arrayBuffer())) });
    }
    if (itens.length) enviar({ tipo: "colarArquivos", itens });
    if (grandes.length) mostrarAviso("Grande demais para colar (mais de 8 MB): " + grandes.join(", ") + ". Use o clipe, que anexa pelo caminho.", "info");
  }
  // Ctrl+V de arquivos: primeiro só os nomes; o host lê os caminhos reais do Windows (Ctrl+C no Explorer)
  // e só pede o conteúdo do que não tem caminho (um print, por exemplo)
  let pendentes = [];
  texto.addEventListener("paste", (e) => {
    const arquivos = [...(e.clipboardData?.files || [])];
    if (arquivos.length) {
      e.preventDefault();
      pendentes = arquivos;
      enviar({ tipo: "colar", nomes: arquivos.map((f) => f.name || "") });
      return;
    }
    const t = e.clipboardData?.getData("text/plain") || "";
    // mesmo critério do chat do Digitama: mais de 2 linhas (ou muito longo) vira um .txt anexado
    if (t.split(/\r?\n/).length <= 2 && t.length <= 1500) return;
    e.preventDefault();
    colados += 1;
    let b64;
    try { b64 = paraBase64(t); } catch { b64 = btoa(unescape(encodeURIComponent(t))); }
    anexos.push({ nome: "colado-" + colados + ".txt", modo: "arquivo", uri: "data:text/plain;charset=utf-8;base64," + b64, tamanho: new TextEncoder().encode(t).length });
    desenharAnexos();
  });

  const caixa = h("div", { class: "caixa" },
    anexosEl,
    texto,
    h("div", { class: "linha" },
      h("button", { class: "ic barra", title: "Anexar arquivos", "aria-label": "Anexar arquivos", onclick: () => enviar({ tipo: "anexar" }) }, I("paperclip", 15)),
      h("button", { class: "ic barra", title: "Comandos ( / )", "aria-label": "Comandos", onclick: () => { texto.value = "/"; texto.focus(); texto.dispatchEvent(new Event("input")); } }, I("slash", 15)),
      chipAgente,
      chipModelo,
      h("span", { class: "flex" }),
      botao));
  const compor = h("footer", {}, sugest, menu, caixa, modosEl);
  app.append(topo, pairBox, aviso, lista, pend, compor);

  function autoAltura() {
    texto.style.height = "auto";
    texto.style.height = Math.min(texto.scrollHeight, 200) + "px";
  }
  function mandar() {
    const t = texto.value.trim();
    if (!t && !anexos.length) return;
    texto.value = "";
    autoAltura();
    sugest.hidden = true;
    enviar({ tipo: "enviar", texto: t, anexos });
    anexos = [];
    desenharAnexos();
  }
  texto.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const primeira = !sugest.hidden && sugest.querySelector("button");
      if (primeira && !texto.value.includes(" ")) primeira.click();
      else mandar();
    } else if (e.key === "Escape") sugest.hidden = true;
  });
  texto.addEventListener("input", () => {
    autoAltura();
    const v = texto.value;
    if (!v.startsWith("/") || v.includes(" ")) return (sugest.hidden = true);
    const q = v.slice(1).toLowerCase();
    const todos = [
      ...(E.locais || []).map((c) => ({ nome: c.nome, desc: c.descricao, icone: c.icone, args: c.args, apelidos: c.apelidos })),
      ...E.comandos.map((c) => ({ nome: c.name, desc: c.description, icone: "tool", args: "", apelidos: [], servidor: true })),
      ...(E.skills || []).map((k) => ({ nome: "skill " + k.id, desc: k.description, icone: "sparkle", args: "<mensagem>", apelidos: [] })),
    ];
    const achados = todos.filter((c) => c.nome.startsWith(q) || c.apelidos.some((a) => a.startsWith(q))).slice(0, 12);
    sugest.replaceChildren(...achados.map((c) => h("button", { role: "option", onclick: () => {
      texto.value = "/" + c.nome + " ";
      sugest.hidden = true;
      texto.focus();
      if (!c.args && !c.servidor) mandar();
    } }, I(c.icone, 14), h("b", {}, "/" + c.nome), c.args ? h("i", {}, c.args) : null, c.desc ? h("span", {}, c.desc) : null, c.servidor ? h("em", {}, "OpenCode") : null)));
    sugest.hidden = !achados.length;
  });

  // ── menus de agente, modelo e conversa ──
  let menuQual = null;
  function modeloAtual() {
    return E.modelo && E.modelos.find((x) => x.providerID === E.modelo.providerID && x.id === E.modelo.id);
  }
  const usoDe = (m) => (m && E.uso ? E.uso[m.providerID + "/" + m.id] : undefined);
  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  function tagUso(m) {
    const u = usoDe(m);
    if (u?.esgotadoAte) return h("span", { class: "tag esgotado", title: (u.cota.endsWith(":gratis") ? "Cota grátis compartilhada esgotada" : "Recusou por limite") + "; libera por volta das " + hora(u.esgotadoAte) }, "esgotado até " + hora(u.esgotadoAte));
    return m.gratis ? h("span", { class: "tag gratis" }, "grátis") : null;
  }
  /** "5 h: 120k de ~300k" com barrinha; sem limite aprendido, só o usado. */
  function barraUso(m) {
    const u = usoDe(m);
    if (!u || (!u.usado && !u.limite)) return null;
    const comp = u.cota && u.cota.endsWith(":gratis");
    const txt = (comp ? "cota grátis 5 h: " : "últimas 5 h: ") + fmt(u.usado) + (u.limite ? " de ~" + fmt(u.limite) : "") + (comp && u.usadoModelo ? " · este: " + fmt(u.usadoModelo) : "");
    return h("span", { class: "uso", "data-faixa": u.pct >= 90 ? "alta" : u.pct >= 70 ? "media" : "baixa", title: u.limite ? "Limite aprendido da última recusa por cota" : "O limite aparece depois da primeira recusa por cota" },
      u.limite ? h("span", { class: "barra" }, h("span", { style: "width:" + u.pct + "%" })) : null, txt);
  }
  function capsDe(m, tam) {
    return (m?.entrada || []).filter((c) => CAPACIDADES[c]).map((c) => h("span", { class: "cap", title: CAPACIDADES[c].rotulo }, I(CAPACIDADES[c].icone, tam)));
  }
  function abrirMenu(qual) {
    if (!menu.hidden && menuQual === qual) return fecharMenu();
    menuQual = qual;
    sugest.hidden = true;
    // o de conversa abre embaixo do topo; agente e modelo, em cima da caixa de mensagem
    const casa = qual === "sessao" ? topo : compor;
    if (menu.parentElement !== casa) casa.append(menu);
    menu.classList.toggle("topo", qual === "sessao");
    menu.hidden = false;
    selSessao.setAttribute("aria-expanded", String(qual === "sessao"));
    chipAgente.setAttribute("aria-expanded", String(qual === "agente"));
    chipModelo.setAttribute("aria-expanded", String(qual === "modelo"));
    desenharMenu();
    (menu.querySelector(".item.atual") || menu.querySelector(".item"))?.focus();
  }
  function fecharMenu() {
    menu.hidden = true;
    exclusao.selecionando = false;
    exclusao.marcadas.clear();
    exclusao.confirmar = null;
    menuQual = null;
    selSessao.setAttribute("aria-expanded", "false");
    chipAgente.setAttribute("aria-expanded", "false");
    chipModelo.setAttribute("aria-expanded", "false");
  }
  function item(atual, onclick, ...filhos) {
    return h("button", { class: "item" + (atual ? " atual" : ""), role: "option", "aria-selected": String(!!atual), onclick: () => (onclick(), fecharMenu()) }, ...filhos);
  }
  function desenharMenu() {
    const cab = (t) => h("div", { class: "cab" }, t);
    if (menuQual === "agente") {
      const prim = E.agentes.filter((a) => a.mode !== "subagent");
      menu.replaceChildren(cab("Agente"), ...prim.map((a) => item(a.id === E.agente, () => enviar({ tipo: "agente", id: a.id }),
        h("span", { class: "cor", style: a.color ? "background:" + a.color : "" }),
        h("span", { class: "txt" }, h("b", {}, a.name), a.description ? h("small", {}, a.description) : null),
        a.model ? h("span", { class: "tag" }, E.modelos.find((m) => m.id === a.model.id)?.name || a.model.id) : null)),
        h("button", { class: "item mais", onclick: () => (enviar({ tipo: "agentes" }), fecharMenu()) }, I("users", 14), "Montar agentes…"));
    } else if (menuQual === "modelo") {
      menuModelos();
    } else if (menuQual === "sessao") {
      menu.replaceChildren(...menuSessoes());
    }
  }

  // ── menu de modelos: busca + seções por provedor (recolhíveis), filtro "só grátis" ──
  // secoes: provedor → aberto (true) ou fechado (false) pelo seu clique; sem clique, vale o padrão
  const filtroModelo = Object.assign({ busca: "", soGratis: false, secoes: {} }, (vs.getState() || {}).filtroModelo);
  if (!filtroModelo.secoes || typeof filtroModelo.secoes !== "object") filtroModelo.secoes = {};
  const guardarFiltro = () => vs.setState({ ...(vs.getState() || {}), filtroModelo: { soGratis: filtroModelo.soGratis, secoes: filtroModelo.secoes } });
  const nomeProvedor = (id) => (E.provedores || {})[id] || id.replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
  let barraModelos, listaModelos, buscaModelos, botaoGratis;
  function menuModelos() {
    // a barra (com a busca) é criada uma vez: redesenhos só trocam a lista, e o foco fica onde está
    if (!barraModelos) {
      buscaModelos = h("input", { type: "text", class: "busca", placeholder: "Buscar modelo ou provedor…", "aria-label": "Buscar modelo", oninput: (e) => ((filtroModelo.busca = e.target.value), desenharListaModelos()),
        onkeydown: (e) => {
          if (e.key === "Enter") listaModelos.querySelector(".item")?.click(); // ↑↓ ficam com o teclado do menu
        } });
      botaoGratis = h("button", { class: "filtro-gratis", role: "switch", onclick: () => {
        filtroModelo.soGratis = !filtroModelo.soGratis;
        guardarFiltro();
        desenharListaModelos();
      } }, "só grátis");
      barraModelos = h("div", { class: "barra-modelos" }, h("span", { class: "lupa" }, I("search", 13)), buscaModelos, botaoGratis);
      listaModelos = h("div", { class: "lista-modelos" });
    }
    if (menu.firstChild !== barraModelos) {
      menu.replaceChildren(barraModelos, listaModelos);
      filtroModelo.busca = "";
      buscaModelos.value = "";
      setTimeout(() => buscaModelos.focus(), 0);
    }
    desenharListaModelos();
  }

  function desenharListaModelos() {
    const atual = modeloAtual();
    const q = filtroModelo.busca.trim().toLowerCase();
    botaoGratis.classList.toggle("ativo", filtroModelo.soGratis);
    botaoGratis.setAttribute("aria-checked", String(filtroModelo.soGratis));
    const visiveis = E.modelos.filter((m) => (!filtroModelo.soGratis || m.gratis) &&
      (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || nomeProvedor(m.providerID).toLowerCase().includes(q)));
    // agrupa por provedor: o do modelo atual primeiro, depois quem tem grátis, depois por nome
    const grupos = new Map();
    for (const m of visiveis) (grupos.get(m.providerID) || grupos.set(m.providerID, []).get(m.providerID)).push(m);
    const ordem = [...grupos.keys()].sort((a, b) =>
      (b === atual?.providerID) - (a === atual?.providerID) ||
      grupos.get(b).some((m) => m.gratis) - grupos.get(a).some((m) => m.gratis) ||
      nomeProvedor(a).localeCompare(nomeProvedor(b)));
    const unico = ordem.length === 1;
    const secoes = ordem.map((p) => {
      const ms = grupos.get(p).sort((a, b) => b.gratis - a.gratis || a.name.localeCompare(b.name));
      // buscando: tudo aberto. Senão o seu clique manda; sem clique, abre o do modelo atual (ou o único)
      const padrao = unico || p === atual?.providerID;
      const aberto = !!q || (p in filtroModelo.secoes ? filtroModelo.secoes[p] : padrao);
      const nGratis = ms.filter((m) => m.gratis).length;
      const cabecalho = h("button", { class: "grupo-prov" + (aberto ? " aberto" : ""), "aria-expanded": String(aberto), title: aberto ? "Recolher" : "Mostrar modelos", onclick: (e) => {
        e.stopPropagation();
        if (q) return; // durante a busca as seções ficam abertas
        filtroModelo.secoes[p] = !aberto;
        guardarFiltro();
        desenharListaModelos();
      } }, I("chevron", 12), h("b", {}, nomeProvedor(p)), h("span", { class: "conta" }, ms.length), nGratis ? h("span", { class: "tag gratis" }, nGratis + " grátis") : null);
      const itens = aberto ? ms.map((m) => item(m === atual, () => enviar({ tipo: "modelo", providerID: m.providerID, id: m.id }),
        I("brain", 14),
        h("span", { class: "txt" }, h("b", {}, m.name), h("small", {}, fmt(m.contexto) + " de contexto" + (m.variantes.length ? " · raciocínio ajustável" : "") + (m.ferramentas ? "" : " · sem ferramentas")), barraUso(m)),
        ...capsDe(m, 13), tagUso(m))) : [];
      return h("div", { class: "secao-prov" }, cabecalho, ...itens);
    });
    listaModelos.replaceChildren(...(secoes.length ? secoes : [h("p", { class: "nada" }, q ? `Nenhum modelo com "${filtroModelo.busca}".` : "Nenhum modelo grátis.")]));
  }

  // ── excluir conversas: uma pela lixeira, ou várias no modo seleção; sempre com confirmação ──
  const exclusao = { selecionando: false, marcadas: new Set(), confirmar: null }; // confirmar: id | "varias"
  function menuSessoes() {
    const data = (s) => (s.updated ? new Date(s.updated).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
    const titulo = (s) => s.title || "Conversa de " + data(s);
    const redesenhar = () => menu.replaceChildren(...menuSessoes());
    const parar = (e) => e.stopPropagation();
    const cabecalho = h("div", { class: "cab linha-cab" }, h("span", {}, "Conversas desta pasta"), h("span", { class: "flex" }),
      E.sessoes.length ? h("button", { class: "link", onclick: (e) => {
        parar(e);
        exclusao.selecionando = !exclusao.selecionando;
        exclusao.marcadas.clear();
        exclusao.confirmar = null;
        redesenhar();
      } }, exclusao.selecionando ? "Cancelar" : "Selecionar") : null);

    const linhas = E.sessoes.map((s) => {
      if (exclusao.confirmar === s.id) {
        return h("div", { class: "item confirma" }, I("trash", 14), h("span", { class: "txt" }, h("b", {}, "Excluir “" + titulo(s) + "”?"), h("small", {}, "Não dá para desfazer.")),
          h("button", { class: "neg pequeno", onclick: (e) => (parar(e), (exclusao.confirmar = null), redesenhar()) }, "Não"),
          h("button", { class: "perigo pequeno", onclick: (e) => (parar(e), (exclusao.confirmar = null), enviar({ tipo: "excluir", ids: [s.id] })) }, "Excluir"));
      }
      if (exclusao.selecionando) {
        const marcada = exclusao.marcadas.has(s.id);
        return h("button", { class: "item" + (marcada ? " marcada" : ""), role: "checkbox", "aria-checked": String(marcada), onclick: (e) => {
          parar(e);
          marcada ? exclusao.marcadas.delete(s.id) : exclusao.marcadas.add(s.id);
          exclusao.confirmar = null;
          redesenhar();
        } }, h("span", { class: "caixinha" }, I("check", 11)), h("span", { class: "txt" }, h("b", {}, titulo(s)), h("small", {}, data(s))));
      }
      return h("div", { class: "item-linha" + (s.id === E.atual ? " atual" : "") },
        item(s.id === E.atual, () => enviar({ tipo: "abrir", id: s.id }), I("folder", 14), h("span", { class: "txt" }, h("b", {}, titulo(s)), h("small", {}, data(s)))),
        h("button", { class: "ic lixo", title: "Excluir conversa", "aria-label": "Excluir " + titulo(s), onclick: (e) => (parar(e), (exclusao.confirmar = s.id), redesenhar()) }, I("trash", 14)));
    });

    const rodape = [];
    if (exclusao.selecionando) {
      const n = exclusao.marcadas.size;
      const todas = n === E.sessoes.length;
      rodape.push(h("div", { class: "rodape-menu" },
        h("button", { class: "link", onclick: (e) => {
          parar(e);
          todas ? exclusao.marcadas.clear() : E.sessoes.forEach((s) => exclusao.marcadas.add(s.id));
          redesenhar();
        } }, todas ? "Desmarcar todas" : "Marcar todas"),
        h("span", { class: "flex" }),
        exclusao.confirmar === "varias"
          ? [h("span", { class: "aviso-inline" }, `Excluir ${n}? Não dá para desfazer.`),
             h("button", { class: "neg pequeno", onclick: (e) => (parar(e), (exclusao.confirmar = null), redesenhar()) }, "Não"),
             h("button", { class: "perigo pequeno", onclick: (e) => {
               parar(e);
               const ids = [...exclusao.marcadas];
               exclusao.selecionando = false;
               exclusao.marcadas.clear();
               exclusao.confirmar = null;
               enviar({ tipo: "excluir", ids });
             } }, "Excluir")]
          : h("button", { class: "perigo pequeno", disabled: !n || undefined, onclick: (e) => (parar(e), (exclusao.confirmar = "varias"), redesenhar()) }, I("trash", 13), n ? `Excluir ${n}` : "Excluir")));
    }
    return [cabecalho, exclusao.selecionando ? null : item(!E.atual, () => enviar({ tipo: "nova" }), I("plus", 14), h("span", { class: "txt" }, h("b", {}, "Nova conversa"))), ...linhas, ...rodape].filter(Boolean);
  }
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest?.(".chip, .sessao")) fecharMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) fecharMenu();
    if (!menu.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const itens = [...menu.querySelectorAll(".item")];
      const i = itens.indexOf(document.activeElement);
      itens[(i + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length]?.focus();
      e.preventDefault();
    }
  });

  function ajuda() {
    lista.querySelector(".vazio")?.remove();
    const linha = (nome, desc, icone, args) => h("div", { class: "cmd" }, I(icone, 14), h("b", {}, nome), args ? h("i", {}, args) : null, h("span", {}, desc));
    lista.append(h("article", { class: "msg bot ajuda" },
      h("div", { class: "quem" }, h("span", { class: "avatar" }, I("question", 12)), "comandos"),
      ...(E.locais || []).map((c) => linha("/" + c.nome, c.descricao + (c.apelidos.length ? " (" + c.apelidos.map((a) => "/" + a).join(", ") + ")" : ""), c.icone, c.args)),
      ...E.comandos.map((c) => linha("/" + c.name, (c.description || "") + " — do OpenCode", "tool")),
      linha("!comando", "Roda no terminal da conversa (ex.: !git status)", "terminal")));
    rolar();
  }

  function desenharUsoTopo() {
    const u = usoDe(modeloAtual());
    usoEl.hidden = !u || (!u.usado && !u.esgotadoAte);
    if (usoEl.hidden) return;
    const comp = u.cota && u.cota.endsWith(":gratis");
    usoEl.dataset.faixa = u.esgotadoAte ? "esgotado" : u.pct >= 90 ? "alta" : u.pct >= 70 ? "media" : "baixa";
    usoEl.replaceChildren(I("zap", 11), u.esgotadoAte ? "esgotado até " + hora(u.esgotadoAte) : (comp ? "cota " : "5 h ") + fmt(u.usado) + (u.limite ? "/~" + fmt(u.limite) : ""));
    usoEl.title = (comp ? "Cota grátis compartilhada (todos os modelos grátis do provedor), janela de 5 h" : "Uso deste modelo nas últimas 5 h") + (u.limite ? "" : ". O limite aparece depois da primeira recusa por cota.") + " Clique para ver por modelo.";
  }

  // tema vindo das Configurações: cor de destaque, densidade e animações
  function aplicarTema(t) {
    if (!t) return;
    const raiz = document.documentElement.style;
    raiz.setProperty("--ciano", t.acento);
    raiz.setProperty("--acento", t.acento);
    document.body.dataset.densidade = t.densidade;
    document.body.classList.toggle("sem-animacao", !t.animacoes);
  }

  // ── estado ──
  function desenharEstado() {
    const { usado, limite } = E.ctx;
    const pct = limite ? Math.min(100, (usado / limite) * 100) : 0;
    bola.dataset.faixa = pct >= 85 ? "alta" : pct >= 60 ? "media" : "baixa";
    bola.querySelector(".pct").textContent = Math.round(pct) + "%";
    bola.querySelector(".liquido").setAttribute("transform", `translate(0 ${45 - (pct / 100) * 42})`);
    bola.setAttribute("aria-valuenow", String(Math.round(pct)));
    bola.title = limite ? `Contexto: ${usado.toLocaleString("pt-BR")} de ${limite.toLocaleString("pt-BR")} tokens` : "Contexto";
    ctxEl.textContent = limite ? `${fmt(usado)} / ${fmt(limite)}` : "—";
    desenharUsoTopo();

    ponto.dataset.ok = E.conectado ? "1" : "0";
    ponto.title = E.conectado ? "Conectado ao serviço do OpenCode" : "Sem conexão — clique para reconectar";
    pastaEl.textContent = E.pasta ? E.pasta.split(/[\\/]/).pop() : "nenhuma pasta aberta";

    const data = (s) => (s.updated ? new Date(s.updated).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
    const sAtual = E.sessoes.find((s) => s.id === E.atual);
    selSessao.replaceChildren(h("span", { class: "rot" }, !E.atual ? "Nova conversa" : sAtual?.title || "Conversa de " + data(sAtual || {})), I("chevron", 13));
    const ag = E.agentes.find((a) => a.id === E.agente);
    chipAgente.replaceChildren(h("span", { class: "cor", style: ag?.color ? "background:" + ag.color : "" }), h("span", { class: "rot" }, ag?.name || E.agente || "agente"), I("chevron", 12));
    chipAgente.title = "Agente: " + (ag?.description || ag?.name || "");
    const m = modeloAtual();
    chipModelo.replaceChildren(I("brain", 13), h("span", { class: "rot" }, m?.name || "modelo padrão"), ...capsDe(m, 12), I("chevron", 12));
    chipModelo.title = "Modelo: " + (m ? m.name + " · " + fmt(m.contexto) + " de contexto" : "padrão");
    const um = usoDe(m);
    chipModelo.dataset.uso = um?.esgotadoAte ? "esgotado" : um?.pct >= 80 ? "perto" : "";
    if (um?.esgotadoAte) chipModelo.title += " · esgotado até " + hora(um.esgotadoAte);
    else if (um?.limite) chipModelo.title += " · 5 h: " + fmt(um.usado) + " de ~" + fmt(um.limite);
    if (!menu.hidden) desenharMenu();

    botao.replaceChildren(I(E.rodando ? "stop" : "send", 15));
    botao.title = E.rodando ? "Parar" : "Enviar (Enter)";
    botao.classList.toggle("parar", !!E.rodando);
    app.classList.toggle("rodando", !!E.rodando);

    modosEl.replaceChildren(...MODOS.map((md) => h("button", {
      role: "radio", "aria-checked": String(E.modo === md.id), class: "modo" + (E.modo === md.id ? " ativo" : ""), "data-modo": md.id, title: md.dica,
      onclick: () => enviar({ tipo: "modo", modo: md.id }),
    }, I(md.icone, 13), md.nome)));
  }

  // ── mensagens ──
  const rolar = () => requestAnimationFrame(() => (lista.scrollTop = lista.scrollHeight));
  const pertoDoFim = () => lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80;

  const NOMES_TOOL = { read: "Ler", edit: "Editar", write: "Escrever", patch: "Aplicar patch", shell: "Terminal", bash: "Terminal", glob: "Procurar arquivos", grep: "Buscar texto", webfetch: "Abrir página", websearch: "Pesquisar na web", question: "Pergunta", subagent: "Subagente", task: "Subagente", todowrite: "Tarefas", skill: "Skill" };
  const ICONE_TOOL = { read: "file", edit: "pencil", write: "pencil", patch: "pencil", shell: "terminal", bash: "terminal", glob: "search", grep: "search", webfetch: "globe", websearch: "globe", question: "question", subagent: "users", task: "users" };

  function blocoUsuario(t, lista) {
    const el = h("article", { class: "msg user" }, md(t));
    if (lista?.length) el.prepend(h("div", { class: "anexos-msg" }, ...lista.map((a) => h("span", { class: "anexo" + (a.modo === "caminho" ? " caminho" : "") }, I(a.modo === "caminho" ? "folder" : "file", 11), a.nome))));
    return el;
  }
  function resumo(input) {
    if (typeof input !== "object" || !input) return String(input ?? "");
    const v = input.command ?? input.path ?? input.filePath ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.agent ?? Object.values(input)[0];
    return String(typeof v === "object" ? JSON.stringify(v) : v ?? "").replace(/\s+/g, " ").slice(0, 140);
  }
  function toolEl(t) {
    const el = h("details", { class: "tool", "data-st": t.state?.status || "streaming" },
      h("summary", {}, h("span", { class: "st" }), I(ICONE_TOOL[t.name] || "tool", 13), h("span", { class: "nome" }, NOMES_TOOL[t.name] || t.name || "ferramenta"), h("span", { class: "arg" })));
    preencherTool(el, t.state);
    return el;
  }
  function preencherTool(el, state) {
    if (!state) return;
    el.dataset.st = state.status || el.dataset.st;
    if (state.input) el.querySelector(".arg").textContent = resumo(state.input);
    const saida = state.error?.message || (state.content || []).map((c) => c.text || "").join("\n");
    if (saida) {
      el.querySelector("pre")?.remove();
      el.append(h("pre", {}, saida.length > 4000 ? saida.slice(0, 4000) + "\n…" : saida));
    }
  }
  // Raciocínio: fechado por padrão e SEM despejar texto na tela enquanto o modelo
  // pensa. Rodando, o cabeçalho vira um indicador animado (ondas + pulso); o texto
  // só entra no DOM quando o usuário abre o bloco ou quando o raciocínio termina.
  function escreverPensa(el) {
    if (el._corpo.textContent !== el._txt) el._corpo.textContent = el._txt || "";
  }
  function pensaEl(txt, corrida) {
    const rotulo = h("span", { class: "rotulo" }, corrida ? "Raciocinando" : "Raciocínio");
    const corpo = h("div", { class: "corpo" });
    const ondas = h("span", { class: "ondas", "aria-hidden": "true" }, h("i"), h("i"), h("i"));
    const el = h("details", { class: "pensa" },
      h("summary", {}, I("brain", 12), rotulo, corrida ? ondas : null),
      corpo);
    el._txt = txt || "";
    el._corpo = corpo;
    el._rotulo = rotulo;
    el._ondas = corrida ? ondas : null;
    if (corrida) el.dataset.correndo = "true";
    // Ao abrir, o texto é montado uma única vez (e mantido em dia se ainda correr).
    el.addEventListener("toggle", () => {
      if (el.open) escreverPensa(el);
    });
    if (txt) escreverPensa(el);
    return el;
  }
  function terminarPensa(el) {
    delete el.dataset.correndo;
    el._rotulo.textContent = "Raciocínio";
    el._ondas?.remove();
    el._ondas = null;
    escreverPensa(el);
    // Não mexe no `open`: fecha só se ninguém abriu (fica fechado como nasceu).
    // O evento `toggle` é assíncrono, então não dá para confiar nele para saber
    // se o usuário abriu — ler `el.open` aqui é o único sinal confiável.
  }
  function cabecalhoBot(agente, modelo) {
    const copiar = h("button", { class: "ic copiar-msg", title: "Copiar resposta", "aria-label": "Copiar resposta", onclick: (e) => {
      const msg = e.currentTarget.closest(".msg");
      const partes = [...msg.querySelectorAll(":scope > .texto")].map((p) => p._txt ?? p.innerText).filter(Boolean);
      enviar({ tipo: "copiar", texto: partes.join("\n\n") || msg.innerText });
    } }, I("copy", 13));
    return h("div", { class: "quem" }, h("span", { class: "avatar" }, I("egg", 12)), agente || "opencode", modelo ? h("span", { class: "mod" }, modelo) : null, h("span", { class: "flex" }), copiar);
  }
  function nomeModelo(ref) {
    if (!ref) return "";
    return E.modelos.find((m) => m.id === ref.id && m.providerID === ref.providerID)?.name || ref.id;
  }
  function blocoAssistente(m) {
    const el = h("article", { class: "msg bot" }, cabecalhoBot(m.agent, nomeModelo(m.model)));
    for (const c of m.content || []) {
      if (c.type === "text" && c.text) {
        const t = h("div", { class: "texto" }, md(c.text));
        t._txt = c.text; // o markdown original, para o botão de copiar
        el.append(t);
      }
      else if (c.type === "reasoning" && c.text) el.append(pensaEl(c.text));
      else if (c.type === "tool") el.append(toolEl(c));
    }
    return el;
  }

  function vazio() {
    const ideias = ["Explique a estrutura deste projeto", "Revise as mudanças não commitadas", "Escreva testes para o arquivo aberto"];
    return h("div", { class: "vazio" },
      h("div", { class: "ovo" }, I("egg", 40)),
      h("h3", {}, "Pronto para começar"),
      h("p", {}, "O OpenCode trabalha na pasta aberta. Escolha o agente e o modelo abaixo; a bola no topo mostra quanto do contexto já foi usado."),
      h("div", { class: "ideias" }, ...ideias.map((t) => h("button", { class: "ideia", onclick: () => { texto.value = t; autoAltura(); texto.focus(); } }, t))));
  }

  function desenharHistorico(msgs) {
    vivos.clear();
    lista.replaceChildren();
    // agrupa passos seguidos do mesmo agente numa resposta só
    let ultimoBot = null;
    for (const m of msgs) {
      if (m.type === "assistant") {
        const bloco = blocoAssistente(m);
        if (ultimoBot && ultimoBot.dataset.agente === (m.agent || "")) {
          bloco.querySelector(".quem").remove();
          ultimoBot.append(...bloco.childNodes);
        } else {
          bloco.dataset.agente = m.agent || "";
          lista.append(bloco);
          ultimoBot = bloco;
        }
        continue;
      }
      ultimoBot = null;
      if (m.type === "user") lista.append(blocoUsuario(m.text ?? m.payload?.text ?? ""));
      else if (m.type === "compaction") lista.append(h("div", { class: "divisa" }, I("compress", 12), "conversa compactada"));
      else if (m.type === "shell") lista.append(h("article", { class: "msg bot" }, h("pre", {}, "$ " + (m.command ?? ""))));
      else if (m.type === "idle" && m.outcome && m.outcome !== "succeeded") lista.append(h("div", { class: "divisa erro" }, "parou: " + m.outcome));
    }
    if (!msgs.length) lista.append(vazio());
    rolar();
  }

  function vivo(id, agente, modelo) {
    let v = vivos.get(id);
    if (!v) {
      lista.querySelector(".vazio")?.remove();
      const anterior = lista.lastElementChild;
      if (anterior?.classList.contains("bot") && anterior.dataset.agente === (agente || "")) v = { el: anterior, partes: new Map(), tools: new Map() };
      else {
        const el = h("article", { class: "msg bot" }, cabecalhoBot(agente, nomeModelo(modelo)));
        el.dataset.agente = agente || "";
        lista.append(el);
        v = { el, partes: new Map(), tools: new Map() };
      }
      vivos.set(id, v);
    }
    return v;
  }

  function evento(e) {
    const d = e.data || {};
    const t = e.type;
    const fim = pertoDoFim();
    const id = d.assistantMessageID;
    if (t === "session.step.started" && id) vivo(id, d.agent, d.model);
    else if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(t) && id) {
      const v = vivo(id);
      const chave = t.split(".")[1] + ":" + (d.ordinal ?? 0);
      let p = v.partes.get(chave);
      if (!p) {
        p = t.includes("reasoning") ? pensaEl("", t.endsWith(".started") || t.endsWith(".delta")) : h("div", { class: "texto corrida" });
        p._txt = "";
        v.partes.set(chave, p);
        v.el.append(p);
      }
      if (t.endsWith(".delta")) p._txt += d.delta || "";
      if (t.endsWith(".ended") && typeof d.text === "string") p._txt = d.text;
      if (p.classList.contains("pensa")) {
        // Rodando: só o indicador animado. O texto entra no DOM quando abre ou no fim.
        if (t.endsWith(".ended")) terminarPensa(p);
        else if (p.open) escreverPensa(p);
      } else {
        p.replaceChildren(md(p._txt));
        if (t.endsWith(".ended")) p.classList.remove("corrida");
      }
    } else if (/^session\.tool\./.test(t) && id && d.id) {
      const v = vivo(id);
      let el = v.tools.get(d.id);
      if (!el) {
        el = toolEl({ name: d.name, state: { status: "streaming" } });
        v.tools.set(d.id, el);
        v.el.append(el);
      }
      if (d.name) {
        el.querySelector(".nome").textContent = NOMES_TOOL[d.name] || d.name;
        el.querySelector("svg.icone").replaceWith(I(ICONE_TOOL[d.name] || "tool", 13));
      }
      if (t === "session.tool.called") preencherTool(el, { status: "running", input: d.input });
      else if (/success|completed/.test(t)) preencherTool(el, { status: "completed", content: d.content });
      else if (/fail|error/.test(t)) preencherTool(el, { status: "error", error: d.error || { message: d.message || "erro" } });
    } else if (t === "session.retry" || t === "session.step.retry") mostrarAviso(`Tentando de novo${d.error?.message ? ": " + d.error.message : ""}`);
    else if (t === "session.execution.failed") mostrarAviso(d.error?.message || "A execução falhou.");
    if (fim) rolar();
  }

  // ── pendências: permissões e perguntas ──
  const ACOES = { edit: ["pencil", "Editar arquivo"], shell: ["terminal", "Rodar comando"], webfetch: ["globe", "Abrir página"], websearch: ["globe", "Pesquisar na web"], external_directory: ["folder", "Acessar fora do projeto"], read: ["file", "Ler arquivo"], subagent: ["users", "Chamar subagente"] };

  function diffEl(patch) {
    const linhas = patch.split("\n").filter((l) => !/^(Index:|====|---|\+\+\+)/.test(l));
    return h("pre", { class: "diff" }, ...linhas.map((l) => h("span", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "" }, l + "\n")));
  }

  function permEl(p) {
    const [icone, rotulo] = ACOES[p.action] || ["shield", p.action];
    const arquivos = p.metadata?.files || [];
    return h("div", { class: "cartao perm" },
      h("div", { class: "tit" }, h("span", { class: "selo" }, I(icone, 14)), h("div", {}, h("b", {}, rotulo), h("small", {}, "O OpenCode quer permissão"))),
      p.resources?.length ? h("code", { class: "recurso" }, p.resources.join("\n")) : null,
      p.message ? h("p", {}, p.message) : null,
      ...arquivos.filter((f) => f.patch).slice(0, 3).map((f) => h("details", { class: "arq", open: arquivos.length === 1 },
        h("summary", {}, f.file, h("span", { class: "mais" }, "+" + (f.additions ?? 0)), h("span", { class: "menos" }, "−" + (f.deletions ?? 0))), diffEl(f.patch))),
      h("div", { class: "acoes" },
        h("button", { class: "pri", onclick: () => enviar({ tipo: "permissao", id: p.id, decisao: "once" }) }, I("check", 14), "Permitir"),
        h("button", { class: "sec", title: "Não perguntar de novo para isto nesta sessão", onclick: () => enviar({ tipo: "permissao", id: p.id, decisao: "always" }) }, "Sempre"),
        h("button", { class: "neg", onclick: () => enviar({ tipo: "permissao", id: p.id, decisao: "reject" }) }, I("x", 14), "Negar")));
  }

  function campoVisivel(c, valores) {
    return !c.hidden && (c.when || []).every((w) => (w.op === "eq" ? valores[w.key] === w.value : valores[w.key] !== w.value));
  }

  function formEl(f) {
    if (!respostas.has(f.id)) {
      const ini = {};
      for (const c of f.fields || []) ini[c.key] = c.default ?? (c.type === "multiselect" ? [] : c.type === "boolean" ? false : "");
      respostas.set(f.id, { valores: ini, outro: {} });
    }
    const r = respostas.get(f.id);
    const card = h("div", { class: "cartao form" });
    const responder = h("button", { class: "pri", onclick: () => {
      const answer = {};
      for (const c of f.fields || []) if (campoVisivel(c, r.valores)) answer[c.key] = r.valores[c.key];
      enviar({ tipo: "form", id: f.id, answer });
      card.classList.add("enviado");
    } }, I("check", 14), "Responder");

    const pronto = () => {
      const ok = (f.fields || []).filter((c) => campoVisivel(c, r.valores) && c.type !== "boolean").every((c) => {
        const v = r.valores[c.key];
        return c.required === false || (Array.isArray(v) ? v.length > 0 : v !== "" && v !== undefined);
      });
      responder.disabled = !ok;
    };

    const corpo = h("div", { class: "perguntas" });
    const desenhar = () => {
      corpo.replaceChildren(...(f.fields || []).filter((c) => campoVisivel(c, r.valores)).map((c) => campoEl(c, r, () => { pronto(); }, desenhar)));
      pronto();
    };
    desenhar();
    card.append(
      h("div", { class: "tit" }, h("span", { class: "selo q" }, I("question", 14)), h("div", {}, h("b", {}, f.metadata?.kind === "question" ? "Pergunta do OpenCode" : f.title || "Formulário"), h("small", {}, "Escolha e responda para ele continuar"))),
      corpo,
      h("div", { class: "acoes" }, responder, h("button", { class: "neg", onclick: () => enviar({ tipo: "formCancelar", id: f.id }) }, "Dispensar")));
    return card;
  }

  function campoEl(c, r, mudou, redesenhar) {
    const v = r.valores;
    const cab = h("div", { class: "pergunta" },
      c.title && c.description ? h("span", { class: "etiqueta" }, c.title) : null,
      h("div", { class: "enunciado" }, c.description || c.title || c.key));
    if (c.type === "external") return h("div", { class: "campo" }, cab, h("button", { class: "sec", onclick: () => enviar({ tipo: "navegador", url: c.url }) }, I("external", 14), "Abrir"));
    if (c.type === "boolean") {
      const sw = h("button", { class: "opcao sim-nao" + (v[c.key] ? " marcada" : ""), role: "switch", "aria-checked": String(!!v[c.key]), onclick: () => {
        v[c.key] = !v[c.key];
        redesenhar(); // outros campos podem depender deste (when)
      } }, h("span", { class: "marca" }, I("check", 12)), v[c.key] ? "Sim" : "Não");
      return h("div", { class: "campo" }, cab, sw);
    }
    if (c.options?.length) {
      const multi = c.type === "multiselect";
      const box = h("div", { class: "opcoes" + (multi ? " multi" : "") });
      const selecionado = (o) => (multi ? v[c.key].includes(o.value) : v[c.key] === o.value);
      for (const o of c.options) {
        const b = h("button", { class: "opcao" + (selecionado(o) ? " marcada" : ""), role: multi ? "checkbox" : "radio", "aria-checked": String(selecionado(o)), onclick: () => {
          if (multi) v[c.key] = selecionado(o) ? v[c.key].filter((x) => x !== o.value) : [...v[c.key], o.value];
          else {
            v[c.key] = o.value;
            r.outro[c.key] = "";
          }
          redesenhar();
        } }, h("span", { class: "marca" }, I("check", 12)), h("span", { class: "rot" }, h("b", {}, o.label), o.description ? h("small", {}, o.description) : null));
        box.append(b);
      }
      if (c.custom) {
        const outro = h("input", { type: "text", class: "outro", placeholder: "Outra resposta…", value: r.outro[c.key] || "", oninput: (e) => {
          const t = e.target.value;
          const antigo = r.outro[c.key] || "";
          r.outro[c.key] = t;
          if (multi) v[c.key] = [...v[c.key].filter((x) => x !== antigo), ...(t ? [t] : [])];
          else v[c.key] = t;
          box.querySelectorAll(".opcao").forEach((b, i) => {
            const m = selecionado(c.options[i]);
            b.classList.toggle("marcada", m);
            b.setAttribute("aria-checked", String(m));
          });
          mudou();
        } });
        box.append(outro);
      }
      return h("div", { class: "campo" }, cab, box);
    }
    const num = c.type === "number" || c.type === "integer";
    return h("div", { class: "campo" }, cab, h("input", { type: num ? "number" : "text", class: "outro", value: v[c.key] ?? "", placeholder: c.placeholder || "", oninput: (e) => {
      v[c.key] = num ? Number(e.target.value) : e.target.value;
      mudou();
    } }));
  }

  function desenharPendencias(perms, forms) {
    // só redesenha quando a lista muda: senão a escolha em andamento se perderia
    const assinatura = [...perms.map((p) => p.id), ...forms.map((f) => f.id)].join(",");
    if (assinatura === assinaturaPend) return;
    assinaturaPend = assinatura;
    for (const id of [...respostas.keys()]) if (!forms.some((f) => f.id === id)) respostas.delete(id);
    pend.replaceChildren(...perms.map(permEl), ...forms.map(formEl));
    if (perms.length || forms.length) rolar();
  }

  // ── /pair ──
  function desenharPair(url, expira) {
    clearInterval(pairTimer);
    const resta = h("b");
    const anel = h("div", { class: "anel" });
    pairBox.replaceChildren(
      h("div", { class: "tit" }, h("span", { class: "selo" }, I("phone", 14)), h("div", {}, h("b", {}, "Parear dispositivo"), h("small", {}, "Link de uso único")), h("span", { class: "flex" }), botaoIcone("x", "Fechar", () => ((pairBox.hidden = true), clearInterval(pairTimer)))),
      h("div", { class: "pair-corpo" }, anel, h("div", {}, h("p", {}, "Abra no dispositivo. Expira em ", resta, "."), h("code", { class: "url" }, url))),
      h("div", { class: "acoes" },
        h("button", { class: "pri", onclick: () => enviar({ tipo: "copiar", texto: url }) }, I("copy", 14), "Copiar"),
        h("button", { class: "sec", onclick: () => enviar({ tipo: "navegador", url }) }, I("external", 14), "Abrir neste PC"),
        h("button", { class: "neg", onclick: () => enviar({ tipo: "pair" }) }, I("refresh", 14), "Novo")),
      h("p", { class: "nota" }, "O serviço escuta só neste computador (127.0.0.1). O celular precisa alcançar esta máquina pela rede local ou por um túnel que você configurar. Quem abrir o link controla o OpenCode aqui: não compartilhe."),
    );
    const total = Math.max(1, expira - Date.now());
    const tique = () => {
      const ms = Math.max(0, expira - Date.now());
      const s = Math.round(ms / 1000);
      resta.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "— expirou";
      anel.style.setProperty("--p", String(ms / total));
      if (!s) clearInterval(pairTimer);
    };
    tique();
    pairTimer = setInterval(tique, 1000);
    pairBox.hidden = false;
  }

  let avisoTimer;
  function mostrarAviso(t, nivel = "erro", acao) {
    aviso.dataset.nivel = nivel;
    const botaoAcao = acao ? h("button", { class: "pri pequeno", onclick: () => ((aviso.hidden = true), acao.menu && abrirMenu(acao.menu)) }, acao.rotulo) : null;
    aviso.replaceChildren(...[I(nivel === "ok" ? "check" : "question", 14), h("span", {}, t), botaoAcao, botaoIcone("x", "Fechar", () => ((aviso.hidden = true), clearTimeout(avisoTimer)))].filter(Boolean));
    aviso.hidden = false;
    clearTimeout(avisoTimer);
    if (!acao) avisoTimer = setTimeout(() => (aviso.hidden = true), nivel === "ok" ? 4000 : 9000);
  }

  window.addEventListener("message", ({ data: m }) => {
    if (m.tipo === "estado") {
      E = m;
      aplicarTema(m.tema);
      desenharEstado();
    } else if (m.tipo === "historico") desenharHistorico(m.mensagens);
    else if (m.tipo === "eco") {
      lista.querySelector(".vazio")?.remove();
      lista.append(blocoUsuario(m.mensagem.text, m.mensagem.anexos));
      rolar();
    } else if (m.tipo === "evento") evento(m.e);
    else if (m.tipo === "pendencias") desenharPendencias(m.permissoes, m.forms);
    else if (m.tipo === "pair") desenharPair(m.url, m.expira);
    else if (m.tipo === "erro") mostrarAviso(m.texto);
    else if (m.tipo === "aviso") mostrarAviso(m.texto, m.nivel, m.acao);
    else if (m.tipo === "menu") abrirMenu(m.qual);
    else if (m.tipo === "ajuda") ajuda();
    else if (m.tipo === "enviarConteudo") {
      const faltam = new Set(m.nomes);
      void colarArquivos(pendentes.filter((f) => faltam.has(f.name || "")));
      pendentes = [];
    } else if (m.tipo === "anexos") {
      anexos.push(...m.itens);
      desenharAnexos();
      texto.focus();
    }
  });

  desenharEstado();
  desenharHistorico([]);
  enviar({ tipo: "pronto" });
})();
