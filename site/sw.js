// Service worker do visualizador de prévias da Ginga Mídia.
// Atende o caminho virtual <escopo>v/<id>/<caminho> buscando os pedaços cifrados em <escopo>p/<id>/ e decifrando só os
// pedaços necessários (pedidos com Range: vídeo toca e pula sem baixar tudo). A chave decifradora (CryptoKey não
// extraível) vem da IndexedDB "ginga-previas", gravada pela página do visualizador, e fica em memória aqui.
// Só serve prévia do tipo "arquivo": versão 2 arquivo, ou os itens do tipo "arquivo" de um grupo (versão 3), com caminho virtual
// <n>/<caminho> (n = posição do item). Site NÃO passa por aqui: o site publicado roda num iframe isolado montado pela página
// site.html, e um site servido por este worker na origem do visualizador poderia ler a IndexedDB e pedir outras prévias.
// Tudo o que não é do caminho virtual (inclusive https:// de fora) passa direto, sem respondWith.
"use strict";

const PEDACO = 1024 * 1024;
const BASE = new URL("./", self.registration.scope).pathname; // ex.: /previas/
const PREFIXO = BASE + "v/";
const RE_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_PEDACOS_EM_MEMORIA = 16;

// ---------------------------------------------------------------------------
// IndexedDB (a mesma da página)
// ---------------------------------------------------------------------------
function abrirBanco() {
  return new Promise((ok, erro) => {
    const r = indexedDB.open("ginga-previas", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("previas")) r.result.createObjectStore("previas", { keyPath: "id" }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
}
async function transacao(modo, fn) {
  const db = await abrirBanco();
  try {
    return await new Promise((ok, erro) => {
      const t = db.transaction("previas", modo);
      const r = fn(t.objectStore("previas"));
      t.oncomplete = () => ok(r && "result" in r ? r.result : undefined);
      t.onerror = () => erro(t.error);
      t.onabort = () => erro(t.error);
    });
  } finally { db.close(); }
}
const lerRegistro = (id) => transacao("readonly", (s) => s.get(id));
const apagarRegistro = (id) => transacao("readwrite", (s) => s.delete(id));
async function limparVencidas() {
  const db = await abrirBanco();
  try {
    await new Promise((ok, erro) => {
      const t = db.transaction("previas", "readwrite");
      const c = t.objectStore("previas").openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return; if (!(cur.value.expira > Date.now())) { memoria.delete(cur.value.id); cur.delete(); } cur.continue(); };
      t.oncomplete = ok; t.onerror = () => erro(t.error); t.onabort = () => erro(t.error);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Registro da prévia (chave + manifesto), em memória e na IndexedDB
// ---------------------------------------------------------------------------
const memoria = new Map(); // id -> registro com índice de caminhos
let ultimaLimpeza = 0;

function validarSegmento(s) {
  return s !== "" && s !== "." && s !== ".." && !s.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(s);
}
function caminhoValido(c) { return typeof c === "string" && c !== "" && c.split("/").every(validarSegmento); }

function indexar(reg) {
  const m = reg.manifesto;
  const arquivos = new Map(); const pastas = new Set([""]);
  const adicionar = (a, virtual, extra) => {
    if (!a || !caminhoValido(a.caminho) || !Number.isInteger(a.tamanho) || a.tamanho < 0 || !Number.isInteger(a.i)) return;
    if (a.pedacos !== Math.ceil(a.tamanho / PEDACO)) return;
    arquivos.set(virtual, extra ? { ...a, ...extra } : a);
    const partes = virtual.split("/");
    for (let k = 1; k < partes.length; k++) pastas.add(partes.slice(0, k).join("/"));
  };
  let entrada = m.entrada;
  if (m.versao === 3) {
    // grupo: só os itens "arquivo" entram; o caminho virtual leva a posição do item na frente; site nunca é servido
    entrada = undefined;
    (Array.isArray(m.itens) ? m.itens : []).forEach((it, n) => {
      if (!it || it.tipo !== "arquivo" || !Array.isArray(it.arquivos)) return;
      for (const a of it.arquivos) {
        if (!a || typeof a.caminho !== "string") continue;
        adicionar(a, `${n}/${a.caminho}`, { nomeItem: typeof it.nome === "string" && it.nome ? it.nome : undefined });
        if (entrada === undefined && arquivos.has(`${n}/${a.caminho}`)) entrada = `${n}/${a.caminho}`; // a raiz do grupo leva ao 1º arquivo
      }
    });
  } else for (const a of m.arquivos || []) if (a && typeof a.caminho === "string") adicionar(a, a.caminho, null);
  reg.entrada = entrada; reg.arquivos = arquivos; reg.pastas = pastas; reg.pedacosCache = new Map();
  return reg;
}

// Devolve {reg} | {vencido:true} | {desconhecido:true} (sem chave, sem manifesto ou que não é do tipo arquivo)
async function obterRegistro(id) {
  if (Date.now() - ultimaLimpeza > 60_000) { ultimaLimpeza = Date.now(); limparVencidas().catch(() => {}); }
  let reg = memoria.get(id);
  if (!reg) {
    try { reg = await lerRegistro(id); } catch { reg = null; }
    if (!reg || !reg.chave || !reg.manifesto) return { desconhecido: true };
    const m = reg.manifesto;
    const ehArquivo = m.versao === 2 && m.tipo === "arquivo", ehGrupo = m.versao === 3 && m.tipo === "grupo" && Array.isArray(m.itens);
    if (!ehArquivo && !ehGrupo) return { desconhecido: true }; // site (versão 2) nunca é servido; no grupo, só os itens "arquivo" são indexados
    reg = indexar({ id, chave: reg.chave, expira: reg.expira, manifesto: reg.manifesto });
    memoria.set(id, reg);
  }
  if (!(reg.expira > Date.now()) || !(reg.manifesto.expira > Date.now())) {
    memoria.delete(id); apagarRegistro(id).catch(() => {});
    return { vencido: true };
  }
  return { reg };
}

// ---------------------------------------------------------------------------
// Pedaços cifrados -> texto claro
// ---------------------------------------------------------------------------
function nonce(i, c) {
  const n = new Uint8Array(12), v = new DataView(n.buffer);
  v.setUint32(0, i >>> 0); v.setBigUint64(4, BigInt(c));
  return n;
}
async function buscarCifrado(id, arq, c) {
  const url = `${BASE}p/${id}/${arq.i}-${c}.bin`;
  let ultimo;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      ultimo = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { ultimo = e; }
    await new Promise((ok) => setTimeout(ok, 400 * (t + 1)));
  }
  throw ultimo;
}
function pedacoDecifrado(reg, arq, c) {
  const k = `${arq.i}-${c}`;
  let p = reg.pedacosCache.get(k);
  if (p) { reg.pedacosCache.delete(k); reg.pedacosCache.set(k, p); return p; }
  p = (async () => {
    const cifrado = await buscarCifrado(reg.id, arq, c);
    const claro = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(arq.i, c), tagLength: 128 }, reg.chave, cifrado));
    const esperado = Math.min(PEDACO, arq.tamanho - c * PEDACO);
    if (claro.length !== esperado) throw new Error("pedaço com tamanho errado");
    return claro;
  })();
  p.catch(() => reg.pedacosCache.delete(k));
  reg.pedacosCache.set(k, p);
  while (reg.pedacosCache.size > MAX_PEDACOS_EM_MEMORIA) reg.pedacosCache.delete(reg.pedacosCache.keys().next().value);
  return p;
}

function fluxo(reg, arq, ini, fim) { // fim inclusivo
  let pos = ini;
  return new ReadableStream({
    async pull(ctrl) {
      try {
        if (pos > fim) { ctrl.close(); return; }
        const c = Math.floor(pos / PEDACO);
        const dados = await pedacoDecifrado(reg, arq, c);
        const a = pos - c * PEDACO, b = Math.min(dados.length, fim - c * PEDACO + 1);
        ctrl.enqueue(dados.subarray(a, b));
        pos = c * PEDACO + b;
        if (pos > fim) ctrl.close();
      } catch (e) { ctrl.error(e); }
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 }));
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------
const CABECALHOS_BASE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
};
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function pagina(status, titulo, texto) {
  const corpo = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1D233B;color:#F2E8DC;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:24px;margin:0 0 8px}p{margin:0;color:#b9b3ac}</style></head>
<body><main><h1>${esc(titulo)}</h1><p>${esc(texto)}</p></main></body></html>`;
  return new Response(corpo, { status, headers: { ...CABECALHOS_BASE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
const naoEncontrado = () => pagina(404, "Página não encontrada", "Este endereço não existe nesta prévia.");
const semChave = () => pagina(404, "Prévia fechada neste navegador", "Abra de novo o link original da prévia, com tudo o que vem depois do #. Se ele não abrir, peça um link novo a quem enviou.");
const vencida = () => pagina(410, "Este link expirou", "Peça um link novo a quem enviou.");

function comCharset(mime) {
  if (/charset=/i.test(mime)) return mime;
  return /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i.test(mime) ? `${mime}; charset=utf-8` : mime;
}
function nomeParaCabecalho(nome, disposicao) {
  const limpo = String(nome).replace(/[\u0000-\u001f\u007f]/g, "");
  const ascii = limpo.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(limpo).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposicao}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
function politicaDoArquivo(reg, mime) {
  if (/^application\/pdf/i.test(mime)) return "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
  return "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
}

function servir(req, reg, arq, baixar) {
  const mime = comCharset(arq.mime || "application/octet-stream");
  const cab = { ...CABECALHOS_BASE, "Content-Type": mime, "Accept-Ranges": "bytes" };
  // Baixar: sem CSP (um "sandbox" na resposta faz o Chrome cancelar o download); o arquivo vai para o disco, não para uma página
  const csp = baixar ? null : politicaDoArquivo(reg, mime);
  if (csp) cab["Content-Security-Policy"] = csp;
  // o nome é o original do item (grupo) ou o do manifesto (versão 2 arquivo)
  cab["Content-Disposition"] = nomeParaCabecalho(arq.nomeItem ?? (reg.manifesto.tipo === "arquivo" ? reg.manifesto.nome : arq.caminho.split("/").pop()), baixar ? "attachment" : "inline");
  const total = arq.tamanho;
  const cabRange = req.headers.get("Range");
  let ini = 0, fim = total - 1, status = 200;
  if (cabRange && total > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(cabRange.trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      if (m[1] === "") { const n = Number(m[2]); ini = Math.max(0, total - n); fim = total - 1; if (n === 0) ini = total; }
      else { ini = Number(m[1]); fim = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1); }
      if (ini >= total || ini > fim) return new Response(null, { status: 416, headers: { ...cab, "Content-Range": `bytes */${total}` } });
      status = 206;
      cab["Content-Range"] = `bytes ${ini}-${fim}/${total}`;
    }
  }
  const tamanhoResposta = total === 0 ? 0 : fim - ini + 1;
  cab["Content-Length"] = String(tamanhoResposta);
  if (req.method === "HEAD" || total === 0) return new Response(null, { status, headers: cab });
  return new Response(fluxo(reg, arq, ini, fim), { status, headers: cab });
}

// Decide o que o endereço pede. Devolve {arquivo} | {redirecionar} | null (404)
function resolver(reg, restoBruto) {
  // restoBruto: o que vem depois de v/<id>/, ainda codificado, sem query
  const partesBrutas = restoBruto === "" ? [] : restoBruto.split("/");
  const terminaEmBarra = restoBruto === "" || restoBruto.endsWith("/");
  if (terminaEmBarra && partesBrutas.length) partesBrutas.pop();
  const partes = [];
  for (const p of partesBrutas) {
    let d;
    try { d = decodeURIComponent(p); } catch { return null; }
    if (!validarSegmento(d)) return null; // vazio (//), ".", "..", oculto, barra ou controle escondidos
    partes.push(d);
  }
  const caminho = partes.join("/");
  if (!terminaEmBarra) {
    if (reg.arquivos.has(caminho)) return { arquivo: reg.arquivos.get(caminho) };
    if (reg.pastas.has(caminho)) return { redirecionar: true }; // pasta sem a barra final: links relativos precisam dela
    return null;
  }
  if (!reg.pastas.has(caminho)) return null;
  const alvo = caminho === "" ? reg.entrada : `${caminho}/index.html`;
  return reg.arquivos.has(alvo) ? { arquivo: reg.arquivos.get(alvo) } : null; // sem listagem de pasta
}

async function responder(req, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return pagina(405, "Método não permitido", "Esta prévia só aceita leitura.");
  const resto = url.pathname.slice(PREFIXO.length);
  const barra = resto.indexOf("/");
  const id = barra < 0 ? resto : resto.slice(0, barra);
  if (!RE_ID.test(id)) return naoEncontrado();
  const r = await obterRegistro(id);
  if (r.vencido) return vencida();
  if (r.desconhecido) return semChave();
  const reg = r.reg;
  if (barra < 0) return Response.redirect(new URL(`${url.pathname}/${url.search}`, url).href, 302);
  const alvo = resolver(reg, resto.slice(barra + 1));
  if (!alvo) return naoEncontrado();
  if (alvo.redirecionar) return Response.redirect(new URL(`${url.pathname}/${url.search}`, url).href, 302);
  return servir(req, reg, alvo.arquivo, url.searchParams.get("baixar") === "1");
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil((async () => { try { await limparVencidas(); } catch {} await self.clients.claim(); })()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIXO)) return; // passa direto
  e.respondWith(responder(e.request, url).catch(() => pagina(500, "Não foi possível abrir", "Tente de novo em instantes.")));
});
// A página avisa quando guarda ou apaga uma chave, para o worker não usar uma cópia velha da memória
self.addEventListener("message", (e) => { const d = e.data; if (d && d.tipo === "esquecer" && RE_ID.test(d.id)) memoria.delete(d.id); });
