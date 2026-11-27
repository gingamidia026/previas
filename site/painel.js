// Painel superior e janela de compartilhamento das prévias da Ginga Mídia (usado por index.html e site.html).
// - normalizar(): aceita o manifesto versão 2 (arquivo ou site, vira um grupo de 1 item) e versão 3 (grupo de itens).
// - montar(): barra do topo (nome do item, Baixar, Compartilhamento) e o <dialog> modal com a explicação e a lista dos itens.
// - criarZip(): .zip feito no navegador (sem compressão, método 0 "store", CRC32, nomes UTF-8), para baixar um site.
// Segurança: nenhuma chave passa por aqui (a chave fica só na IndexedDB, não extraível); todo texto vindo do manifesto
// entra só por textContent; o endereço de cada item leva só o id e o número (?p=<id>&n=<k>).
(() => {
  "use strict";
  const MAX_ITENS = 100;
  const RE_ID = /^[A-Za-z0-9_-]{22}$/;
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, props = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === "texto") e.textContent = v; else if (k in e && k !== "list") e[k] = v; else e.setAttribute(k, v); }
    for (const f of filhos) if (f) e.append(f);
    return e;
  }
  function icone(formas) {
    const s = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "20", height: "20", "aria-hidden": "true", focusable: "false" })) s.setAttribute(k, v);
    for (const [tag, attrs] of formas) {
      const f = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round", ...attrs })) f.setAttribute(k, v);
      s.append(f);
    }
    return s;
  }
  const iconeBaixar = () => icone([["path", { d: "M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2", "stroke-width": "2.4" }]]);
  const iconeCompartilhar = () => icone([["circle", { cx: "18", cy: "5", r: "3" }], ["circle", { cx: "6", cy: "12", r: "3" }], ["circle", { cx: "18", cy: "19", r: "3" }],
    ["path", { d: "M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" }]]);

  // ---------------------------------------------------------------------
  // Formato do manifesto: versão 2 (arquivo, site) e versão 3 (grupo) viram { versao, nome, expira, itens: [{ n, tipo, nome, entrada, arquivos }] }
  // ---------------------------------------------------------------------
  function normalizar(m) {
    if (!m || typeof m !== "object" || typeof m.expira !== "number" || !Number.isFinite(m.expira)) return null;
    if (m.versao === 2) {
      if (!["arquivo", "site"].includes(m.tipo) || !Array.isArray(m.arquivos) || !m.arquivos.length) return null;
      if (m.tipo === "site" && typeof m.entrada !== "string") return null;
      return { versao: 2, nome: m.nome, expira: m.expira, itens: [{ n: 0, tipo: m.tipo, nome: m.nome, entrada: m.entrada, arquivos: m.arquivos }] };
    }
    if (m.versao === 3 && m.tipo === "grupo") {
      if (!Array.isArray(m.itens) || m.itens.length < 1 || m.itens.length > MAX_ITENS) return null;
      const itens = [];
      for (let n = 0; n < m.itens.length; n++) {
        const it = m.itens[n];
        if (!it || typeof it !== "object" || !["arquivo", "site"].includes(it.tipo) || typeof it.nome !== "string" || !it.nome || !Array.isArray(it.arquivos) || !it.arquivos.length) return null;
        if (it.tipo === "arquivo" && it.arquivos.length !== 1) return null;
        if (it.tipo === "site" && typeof it.entrada !== "string") return null;
        // O índice `i` é o nonce: não pode repetir DENTRO do item. Entre itens de site que repartem a mesma pasta ele se repete
        // de propósito (os .bin são os mesmos), então não se confere no grupo todo.
        const vistos = new Set();
        for (const a of it.arquivos) {
          if (!a || !Number.isInteger(a.i) || a.i < 0 || vistos.has(a.i)) return null;
          vistos.add(a.i);
        }
        itens.push({ n, tipo: it.tipo, nome: it.nome, entrada: it.tipo === "arquivo" ? it.arquivos[0].caminho : it.entrada, arquivos: it.arquivos });
      }
      return { versao: 3, nome: typeof m.nome === "string" && m.nome ? m.nome : itens[0].nome, expira: m.expira, itens };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Texto
  // ---------------------------------------------------------------------
  function formatarData(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} às ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  }
  function tamanhoLegivel(b) {
    if (b < 1024) return `${b} bytes`;
    const u = ["KB", "MB", "GB", "TB"]; let v = b / 1024, k = 0;
    while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }
    return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${u[k]}`;
  }
  function rotuloTipo(item) {
    if (item.tipo === "site") return "Site";
    const mime = String(item.arquivos[0]?.mime || "").toLowerCase();
    if (mime.startsWith("image/")) return "Imagem";
    if (mime.startsWith("video/")) return "Vídeo";
    if (mime.startsWith("audio/")) return "Áudio";
    if (mime === "application/pdf") return "PDF";
    return "Arquivo";
  }
  const tamanhoDoItem = (item) => item.arquivos.reduce((s, a) => s + (Number.isInteger(a.tamanho) ? a.tamanho : 0), 0);
  const hrefDoItem = (base, id, item) => `${base}${item.tipo === "site" ? "site.html" : ""}?p=${id}&n=${item.n}`;

  // ---------------------------------------------------------------------
  // Painel e janela
  // ---------------------------------------------------------------------
  // opc: { id, grupo (normalizado), n (item atual), base (ex.: /previas/), baixar (elemento <a> ou <button> já com o comportamento) }
  function montar({ id, grupo, n, base, baixar }) {
    if (!RE_ID.test(id)) throw new Error("id inválido");
    const atual = grupo.itens[n];
    const total = grupo.itens.length;
    const titulo = el("h1", { texto: atual.nome, title: atual.nome });
    const rotuloBaixar = el("span", { texto: "Baixar" });
    baixar.classList.add("baixar");
    baixar.replaceChildren(iconeBaixar(), rotuloBaixar);

    const botao = el("button", { id: "compartilhar", className: "compartilhar", type: "button", title: "Compartilhamento: como funciona este link e os itens dele" },
      iconeCompartilhar(), el("span", { className: "rotulo", texto: "Compartilhamento" }));
    botao.setAttribute("aria-label", "Compartilhamento: como funciona este link e os itens dele");
    botao.setAttribute("aria-haspopup", "dialog");

    // Janela
    const fechar = el("button", { id: "fechar-janela", className: "botao-fechar", type: "button", texto: "Fechar" });
    const dlg = el("dialog", { id: "janela-compartilhar", className: "janela" });
    dlg.setAttribute("aria-labelledby", "janela-titulo");

    const lista = el("ol", { id: "janela-itens", className: "janela-lista" });
    lista.setAttribute("aria-label", "Itens compartilhados neste link");
    for (const it of grupo.itens) {
      const ehAtual = it.n === n;
      const nomeEl = el("span", { className: "item-nome", texto: it.nome });
      const metaEl = el("span", { className: "item-meta", texto: `${rotuloTipo(it)} · ${tamanhoLegivel(tamanhoDoItem(it))}` });
      const corpo = el("span", { className: "item-texto" }, nomeEl, metaEl);
      if (ehAtual) corpo.append(el("span", { className: "item-aqui", texto: "Aberto agora" }));
      const a = el("a", { className: "item-link", href: hrefDoItem(base, id, it) }, corpo);
      if (ehAtual) {
        a.setAttribute("aria-current", "page");
        a.addEventListener("click", (ev) => { ev.preventDefault(); dlg.close(); });
      }
      lista.append(el("li", {}, a));
    }

    const explicacao = el("p", { className: "janela-texto", texto: "Esta prévia chegou por um link só. A chave que abre o conteúdo fica dentro do próprio link e nunca vai ao GitHub, que guarda apenas o conteúdo cifrado." });
    const quantos = el("p", { id: "janela-quantos", className: "janela-texto", texto: total === 1 ? "Este link compartilha 1 item." : `Este link compartilha ${total} itens.` });
    const validade = el("p", { id: "janela-validade", className: "janela-texto", texto: `O link vale até ${formatarData(grupo.expira)}. Depois disso ele deixa de abrir.` });
    const caixaCorpo = el("div", { className: "janela-corpo" }, explicacao, quantos, validade, lista);
    const topo = el("div", { className: "janela-topo" }, el("h2", { id: "janela-titulo", texto: "Prévia compartilhada pela Ginga Mídia" }), fechar);
    const caixa = el("div", { className: "janela-caixa" }, topo, caixaCorpo);

    if (total > 1) {
      const anterior = n > 0 ? el("a", { id: "item-anterior", className: "botao-nav", href: hrefDoItem(base, id, grupo.itens[n - 1]), rel: "prev", texto: "‹ Anterior" })
        : el("button", { id: "item-anterior", className: "botao-nav", type: "button", disabled: true, texto: "‹ Anterior" });
      const proximo = n < total - 1 ? el("a", { id: "item-proximo", className: "botao-nav", href: hrefDoItem(base, id, grupo.itens[n + 1]), rel: "next", texto: "Próximo ›" })
        : el("button", { id: "item-proximo", className: "botao-nav", type: "button", disabled: true, texto: "Próximo ›" });
      caixa.append(el("nav", { className: "janela-nav" }, anterior, el("span", { id: "item-posicao", className: "janela-posicao", texto: `${n + 1} de ${total}` }), proximo));
      caixa.lastChild.setAttribute("aria-label", "Navegar entre os itens");
    }
    dlg.append(caixa);

    botao.addEventListener("click", () => { if (!dlg.open) dlg.showModal(); });
    fechar.addEventListener("click", () => dlg.close());
    // clique no fundo: só fecha se o botão do mouse desceu e subiu no próprio <dialog> (e não numa seleção de texto que saiu da caixa)
    let desceuNoFundo = false;
    dlg.addEventListener("pointerdown", (ev) => { desceuNoFundo = ev.target === dlg; });
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg && desceuNoFundo) dlg.close(); desceuNoFundo = false; });
    dlg.addEventListener("close", () => botao.focus());

    const cabecalho = el("header", { className: "cabecalho painel" }, titulo, baixar, botao, dlg);
    return { cabecalho, titulo, botaoBaixar: baixar, rotuloBaixar, janela: dlg };
  }

  // ---------------------------------------------------------------------
  // .zip sem compressão (método 0), CRC32, nomes em UTF-8 (bit 11). entradas: [{ nome, dados: Uint8Array }]
  // ---------------------------------------------------------------------
  const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = TABELA_CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function criarZip(entradas, agora = new Date()) {
    if (entradas.length > 0xFFFF) throw new Error("arquivos demais para um .zip simples");
    const enc = new TextEncoder();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const data = ((Math.max(1980, agora.getFullYear()) - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const partes = [], central = []; let deslocamento = 0;
    for (const e of entradas) {
      const nome = enc.encode(e.nome), n = e.dados.length, crc = crc32(e.dados);
      if (n > 0xFFFFFFFF || deslocamento > 0xFFFFFFFF) throw new Error("grande demais para um .zip simples");
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, hora, true); lh.setUint16(12, data, true); lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true);
      lh.setUint16(26, nome.length, true); lh.setUint16(28, 0, true);
      partes.push(lh.buffer, nome, e.dados);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, hora, true); ch.setUint16(14, data, true); ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true);
      ch.setUint16(28, nome.length, true); ch.setUint32(42, deslocamento, true);
      central.push(ch.buffer, nome);
      deslocamento += 30 + nome.length + n;
    }
    const tamCentral = central.reduce((s, p) => s + p.byteLength, 0);
    if (deslocamento + tamCentral > 0xFFFFFFFF) throw new Error("grande demais para um .zip simples");
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, entradas.length, true); fim.setUint16(10, entradas.length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, deslocamento, true);
    return new Blob([...partes, ...central, fim.buffer], { type: "application/zip" });
  }
  function nomeDoZip(nome) {
    const limpo = String(nome).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "site";
    return `${limpo}.zip`;
  }

  window.GingaPainel = Object.freeze({ normalizar, montar, criarZip, nomeDoZip, formatarData, tamanhoLegivel, rotuloTipo, crc32 });
})();
