// Visualizador de SITES de prévia da Ginga Mídia (página site.html).
// O site publicado NÃO roda na origem do visualizador: ele fica num iframe com
//   sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
// SEM allow-same-origin, ou seja, com origem opaca: o script do site não lê a IndexedDB "ginga-previas", os caches, os cookies
// nem enxerga o service worker, e não alcança esta página (parent.document dá SecurityError). Como um documento de origem
// opaca não é controlado pelo service worker, ESTA página (código confiável, a única que guarda a chave) busca os pedaços
// cifrados, decifra os arquivos do site e entrega o HTML por srcdoc, com todo recurso local (CSS, JS, imagens, fontes, vídeos,
// url() e @import dentro do CSS, srcset) trocado por data: URL. Recursos https de fora passam como estão.
// Navegação entre páginas internas: um pequeno script injetado no documento do iframe manda postMessage; esta página só aceita
// mensagem do próprio iframe (event.source), com formato estrito, e confere o caminho contra o manifesto antes de abrir.
// Manifesto versão 2 (site) ou versão 3 (grupo): ?p=<id>&n=<k> abre o item k, que precisa ser um site (item de arquivo vai para o
// index.html). O painel do topo (nome, Baixar o .zip, Compartilhamento) fica FORA do iframe e sobrevive à navegação interna do site.
// Nada do manifesto entra por innerHTML: nome, avisos e caminhos só por textContent; o HTML do site só vai para srcdoc.
(() => {
  "use strict";
  const T = window.__PREVIAS_TESTE || {}; // gancho de teste (só código desta página o define; o site isolado não alcança)
  const PEDACO = 1024 * 1024;
  const LIMITE_SITE = T.limiteSite ?? 60 * 1024 * 1024; // soma dos arquivos do site: tudo vira data: URL na memória
  const RE_ID = /^[A-Za-z0-9_-]{22}$/;
  const BASE = new URL("./", document.baseURI).pathname; // ex.: /previas/
  const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
  const ORIGEM_FALSA = "https://previa.invalid/"; // só para o URL() resolver caminhos relativos; nunca vai à rede
  const raiz = document.getElementById("raiz");
  const Painel = window.GingaPainel;
  const telaSite = document.getElementById("tela-site");   // grade: painel (linha 1) + palco do site (linha 2)
  const lugarPainel = document.getElementById("painel-site");
  const palco = document.getElementById("palco-site");
  const metaViewport = document.querySelector('meta[name="viewport"]');
  const VIEWPORT_PADRAO = metaViewport.getAttribute("content");

  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  function nonce(i, c) { const n = new Uint8Array(12), v = new DataView(n.buffer); v.setUint32(0, i >>> 0); v.setBigUint64(4, BigInt(c)); return n; }
  const decifrar = (chave, i, c, bytes) => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i, c), tagLength: 128 }, chave, bytes);

  // ----------------------------------------------------------------------
  // IndexedDB "ginga-previas": aqui só leitura e apagar; o registro do site tem só { id, chave (não extraível), expira }
  // ----------------------------------------------------------------------
  function abrirBanco() {
    return new Promise((ok, erro) => {
      const r = indexedDB.open("ginga-previas", 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("previas")) r.result.createObjectStore("previas", { keyPath: "id" }); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => erro(r.error);
    });
  }
  async function banco(modo, fn) {
    const db = await abrirBanco();
    try {
      return await new Promise((ok, erro) => {
        const t = db.transaction("previas", modo);
        const r = fn(t.objectStore("previas"));
        t.oncomplete = () => ok(r && "result" in r ? r.result : undefined);
        t.onerror = () => erro(t.error); t.onabort = () => erro(t.error);
      });
    } finally { db.close(); }
  }
  const lerRegistro = (id) => banco("readonly", (s) => s.get(id)).catch(() => undefined);
  const apagarRegistro = (id) => banco("readwrite", (s) => s.delete(id)).catch(() => {});

  // ----------------------------------------------------------------------
  // Avisos (só textContent)
  // ----------------------------------------------------------------------
  function el(tag, props = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === "texto") e.textContent = v; else if (k in e) e[k] = v; else e.setAttribute(k, v); }
    for (const f of filhos) if (f) e.append(f);
    return e;
  }
  function aviso({ titulo, texto, girar = false, botao, id }) {
    const m = el("main", { className: "aviso", role: "status" });
    if (id) m.id = id;
    if (girar) m.append(el("p", { className: "girar" }));
    m.append(el("p", { className: "marca", texto: "Ginga Mídia" }));
    m.append(el("h1", { texto: titulo }));
    if (texto) m.append(el("p", { className: "detalhe", texto }));
    if (botao) { const b = el("button", { className: "baixar", type: "button", texto: botao.texto }); b.addEventListener("click", botao.acao); m.append(b); }
    palco.replaceChildren(); telaSite.hidden = true;
    raiz.hidden = false; raiz.replaceChildren(m);
    return m;
  }
  // Aviso dentro do palco, com o painel do topo ainda visível (a pessoa pode ir para outro item do grupo)
  function avisoNoPalco({ titulo, texto, id: idAviso }) {
    const m = el("main", { className: "aviso", role: "status" });
    m.id = idAviso;
    m.append(el("p", { className: "marca", texto: "Ginga Mídia" }), el("h1", { texto: titulo }));
    if (texto) m.append(el("p", { className: "detalhe", texto }));
    raiz.hidden = true; raiz.replaceChildren();
    telaSite.hidden = false; palco.replaceChildren(m);
    return m;
  }
  const avisoItem = () => aviso({ id: "aviso-item", titulo: "Item não encontrado", texto: "Este link não tem o item pedido. Abra o link pelo primeiro item.", botao: { texto: "Abrir o primeiro item", acao: () => location.assign(`${BASE}?p=${id}`) } });
  const avisoExpirou = () => aviso({ id: "aviso-expirou", titulo: "Este link expirou", texto: "Peça um link novo a quem enviou." });
  const avisoFechada = () => aviso({ id: "aviso-fechada", titulo: "Abra o link da prévia de novo", texto: "Esta prévia não está guardada neste navegador. Abra o link inteiro, com tudo o que vem depois do #, ou peça um link novo a quem enviou." });
  const avisoSumiu = () => aviso({ id: "aviso-sumiu", titulo: "Prévia não encontrada", texto: "Este link não existe ou a prévia já foi apagada. Peça um link novo a quem enviou." });
  const avisoChave = () => aviso({ id: "aviso-chave", titulo: "Link incorreto ou incompleto", texto: "A chave deste link não confere. Abra o link inteiro, do jeito que foi enviado, ou peça um link novo a quem enviou." });
  const avisoFormato = () => aviso({ id: "aviso-formato", titulo: "Formato desconhecido", texto: "Esta prévia foi feita num formato que este visualizador não entende. Peça um link novo a quem enviou." });
  const avisoRede = (acao) => aviso({ id: "aviso-rede", titulo: "Não foi possível carregar o site", texto: "Confira a conexão com a internet e tente de novo.", botao: { texto: "Tentar de novo", acao } });
  function tamanhoLegivel(b) {
    const mb = b / (1024 * 1024);
    return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }
  const avisoGrande = (total) => avisoNoPalco({ id: "aviso-grande", titulo: "Este site é grande demais para abrir aqui",
    texto: `O site tem ${tamanhoLegivel(total)} e o visualizador abre sites de até ${tamanhoLegivel(LIMITE_SITE)}, porque guarda tudo na memória do aparelho. Peça uma versão mais leve a quem enviou (imagens e vídeos menores).` });

  // ----------------------------------------------------------------------
  // Manifesto e arquivos
  // ----------------------------------------------------------------------
  function validarSegmento(s) {
    return s !== "" && s !== "." && s !== ".." && !s.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(s);
  }
  async function buscar(url) {
    let ultimo;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
        if (r.ok || (r.status < 500 && r.status !== 429)) return r;
        ultimo = new Error(`HTTP ${r.status}`);
      } catch (e) { ultimo = e; }
      await esperar(400 * (t + 1));
    }
    throw ultimo;
  }

  let id = null, chave = null, grupo = null, item = null, n = 0, arquivos = null, pastas = null, entrada = null;

  async function carregarManifesto() {
    let rm, re;
    try {
      [rm, re] = await Promise.all([buscar(`${BASE}p/${id}/m.bin`), buscar(`${BASE}p/${id}/expira.json`)]);
    } catch { return { estado: "rede" }; }
    if (re.ok) { try { const j = await re.json(); if (typeof j?.expira === "number" && Number.isFinite(j.expira) && j.expira <= Date.now()) return { estado: "expirou" }; } catch {} }
    if (rm.status === 404) return { estado: "sumiu" };
    if (!rm.ok) return { estado: "rede" };
    let m;
    try { m = JSON.parse(new TextDecoder().decode(await decifrar(chave, 0xFFFFFFFF, 0, await rm.arrayBuffer()))); } catch { return { estado: "chave" }; }
    const g = Painel.normalizar(m);
    if (!g) return { estado: "formato" };
    if (g.expira <= Date.now()) return { estado: "expirou" };
    return { estado: "ok", grupo: g };
  }

  function indexar(it) {
    arquivos = new Map(); pastas = new Set([""]);
    for (const a of it.arquivos) {
      if (!a || typeof a.caminho !== "string" || !a.caminho.split("/").every(validarSegmento) || !Number.isInteger(a.tamanho) || a.tamanho < 0 || !Number.isInteger(a.i)) continue;
      if (a.pedacos !== Math.ceil(a.tamanho / PEDACO)) continue;
      arquivos.set(a.caminho, a);
      const partes = a.caminho.split("/");
      for (let k = 1; k < partes.length; k++) pastas.add(partes.slice(0, k).join("/"));
    }
    entrada = it.entrada;
  }

  // Limita os pedidos de pedaço em andamento (muitos recursos de uma página ao mesmo tempo)
  let ativos = 0; const fila = [];
  async function comVaga(fn) {
    if (ativos >= 6) await new Promise((ok) => fila.push(ok));
    ativos++;
    try { return await fn(); } finally { ativos--; fila.shift()?.(); }
  }
  async function lerBytes(arq) {
    const saida = new Uint8Array(arq.tamanho);
    for (let c = 0; c < arq.pedacos; c++) {
      const claro = new Uint8Array(await comVaga(async () => {
        const r = await buscar(`${BASE}p/${id}/${arq.i}-${c}.bin`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return decifrar(chave, arq.i, c, await r.arrayBuffer());
      }));
      if (claro.length !== Math.min(PEDACO, arq.tamanho - c * PEDACO)) throw new Error("pedaço com tamanho errado");
      saida.set(claro, c * PEDACO);
    }
    return saida;
  }

  // ----------------------------------------------------------------------
  // Caminhos: resolve uma referência relativa ao arquivo que a contém, só dentro do manifesto
  // ----------------------------------------------------------------------
  const codificarCaminho = (c) => c.split("/").map(encodeURIComponent).join("/");
  // Devolve { caminho (decodificado, sem a barra final), termina (tinha barra final), hash } ou null (externo, vazio, inválido)
  function interpretar(ref, base) {
    if (typeof ref !== "string") return null;
    ref = ref.trim();
    if (ref === "" || ref[0] === "#" || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
    let u;
    try { u = new URL(ref, ORIGEM_FALSA + codificarCaminho(base)); } catch { return null; }
    if (u.origin + "/" !== ORIGEM_FALSA) return null;
    const brutos = u.pathname.slice(1).split("/");
    const termina = u.pathname.endsWith("/");
    if (termina) brutos.pop();
    const segs = [];
    for (const b of brutos) {
      let d; try { d = decodeURIComponent(b); } catch { return null; }
      if (!validarSegmento(d)) return null;
      segs.push(d);
    }
    let hash = ""; try { hash = decodeURIComponent(u.hash.slice(1)); } catch {}
    return { caminho: segs.join("/"), termina, hash };
  }
  function acharArquivo(ref, base) {
    const i = interpretar(ref, base);
    if (!i || i.termina || i.caminho === "") return null;
    return arquivos.get(i.caminho) || null;
  }
  // Página: arquivo exato, ou pasta com index.html (a raiz abre a entrada). url é o endereço canônico (pasta com barra)
  function acharPagina(ref, base) {
    const i = interpretar(ref, base);
    if (!i) return null;
    if (!i.termina && i.caminho !== "" && arquivos.has(i.caminho)) return { arquivo: arquivos.get(i.caminho), url: i.caminho, hash: i.hash };
    if (pastas.has(i.caminho)) {
      const alvo = i.caminho === "" ? entrada : `${i.caminho}/index.html`;
      if (arquivos.has(alvo)) return { arquivo: arquivos.get(alvo), url: i.caminho === "" ? "" : `${i.caminho}/`, hash: i.hash };
    }
    return null;
  }
  // Página inicial do endereço: ?c= válido ou a entrada do site
  const paginaDoEndereco = (c) => (c ? acharPagina(c, "") : null) || acharPagina("/", "");
  const ehHtml = (a) => /^(text\/html|application\/xhtml\+xml)/i.test(a.mime || "") || /\.html?$/i.test(a.caminho);
  const ehCss = (a) => /^text\/css/i.test(a.mime || "") || /\.css$/i.test(a.caminho);
  function mimeComCharset(a) {
    const m = a.mime || "application/octet-stream";
    if (/charset=/i.test(m)) return m;
    return /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i.test(m) ? `${m};charset=utf-8` : m;
  }

  // ----------------------------------------------------------------------
  // Arquivo -> data: URL (CSS é reescrito antes: url() e @import também viram data:)
  // ----------------------------------------------------------------------
  const paraDataUrl = (bytes, mime) => new Promise((ok, erro) => {
    const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = () => erro(f.error);
    f.readAsDataURL(new Blob([bytes], { type: mime }));
  });
  let cacheDados = new Map();
  function dataUrlDe(arq, pilha = []) {
    let p = cacheDados.get(arq.caminho);
    if (p) return p;
    p = (async () => {
      if (ehCss(arq)) {
        const texto = new TextDecoder("utf-8").decode(await lerBytes(arq));
        return paraDataUrl(new TextEncoder().encode(await reescreverCss(texto, arq.caminho, [...pilha, arq.caminho])), "text/css;charset=utf-8");
      }
      return paraDataUrl(await lerBytes(arq), mimeComCharset(arq));
    })();
    cacheDados.set(arq.caminho, p);
    p.catch(() => cacheDados.delete(arq.caminho));
    return p;
  }
  async function substituir(texto, re, fn) {
    const achados = [...texto.matchAll(re)];
    if (!achados.length) return texto;
    const trocas = await Promise.all(achados.map((m) => fn(m)));
    let saida = "", ult = 0;
    achados.forEach((m, k) => { saida += texto.slice(ult, m.index) + trocas[k]; ult = m.index + m[0].length; });
    return saida + texto.slice(ult);
  }
  const RE_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')/gi;
  const RE_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
  async function reescreverCss(texto, base, pilha) {
    if (pilha.length > 8) return texto;
    texto = await substituir(texto, RE_IMPORT, async (m) => {
      const ref = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      const alvo = acharArquivo(ref, base);
      if (!alvo) return m[0];
      if (pilha.includes(alvo.caminho)) return "@import url(\"data:text/css,\")"; // ciclo: importa nada
      try { return `@import url("${await dataUrlDe(alvo, pilha)}")`; } catch { return m[0]; }
    });
    return substituir(texto, RE_URL, async (m) => {
      const alvo = acharArquivo(m[1] ?? m[2] ?? m[3], base);
      if (!alvo) return m[0];
      try { return `url("${await dataUrlDe(alvo, pilha)}")`; } catch { return m[0]; }
    });
  }

  // ----------------------------------------------------------------------
  // Reescrever o documento HTML do site
  // ----------------------------------------------------------------------
  const ATRIBUTOS_URL = ["src", "poster", "data-src", "data-lazy-src", "data-poster"];
  const ATRIBUTOS_SRCSET = ["srcset", "data-srcset", "data-lazy-srcset"];
  const SEM_CARGA = ["iframe", "frame", "embed", "object"]; // ficam como estão (o que for local não carrega)
  const RELS_ARQUIVO = ["stylesheet", "icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"];
  const RELS_SUMIR = ["preload", "prefetch", "prerender", "modulepreload", "manifest"];

  async function reescreverSrcset(valor, base) {
    const partes = [...valor.matchAll(/([^\s,]+)(\s+[^,\s]+)?\s*(,|$)/g)];
    const novas = await Promise.all(partes.map(async (m) => {
      const alvo = acharArquivo(m[1], base);
      let url = m[1];
      if (alvo) { try { url = await dataUrlDe(alvo); } catch {} }
      return url + (m[2] || "");
    }));
    return novas.join(", ");
  }

  async function reescreverDocumento(doc, base) {
    doc.querySelectorAll("base").forEach((e) => e.remove());
    doc.querySelectorAll("meta[http-equiv]").forEach((e) => { if (/^(content-security-policy|x-frame-options)$/i.test(e.getAttribute("http-equiv"))) e.remove(); });
    const trabalhos = [];
    const tirarIntegridade = (e) => { e.removeAttribute("integrity"); e.removeAttribute("crossorigin"); };
    const trocar = (e, atr) => {
      const alvo = acharArquivo(e.getAttribute(atr), base);
      if (!alvo) return;
      trabalhos.push(dataUrlDe(alvo).then((d) => { e.setAttribute(atr, d); tirarIntegridade(e); }, () => {}));
    };
    for (const e of doc.querySelectorAll("[src],[poster],[data-src],[data-lazy-src],[data-poster],link[href],image[href],[srcset],[data-srcset],[data-lazy-srcset],style,[style]")) {
      const tag = e.localName;
      if (tag === "style") { const t = e.textContent; if (/url\(|@import/i.test(t)) trabalhos.push(reescreverCss(t, base, []).then((n) => { e.textContent = n; })); continue; }
      if (e.hasAttribute("style") && /url\(/i.test(e.getAttribute("style"))) trabalhos.push(reescreverCss(e.getAttribute("style"), base, []).then((n) => e.setAttribute("style", n)));
      if (SEM_CARGA.includes(tag)) continue;
      if (tag === "link") {
        const rels = (e.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        if (rels.some((r) => RELS_SUMIR.includes(r))) { if (acharArquivo(e.getAttribute("href"), base)) e.remove(); continue; }
        if (rels.some((r) => RELS_ARQUIVO.includes(r))) trocar(e, "href");
        continue;
      }
      if (tag === "image") { trocar(e, "href"); continue; }
      for (const a of ATRIBUTOS_URL) if (e.hasAttribute(a)) trocar(e, a);
      for (const a of ATRIBUTOS_SRCSET) if (e.hasAttribute(a)) trabalhos.push(reescreverSrcset(e.getAttribute(a), base).then((n) => e.setAttribute(a, n)));
    }
    await Promise.all(trabalhos);
  }

  // Script injetado no documento do site (ES5, texto fixo): captura clique em link e envio de formulário e avisa esta página
  const SCRIPT_NAVEGACAO = `(function(){
var H=__HASH__;
function ext(h){return /^[a-z][a-z0-9+.\\-]*:/i.test(h)||h.slice(0,2)==='//';}
function nav(h){try{parent.postMessage({ginga:'navegar',href:String(h).slice(0,2000)},'*');}catch(e){}}
function ancora(n){while(n&&n.nodeType===1){if((n.localName==='a'||n.localName==='area')&&n.hasAttribute('href'))return n;n=n.parentNode;}return null;}
function ir(i){try{i=decodeURIComponent(i);}catch(x){}if(!i||i==='top'){scrollTo(0,0);return;}var el=document.getElementById(i)||document.getElementsByName(i)[0];try{location.hash=i;}catch(x){}if(el)el.scrollIntoView();}
function clique(e){
  if(e.defaultPrevented)return;
  var a=ancora(e.target);if(!a)return;
  var h=a.getAttribute('href').trim();
  if(h.charAt(0)==='#'){e.preventDefault();if(e.type==='click')ir(h.slice(1));return;}
  if(/^(javascript|mailto|tel|sms|data|blob):/i.test(h))return;
  if(ext(h)){if(e.type==='click'&&!a.target){e.preventDefault();window.open(a.href,'_blank','noopener,noreferrer');}return;}
  e.preventDefault();
  if(e.type==='click')nav(h);
}
document.addEventListener('click',clique,false);
document.addEventListener('auxclick',clique,false);
document.addEventListener('submit',function(e){
  var f=e.target;if(!f||f.localName!=='form'||e.defaultPrevented)return;
  var ac=(f.getAttribute('action')||'').trim();
  if(ac!==''&&ext(ac)){if(!f.target)f.target='_blank';return;}
  e.preventDefault();
  if(String(f.method).toLowerCase()==='get'&&ac!=='')nav(ac);
},false);
if(H){addEventListener('load',function(){ir(H);});}
})();`;
  const jsonSeguro = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

  function decodificar(bytes) {
    let rotulo = "utf-8";
    const cabeca = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(cabeca);
    if (m) rotulo = m[1];
    try { return new TextDecoder(rotulo).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
  }

  // ----------------------------------------------------------------------
  // Mostrar páginas e navegar
  // ----------------------------------------------------------------------
  let atual = null;     // { arquivo, url } da página mostrada
  let geracao = 0;      // descarta uma montagem lenta quando chega outra

  function montarQuadro(html, titulo) {
    const q = document.createElement("iframe");
    q.id = "quadro-site";
    q.setAttribute("sandbox", SANDBOX); // ANTES de srcdoc e de entrar na página; nunca allow-same-origin
    q.setAttribute("referrerpolicy", "no-referrer");
    q.title = titulo;
    q.srcdoc = html;
    raiz.hidden = true; raiz.replaceChildren();
    telaSite.hidden = false;
    palco.replaceChildren(q);
    return q;
  }
  let quadro = null;

  async function montarPagina(dest) {
    const minha = ++geracao;
    const espera = setTimeout(() => { if (minha === geracao && !raiz.querySelector(".girar") && quadro === null) aviso({ id: "aviso-abrindo", girar: true, titulo: "Abrindo o site…" }); }, 250);
    try {
      const texto = decodificar(await lerBytes(dest.arquivo));
      const doc = new DOMParser().parseFromString(texto, "text/html");
      await reescreverDocumento(doc, dest.arquivo.caminho);
      if (minha !== geracao) return false;
      const s = doc.createElement("script");
      s.textContent = SCRIPT_NAVEGACAO.replace("__HASH__", () => jsonSeguro(dest.hash || ""));
      doc.head.prepend(s);
      const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "";
      const html = doctype + doc.documentElement.outerHTML;
      // A meta viewport do site vale para esta página (no iframe ela seria ignorada); sem ela, largura do aparelho
      const vp = doc.querySelector('meta[name="viewport" i]')?.getAttribute("content");
      metaViewport.setAttribute("content", vp || VIEWPORT_PADRAO);
      document.title = (doc.title || "").trim() || item.nome;
      quadro = montarQuadro(html, item.nome);
      atual = { arquivo: dest.arquivo, url: dest.url };
      return true;
    } finally { clearTimeout(espera); }
  }

  const caminhoDoEndereco = (url) => `${location.pathname}?p=${id}${n ? `&n=${n}` : ""}${url ? `&c=${encodeURIComponent(url)}` : ""}`;

  // modo: "empurrar" (novo item no histórico), "substituir" ou "nenhum" (voltar/avançar do navegador)
  async function abrirPagina(dest, modo) {
    try {
      if (!(await montarPagina(dest))) return;
    } catch { return avisoRede(() => abrirPagina(dest, modo)); }
    try {
      if (modo === "empurrar") history.pushState(null, "", caminhoDoEndereco(dest.url));
      else if (modo === "substituir") history.replaceState(null, "", caminhoDoEndereco(dest.url));
    } catch {}
  }

  const TIPOS_ABRIR_EM_ABA = /^(application\/pdf|image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
  async function navegar(href) {
    if (!atual) return;
    const dest = acharPagina(href, atual.arquivo.caminho);
    if (dest && ehHtml(dest.arquivo)) return abrirPagina(dest, "empurrar");
    // Arquivo local que não é página (PDF, imagem, áudio, vídeo): abre em outra aba, só destes tipos, nunca HTML nem SVG
    const arq = acharArquivo(href, atual.arquivo.caminho);
    const tipo = String(arq?.mime || "").split(";")[0].trim().toLowerCase();
    if (arq && TIPOS_ABRIR_EM_ABA.test(tipo)) {
      try {
        const url = URL.createObjectURL(new Blob([await lerBytes(arq)], { type: tipo }));
        window.open(url, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
      } catch {}
    }
  }

  // Só aceita mensagem do próprio iframe, com exatamente { ginga: "navegar", href: string curta }
  window.addEventListener("message", (ev) => {
    if (!quadro || ev.source !== quadro.contentWindow) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || Array.isArray(d)) return;
    const chaves = Object.keys(d);
    if (chaves.length !== 2 || d.ginga !== "navegar" || typeof d.href !== "string" || d.href.length === 0 || d.href.length > 2000) return;
    navegar(d.href);
  });
  window.addEventListener("popstate", () => {
    if (!item) return;
    const dest = paginaDoEndereco(new URLSearchParams(location.search).get("c"));
    if (dest) abrirPagina(dest, "nenhum");
  });

  // ----------------------------------------------------------------------
  // Painel do topo e Baixar (.zip com os arquivos ORIGINAIS do site, decifrados, sem a reescrita para data: URL)
  // ----------------------------------------------------------------------
  let avisoTempo = null;
  function mensagem(texto) { // aviso curto sobre o site, sem mexer na posição dele
    document.getElementById("mensagem-painel")?.remove(); clearTimeout(avisoTempo);
    const m = el("p", { id: "mensagem-painel", className: "mensagem-painel", role: "alert", texto });
    document.body.append(m); avisoTempo = setTimeout(() => m.remove(), 8000);
  }
  const somaDoSite = () => [...arquivos.values()].reduce((s, a) => s + a.tamanho, 0);
  function montarPainel() {
    const baixar = el("button", { id: "baixar", type: "button", title: `Baixar o site em um arquivo .zip (${Painel.tamanhoLegivel(somaDoSite())})` });
    const p = Painel.montar({ id, grupo, n, base: BASE, baixar });
    let ocupado = false;
    baixar.addEventListener("click", async () => {
      if (ocupado) return;
      const total = somaDoSite();
      if (total > LIMITE_SITE) { avisoGrande(total); mensagem(`O site tem ${tamanhoLegivel(total)}: grande demais para baixar aqui (limite de ${tamanhoLegivel(LIMITE_SITE)}).`); return; }
      ocupado = true; baixar.disabled = true; baixar.setAttribute("aria-busy", "true"); p.rotuloBaixar.textContent = "Preparando…";
      try {
        const lista = [...arquivos.values()];
        const entradas = await Promise.all(lista.map(async (a) => ({ nome: a.caminho, dados: await lerBytes(a) })));
        const url = URL.createObjectURL(Painel.criarZip(entradas));
        const a = el("a", { href: url, download: Painel.nomeDoZip(item.nome) }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch { mensagem("Não foi possível preparar o .zip. Tente de novo."); }
      finally { ocupado = false; baixar.disabled = false; baixar.removeAttribute("aria-busy"); p.rotuloBaixar.textContent = "Baixar"; }
    });
    lugarPainel.replaceChildren(p.cabecalho);
  }

  // Prazo: com a prévia aberta, quando passa o prazo o site some e a chave é apagada
  function vigiarPrazo(expira) {
    const t = setInterval(() => {
      if (Date.now() < expira) return;
      clearInterval(t);
      geracao++; quadro = null; atual = null; cacheDados = new Map(); lugarPainel.replaceChildren();
      apagarRegistro(id);
      avisoExpirou();
    }, 1000);
  }

  // ----------------------------------------------------------------------
  // Início
  // ----------------------------------------------------------------------
  async function iniciar() {
    const params = new URLSearchParams(location.search);
    const p = params.get("p");
    if (!p || !RE_ID.test(p)) return aviso({ id: "aviso-inicio", titulo: "Prévias da Ginga Mídia", texto: "Abra o link completo da prévia que você recebeu, com tudo o que vem depois do #." });
    id = p;
    const reg = await lerRegistro(id);
    if (!reg || !reg.chave) return avisoFechada();
    if (!(reg.expira > Date.now())) { await apagarRegistro(id); return avisoExpirou(); }
    chave = reg.chave;
    const r = await carregarManifesto();
    if (r.estado === "expirou") { await apagarRegistro(id); return avisoExpirou(); }
    if (r.estado === "sumiu") { await apagarRegistro(id); return avisoSumiu(); }
    if (r.estado === "chave") { await apagarRegistro(id); return avisoChave(); }
    if (r.estado === "formato") return avisoFormato();
    if (r.estado === "rede") return avisoRede(() => location.reload());
    grupo = r.grupo;
    const nParam = params.get("n");
    n = nParam === null ? 0 : /^\d{1,3}$/.test(nParam) ? Number(nParam) : -1;
    item = grupo.itens[n];
    if (!item) { n = 0; return avisoItem(); }
    if (item.tipo !== "site") { location.replace(`${BASE}?p=${id}&n=${n}`); return; } // item de arquivo: quem mostra é o index.html
    indexar(item);
    if (!arquivos.has(entrada)) return avisoFormato();
    document.title = `${item.nome} · Ginga Mídia`;
    montarPainel();
    vigiarPrazo(grupo.expira);
    const total = somaDoSite();
    if (total > LIMITE_SITE) return avisoGrande(total);
    const dest = paginaDoEndereco(params.get("c"));
    return abrirPagina(dest, "substituir");
  }
  iniciar().catch(() => avisoRede(() => location.reload()));
})();
