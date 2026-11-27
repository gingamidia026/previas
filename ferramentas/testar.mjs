// Teste do visualizador de prévias, sem gastar tokens: node ferramentas/testar.mjs
// Gera prévias cifradas de teste numa pasta temporária, sobe um servidor local que imita o GitHub Pages sob /previas/
// (com Range), abre o Chrome sem janela pelo protocolo DevTools (WebSocket nativo do Node, nada de npm) e confere.
// Imprime uma linha OK/FALHA por conferência e o total. Capturas em /tmp/claude-1000/previas-github/.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { cifrarArquivo, cifrarSite, cifrarGrupo, lerManifesto, novaPrevia, linkDaPrevia, decifrarParaTeste, TAMANHO_PEDACO } from "./cifra-previas.mjs";
import { limparVencidas } from "./limpar-vencidas.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(AQUI, "..", "site");
const SAIDA = "/tmp/claude-1000/previas-github";
const TMP = path.join(SAIDA, `trabalho-${process.pid}`);
const P = path.join(TMP, "p");
const ORIG = path.join(TMP, "originais");
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaArquivo = (f) => sha(fs.readFileSync(f));

// ---------------------------------------------------------------------------
// Placar
// ---------------------------------------------------------------------------
let ok = 0, falhas = 0;
function confere(nome, bom, detalhe = "") {
  if (bom) { ok++; console.log(`OK     ${nome}`); }
  else { falhas++; console.log(`FALHA  ${nome}${detalhe ? `  -> ${detalhe}` : ""}`); }
}

// ---------------------------------------------------------------------------
// Arquivos de teste
// ---------------------------------------------------------------------------
function pngChunk(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const t = Buffer.from(tipo); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, dados])) >>> 0);
  return Buffer.concat([len, t, dados, crc]);
}
// PNG RGB com degradê, moldura vermelha de 14 px (para ver se algo foi cortado) e uma faixa de ruído (para pesar alguns MB)
function criarPng(arquivo, w, h) {
  const linha = 1 + w * 3; const cru = Buffer.alloc(linha * h);
  let semente = 123456789;
  for (let y = 0; y < h; y++) {
    const o = y * linha; cru[o] = 0;
    const ruido = y > h * 0.3 && y < h * 0.4;
    for (let x = 0; x < w; x++) {
      let r = (x * 255 / w) | 0, g = (y * 255 / h) | 0, b = 120;
      if (ruido) { semente ^= semente << 13; semente ^= semente >>> 17; semente ^= semente << 5; r = semente & 255; g = (semente >>> 8) & 255; b = (semente >>> 16) & 255; }
      if (x < 14 || y < 14 || x >= w - 14 || y >= h - 14) { r = 230; g = 30; b = 40; }
      if (x > w * 0.45 && x < w * 0.55 && y > h * 0.45 && y < h * 0.55) { r = 242; g = 174; b = 48; } // quadrado do centro
      const p = o + 1 + x * 3; cru[p] = r; cru[p + 1] = g; cru[p + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(arquivo, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(cru, { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]));
}
function criarPdf(arquivo) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"];
  const fluxo = "BT /F1 28 Tf 60 760 Td (Prévia em PDF da Ginga Mídia) Tj ET";
  objs.push(`<< /Length ${fluxo.length} >>\nstream\n${fluxo}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let pdf = "%PDF-1.4\n"; const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${pos.map((p) => String(p).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(arquivo, Buffer.from(pdf, "latin1"));
}
function criarSite(pasta) {
  const w = (rel, txt) => { const f = path.join(pasta, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  w("index.html", `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site de teste</title>
<link rel="stylesheet" href="css/estilo.css?ver=6.4"><script src="js/app.js" defer></script></head>
<body><h1 id="titulo">Site de teste da Ginga</h1><p id="js-ok">js não rodou</p><img id="logo" src="img/logo.png" width="64" height="64" alt="logo">
<img id="externa" src="__EXTERNA__" width="8" height="8" alt="">
<img id="abs" src="/img/logo.png" width="8" height="8" alt=""><img id="srcset" srcset="img/logo.png 1x, img/logo.png 2x" width="8" height="8" alt="">
<div id="logo-css" style="width:20px;height:20px"></div><p id="extra">extra</p>
<nav><a id="ir-sobre" href="sobre/">Sobre</a> <a id="ir-pagina" href="pagina.html">Página</a> <a id="ir-sem-barra" href="sobre">Sobre sem barra</a>
<a id="externo" href="__LINK_EXTERNO__">Externo</a> <a id="ancora" href="#fim">Ir ao fim</a></nav>
<form id="busca" action="sobre/"><input name="q" value="x"><button id="enviar" type="submit">Buscar</button></form>
<pre id="sonda" style="white-space:pre-wrap;word-break:break-all">sonda não rodou</pre>
<div id="fim" style="margin-top:1500px">fim da página</div>
<script>
window.__marca = "mesma-pagina";
(async () => {
  const r = {};
  const t = async (n, f) => { try { r[n] = "PERMITIDO:" + String(await f()).slice(0, 40); } catch (e) { r[n] = "negado:" + ((e && e.name) || "erro"); } };
  await t("indexedDB", () => new Promise((ok, no) => { const q = indexedDB.open("ginga-previas"); q.onsuccess = () => ok("abriu"); q.onerror = () => no(q.error); }));
  await t("caches", () => caches.keys());
  await t("fetch", async () => (await fetch("__OUTRA__")).status);
  await t("parent.document", () => parent.document.title);
  await t("top.location", () => top.location.href);
  await t("localStorage", () => localStorage.length);
  await t("cookie", () => document.cookie);
  await t("serviceWorker", async () => { if (navigator.serviceWorker && navigator.serviceWorker.controller) return "controlado"; throw Object.assign(new Error("sem"), { name: "SemControle" }); });
  r.origem = self.origin;
  document.getElementById("sonda").textContent = JSON.stringify(r);
})();
</script></body></html>`);
  w("css/estilo.css", "@import url(\"extra.css\");body{background:rgb(10,100,50);color:rgb(250,250,250);font-family:sans-serif}#titulo{color:rgb(242,174,48)}#logo-css{background:url(../img/logo.png) no-repeat}");
  w("css/extra.css", "#extra{color:rgb(1,2,3)}");
  w("js/app.js", "document.getElementById('js-ok').textContent='js ok';");
  w("sobre/index.html", `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Sobre</title><link rel="stylesheet" href="../css/estilo.css"></head><body><h1 id="titulo">Sobre o site</h1><a id="voltar" href="../">Voltar</a></body></html>`);
  w("pagina.html", `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Página interna</title><link rel="stylesheet" href="css/estilo.css"></head><body><h1 id="titulo">Página interna</h1><a id="voltar" href="index.html">Início</a></body></html>`);
  w("vazia/arquivo.txt", "pasta sem index: não pode listar");
  w("páginas/olá.txt", "nome com acento dentro do .zip");
  w(".segredo", "arquivo oculto não entra");
  // PNG 64x64 laranja
  const l = 64; const cru = Buffer.alloc((1 + l * 3) * l);
  for (let y = 0; y < l; y++) for (let x = 0; x < l; x++) { const p = y * (1 + l * 3) + 1 + x * 3; cru[p] = 242; cru[p + 1] = 174; cru[p + 2] = 48; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(l, 0); ihdr.writeUInt32BE(l, 4); ihdr[8] = 8; ihdr[9] = 2;
  const f = path.join(pasta, "img", "logo.png"); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(cru)), pngChunk("IEND", Buffer.alloc(0))]));
}

// ---------------------------------------------------------------------------
// Servidor que imita o GitHub Pages em /previas/ (Range, cache de 10 min) + um servidor "de fora" para recurso externo
// ---------------------------------------------------------------------------
const MIME = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", json: "application/json", bin: "application/octet-stream", png: "image/png", ico: "image/x-icon" };
const registro = []; const bloqueados = new Set(); // ids que ainda dão 404 (prévia "chegando")
function servirArquivo(req, res, arquivo) {
  let st; try { st = fs.statSync(arquivo); if (!st.isFile()) throw 0; } catch { res.writeHead(404, { "Content-Type": "text/html" }); res.end("<h1>404</h1>"); return 404; }
  const tipo = MIME[path.extname(arquivo).slice(1)] || "application/octet-stream";
  const cab = { "Content-Type": tipo, "Cache-Control": "max-age=600", "Accept-Ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    const ini = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])); const fim = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...cab, "Content-Range": `bytes ${ini}-${fim}/${st.size}`, "Content-Length": fim - ini + 1 });
    fs.createReadStream(arquivo, { start: ini, end: fim }).pipe(res); return 206;
  }
  res.writeHead(200, { ...cab, "Content-Length": st.size }); fs.createReadStream(arquivo).pipe(res); return 200;
}
function ligarServidor() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x"); let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
    if (!rel.startsWith("/previas/")) { res.writeHead(404); res.end("fora de /previas/"); return; }
    rel = rel.slice("/previas/".length) || "index.html";
    let arquivo;
    const mp = /^p\/([A-Za-z0-9_-]{22})\/([^/]+)$/.exec(rel);
    if (mp) {
      registro.push({ id: mp[1], arq: mp[2], range: req.headers.range || null });
      if (bloqueados.has(mp[1])) { res.writeHead(404, { "Content-Type": "text/html" }); res.end("404"); return; }
      arquivo = path.join(P, mp[1], mp[2]);
    } else if (rel.includes("..") || rel.startsWith("p/")) { res.writeHead(404); res.end(); return; }
    else arquivo = path.join(SITE, rel);
    servirArquivo(req, res, arquivo);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function ligarExterno() {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]);
  const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

// ---------------------------------------------------------------------------
// Chrome pelo protocolo DevTools
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pendentes = new Map(); this.ouvintes = new Set();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pendentes.get(m.id); if (!p) return; this.pendentes.delete(m.id); clearTimeout(p.tempo); m.error ? p.erro(new Error(`${p.metodo}: ${m.error.message}`)) : p.ok(m.result); }
      else for (const f of this.ouvintes) f(m);
    });
  }
  enviar(metodo, params = {}, sessao) {
    return new Promise((ok, erro) => {
      const id = ++this.id;
      const tempo = setTimeout(() => { this.pendentes.delete(id); erro(new Error(`${metodo}: sem resposta em 40 s`)); }, 40_000);
      this.pendentes.set(id, { ok, erro, metodo, tempo });
      this.ws.send(JSON.stringify({ id, method: metodo, params, ...(sessao ? { sessionId: sessao } : {}) }));
    });
  }
}
let chrome, cdp, pastaChrome;
async function ligarChrome() {
  pastaChrome = fs.mkdtempSync(path.join(TMP, "chrome-"));
  for (const d of ["config", "cache", "dados", "estado"]) fs.mkdirSync(path.join(pastaChrome, "xdg-" + d), { recursive: true });
  chrome = spawn(process.env.CHROME || "google-chrome-stable", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(pastaChrome, "perfil")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--hide-scrollbars", "--disable-background-timer-throttling", "--disable-features=Translate", "about:blank"],
  { env: { ...process.env, XDG_CONFIG_HOME: path.join(pastaChrome, "xdg-config"), XDG_CACHE_HOME: path.join(pastaChrome, "xdg-cache"), XDG_DATA_HOME: path.join(pastaChrome, "xdg-dados"), XDG_STATE_HOME: path.join(pastaChrome, "xdg-estado") }, stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise((ok, erro) => {
    let texto = ""; const tempo = setTimeout(() => erro(new Error("o Chrome não abriu em 30 s")), 30_000);
    chrome.stderr.on("data", (d) => { texto += d; const m = texto.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(tempo); ok(m[1]); } });
    chrome.on("exit", () => erro(new Error("o Chrome fechou sozinho")));
  });
  const sock = new WebSocket(ws);
  await new Promise((ok, erro) => { sock.addEventListener("open", ok); sock.addEventListener("error", () => erro(new Error("sem conexão com o Chrome"))); });
  cdp = new Cdp(sock);
}
async function desligarChrome() {
  try { await cdp?.enviar("Browser.close"); } catch {}
  await dormir(300);
  try { chrome?.kill("SIGKILL"); } catch {}
}

const todosOsErros = []; // erros de console das abas que deveriam estar limpas
async function abrirAba({ w, h, mobile = false, pre = null, limpa = true, nome = "aba" }) {
  const { targetId } = await cdp.enviar("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.enviar("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.enviar(m, p, sessionId);
  const erros = []; const contextos = new Map(); const quadrosIsolados = new Map(); // iframes que o Chrome põe em processo separado (origem opaca) // contextos de execução (inclusive os do iframe isolado, que o DevTools alcança)
  cdp.ouvintes.add((m) => {
    if (m.sessionId !== sessionId && !quadrosIsolados.has(m.sessionId)) return; // a aba e os iframes isolados dela
    if (m.method === "Runtime.executionContextCreated") { const c = m.params.context; contextos.set(c.id, { frameId: c.auxData?.frameId, padrao: c.auxData?.isDefault, origem: c.origin }); }
    else if (m.method === "Runtime.executionContextDestroyed") contextos.delete(m.params.executionContextId);
    else if (m.method === "Runtime.executionContextsCleared") contextos.clear();
    else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
      quadrosIsolados.set(m.params.sessionId, m.params.targetInfo);
      for (const metodo of ["Runtime.enable", "Log.enable"]) cdp.enviar(metodo, {}, m.params.sessionId).catch(() => {}); // erros de console do site também contam
    }
    else if (m.method === "Target.detachedFromTarget") quadrosIsolados.delete(m.params.sessionId);
    if (m.method === "Runtime.exceptionThrown") erros.push(`exceção: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") erros.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    else if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url).endsWith("/favicon.ico")) erros.push(`log: ${m.params.entry.text} ${m.params.entry.url || ""}`);
  });
  await s("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  if (pre) await s("Page.addScriptToEvaluateOnNewDocument", { source: pre });
  const aba = {
    erros, nome,
    async ir(url) { await s("Page.navigate", { url }); await dormir(150); },
    async avaliar(expr) {
      const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    // Executa dentro do (último) iframe da página, mesmo com origem opaca: em processo separado (sessão própria) ou no mesmo processo (contexto)
    async noQuadro(expr) {
      const params = { expression: expr, awaitPromise: true, returnByValue: true };
      let r;
      // um iframe que está sendo trocado nunca responde: não esperar os 40 s do protocolo
      if (quadrosIsolados.size) r = await Promise.race([cdp.enviar("Runtime.evaluate", params, [...quadrosIsolados.keys()].pop()), dormir(4000).then(() => { throw new Error("iframe sem resposta"); })]);
      else {
        const { frameTree } = await s("Page.getFrameTree");
        const f = frameTree.childFrames?.[0]?.frame.id; if (!f) throw new Error("sem iframe");
        const achados = [...contextos.entries()].filter(([, c]) => c.frameId === f && c.padrao);
        if (!achados.length) throw new Error("sem contexto do iframe");
        r = await s("Runtime.evaluate", { ...params, contextId: achados[achados.length - 1][0] });
      }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async ateNoQuadro(expr, ms = 15_000, passo = 120) {
      const fim = Date.now() + ms; let v;
      while (Date.now() < fim) { try { v = await aba.noQuadro(expr); if (v) return v; } catch {} await dormir(passo); }
      return false;
    },
    async clicarNoQuadro(seletor) {
      const r = await aba.noQuadro(`(() => { const e = document.querySelector(${JSON.stringify(seletor)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!r) throw new Error(`sem ${seletor} no iframe`);
      // o iframe fica embaixo do painel: soma o deslocamento dele na página
      const off = await aba.avaliar(`(() => { const b = document.getElementById('quadro-site').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
      r.x += off.x; r.y += off.y;
      for (const tipo of ["mouseMoved", "mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type: tipo, x: r.x, y: r.y, button: "left", clickCount: 1 });
    },
    esperados: [], // filtros de erros de console esperados nesta aba
    async ate(expr, ms = 15_000, passo = 120) {
      const fim = Date.now() + ms; let v;
      while (Date.now() < fim) { try { v = await aba.avaliar(expr); if (v) return v; } catch {} await dormir(passo); }
      return false;
    },
    async tecla(nome, codigo) { for (const tipo of ["keyDown", "keyUp"]) await s("Input.dispatchKeyEvent", { type: tipo, key: nome, code: codigo || nome, windowsVirtualKeyCode: nome === "Escape" ? 27 : 0 }); },
    async clicarEm(x, y) { await aba.quadros(); for (const tipo of ["mouseMoved", "mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type: tipo, x, y, button: "left", clickCount: 1 }); },
    async captura(arquivo) { const r = await s("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(arquivo, Buffer.from(r.data, "base64")); },
    // espera dois quadros desenhados: o Chrome sem janela só atualiza os dados de clique (iframe isolado, janela por cima) quando desenha
    async quadros() { await aba.avaliar(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(1))))`).catch(() => {}); await dormir(60); },
    async clicar(seletor) {
      await aba.quadros();
      const r = await aba.avaliar(`(() => { const e = document.querySelector(${JSON.stringify(seletor)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!r) throw new Error(`sem ${seletor}`);
      for (const tipo of ["mouseMoved", "mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type: tipo, x: r.x, y: r.y, button: "left", clickCount: 1 });
    },
    // pedidos de propósito errados (404/410/416): o erro que o Chrome registra por causa deles não conta
    async sonda(fn) { const n = erros.length; const r = await fn(); await dormir(250); erros.length = n; return r; },
    async fechar() { await cdp.enviar("Target.closeTarget", { targetId }); },
  };
  if (limpa) todosOsErros.push(aba);
  return aba;
}

async function baixarComClique(aba, seletor) {
  const pasta = fs.mkdtempSync(path.join(TMP, "baixados-"));
  await cdp.enviar("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: pasta, eventsEnabled: true });
  const pronto = new Promise((ok) => {
    const f = (m) => { if (m.method === "Browser.downloadProgress" && m.params.state === "completed") { cdp.ouvintes.delete(f); ok(true); } else if (m.method === "Browser.downloadProgress" && m.params.state === "canceled") { cdp.ouvintes.delete(f); ok(false); } };
    cdp.ouvintes.add(f);
  });
  await aba.clicar(seletor);
  const terminou = await Promise.race([pronto, dormir(60_000).then(() => false)]);
  const arquivos = fs.readdirSync(pasta);
  if (!terminou) {
    console.log("# download não terminou:", seletor, arquivos);
  }
  return { terminou, arquivos, pasta };
}

// ---------------------------------------------------------------------------
// Medidas dentro da página
// ---------------------------------------------------------------------------
const MEDIR = `(() => {
  const m = document.getElementById('midia'); if (!m) return { semMidia: true };
  const r = m.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  let nw = 0, nh = 0; if (m.tagName === 'IMG') { nw = m.naturalWidth; nh = m.naturalHeight; } else if (m.tagName === 'VIDEO') { nw = m.videoWidth; nh = m.videoHeight; }
  let pint = { x: r.left, y: r.top, w: r.width, h: r.height };
  if (nw && nh) { const e = Math.min(r.width / nw, r.height / nh), w = nw * e, h = nh * e; pint = { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h }; }
  const pts = [[.5, .5], [3, 3], [r.width - 3, 3], [3, r.height - 3], [r.width - 3, r.height - 3]].map(([x, y]) => {
    const px = x <= 1 ? r.left + x * r.width : r.left + x, py = x <= 1 ? r.top + y * r.height : r.top + y;
    return document.elementFromPoint(px, py) === m; });
  const caixa = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const d = document.documentElement;
  return { tag: m.tagName, vw, vh, rect: { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }, pint, nw, nh, pts,
    rolagem: { sw: d.scrollWidth, sh: d.scrollHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight, y: scrollY, x: scrollX },
    cab: caixa('.cabecalho'), rod: caixa('.rodape'), baixar: caixa('#baixar'), nome: document.querySelector('.cabecalho h1')?.textContent,
    rodTexto: document.querySelector('.rodape')?.textContent, temIcone: !!document.querySelector('#baixar svg'), baixarTexto: document.querySelector('#baixar')?.textContent.trim(),
    baixarEstilo: (() => { const e = document.querySelector('#baixar'); if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, cor: c.color }; })() };
})()`;
const cruza = (a, b) => a && b && a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;

function conferirMidia(rotulo, med, { preencher = true } = {}) {
  if (med.semMidia) { confere(`${rotulo}: mídia apareceu`, false); return; }
  const E = 0.6, r = med.rect, p = med.pint;
  confere(`${rotulo}: mídia inteira dentro da janela (${Math.round(r.w)}x${Math.round(r.h)} em ${med.vw}x${med.vh})`,
    r.x >= -E && r.y >= -E && r.r <= med.vw + E && r.b <= med.vh + E && p.x >= -E && p.y >= -E && p.x + p.w <= med.vw + E && p.y + p.h <= med.vh + E);
  confere(`${rotulo}: sem rolagem`, med.rolagem.sh <= med.vh && med.rolagem.sw <= med.vw && med.rolagem.bh <= med.vh && med.rolagem.y === 0 && med.rolagem.x === 0, JSON.stringify(med.rolagem));
  if (preencher) confere(`${rotulo}: mídia aproveita a tela (não fica minúscula)`, p.w >= r.w * 0.97 || p.h >= r.h * 0.97, `${Math.round(p.w)}x${Math.round(p.h)} em ${Math.round(r.w)}x${Math.round(r.h)}`);
  confere(`${rotulo}: nada sobrepõe a mídia (centro e quatro cantos)`, med.pts.every(Boolean), JSON.stringify(med.pts));
  confere(`${rotulo}: cabeçalho, rodapé e botão fora da mídia`, !cruza(med.cab, r) && !cruza(med.rod, r) && !cruza(med.baixar, r) && med.cab.b <= r.y + E && med.rod.y >= r.b - E);
  confere(`${rotulo}: cabeçalho com o nome e rodapé com o prazo`, !!med.nome && /^Prévia enviada pela Ginga Mídia · disponível até \d\d\/\d\d\/\d{4} às \d\d:\d\d$/.test(med.rodTexto), `${med.nome} | ${med.rodTexto}`);
  confere(`${rotulo}: botão Baixar visível, com ícone, dentro da janela`, !!med.baixar && med.baixar.w >= 80 && med.baixar.h >= 40 && med.baixar.r <= med.vw + E && med.baixar.b <= med.vh + E && med.temIcone && med.baixarTexto === "Baixar", JSON.stringify(med.baixar));
}

async function abrirLink(aba, base, link) { await aba.ir(`${base}${link}`); }

// ---------------------------------------------------------------------------
// Painel superior e janela de compartilhamento
// ---------------------------------------------------------------------------
const PAINEL = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  return { h1: q('.cabecalho h1')?.textContent, h1r: r(q('.cabecalho h1')), baixar: r(q('#baixar')), comp: r(q('#compartilhar')), cab: r(q('.cabecalho')),
    aria: q('#compartilhar')?.getAttribute('aria-label'), title: q('#compartilhar')?.title, rotuloVisivel: q('#compartilhar .rotulo') ? getComputedStyle(q('#compartilhar .rotulo')).display !== 'none' : null,
    corBaixar: q('#baixar') ? getComputedStyle(q('#baixar')).backgroundColor : null, sw: document.documentElement.scrollWidth, vw: innerWidth };
})()`;
function conferirPainel(rotulo, p, nome, vw) {
  const E = 0.6;
  const ok = !!(p.h1r && p.baixar && p.comp);
  confere(`${rotulo}: painel com o nome do item, Baixar e Compartilhamento, da esquerda para a direita`, ok && p.h1 === nome && p.h1r.r <= p.baixar.x + E && p.baixar.r <= p.comp.x + E, JSON.stringify(p));
  confere(`${rotulo}: painel com alvos de 44 px, dentro da janela, sem rolagem lateral e Baixar em amarelo`, ok && p.baixar.h >= 44 && p.comp.w >= 44 && p.comp.h >= 44 && p.comp.r <= vw + E && p.baixar.r <= vw + E && p.sw <= vw && p.corBaixar === "rgb(242, 174, 48)", JSON.stringify(p));
  confere(`${rotulo}: Compartilhamento com aria-label e title (${vw >= 640 ? "com rótulo visível" : "só o ícone no celular"}); nome em uma linha`,
    ok && /Compartilhamento/.test(p.aria) && /Compartilhamento/.test(p.title) && p.rotuloVisivel === (vw >= 640) && p.h1r.h < 30, JSON.stringify(p));
}
const JANELA = `(() => {
  const d = document.getElementById('janela-compartilhar'); if (!d) return null;
  const caixa = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const itens = [...d.querySelectorAll('.janela-lista li')].map((li) => { const a = li.querySelector('a'); return { nome: li.querySelector('.item-nome').textContent, meta: li.querySelector('.item-meta').textContent, atual: a.hasAttribute('aria-current'), href: a.getAttribute('href'), h: a.getBoundingClientRect().height }; });
  const botoes = [...d.querySelectorAll('button, a.botao-nav')].map((b) => ({ id: b.id, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, dis: !!b.disabled, href: b.getAttribute('href') }));
  return { aberto: d.open, modal: d.matches(':modal'), foco: d.contains(document.activeElement), titulo: d.querySelector('h2').textContent, explicacao: d.querySelector('.janela-texto').textContent,
    quantos: document.getElementById('janela-quantos').textContent, validade: document.getElementById('janela-validade').textContent, posicao: document.getElementById('item-posicao')?.textContent || null,
    itens, botoes, rect: caixa(d), vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, html: d.outerHTML };
})()`;
const RE_META = /^(Imagem|Vídeo|Áudio|PDF|Site|Arquivo) · \d[\d.,]* (bytes|KB|MB|GB)$/;
// Abre a janela e confere. esp: { nomes, tipos, atual }. Devolve as medidas.
async function abrirJanela(aba, rotulo, esp, chave) {
  await aba.clicar("#compartilhar");
  await aba.ate(`document.getElementById('janela-compartilhar')?.open`, 5000);
  const j = await aba.avaliar(JANELA); const E = 0.6, total = esp.nomes.length;
  confere(`${rotulo}: janela abre como modal, com o foco dentro dela e o título “Prévia compartilhada pela Ginga Mídia”`, j && j.aberto && j.modal && j.foco && j.titulo === "Prévia compartilhada pela Ginga Mídia", JSON.stringify({ a: j?.aberto, m: j?.modal, f: j?.foco, t: j?.titulo }));
  confere(`${rotulo}: explica o link único, a chave no próprio link (nunca no GitHub), o conteúdo cifrado, a validade e quantos itens há`,
    /um link só/.test(j.explicacao) && /dentro do próprio link/.test(j.explicacao) && /nunca vai ao GitHub/.test(j.explicacao) && /cifrado/.test(j.explicacao)
    && /^O link vale até \d\d\/\d\d\/\d{4} às \d\d:\d\d\./.test(j.validade) && j.quantos === (total === 1 ? "Este link compartilha 1 item." : `Este link compartilha ${total} itens.`), JSON.stringify([j.explicacao, j.validade, j.quantos]));
  confere(`${rotulo}: lista com os ${total} itens (nome, tipo e tamanho) e só o item ${esp.atual + 1} marcado com aria-current`,
    j.itens.length === total && j.itens.every((it, k) => it.nome === esp.nomes[k] && it.meta.startsWith(esp.tipos[k] + " · ") && RE_META.test(it.meta) && it.atual === (k === esp.atual)), JSON.stringify(j.itens));
  confere(`${rotulo}: cada item aponta para ?p=<id>&n=<k>`, j.itens.every((it, k) => new RegExp(`\\?p=[A-Za-z0-9_-]{22}&n=${k}$`).test(it.href) && !it.href.includes(chave)), JSON.stringify(j.itens.map((i) => i.href)));
  confere(`${rotulo}: alvos de toque de 44 px (itens e botões) e janela dentro da tela, sem rolagem lateral`,
    j.itens.every((it) => it.h >= 44) && j.botoes.every((b) => b.h >= 44 && b.w >= 44) && j.rect.x >= -E && j.rect.y >= -E && j.rect.r <= j.vw + E && j.rect.b <= j.vh + E && j.sw <= j.vw, JSON.stringify([j.rect, j.botoes, j.sw, j.vw]));
  if (total > 1) {
    const ant = j.botoes.find((b) => b.id === "item-anterior"), prox = j.botoes.find((b) => b.id === "item-proximo");
    confere(`${rotulo}: Anterior e Próximo (${esp.atual + 1} de ${total}), desligados nas pontas`, !!ant && !!prox && j.posicao === `${esp.atual + 1} de ${total}` && ant.dis === (esp.atual === 0) && prox.dis === (esp.atual === total - 1) && (esp.atual === 0 || ant.href.endsWith(`&n=${esp.atual - 1}`)) && (esp.atual === total - 1 || prox.href.endsWith(`&n=${esp.atual + 1}`)), JSON.stringify([j.posicao, ant, prox]));
  } else confere(`${rotulo}: com um item só não há Anterior nem Próximo`, !j.botoes.some((b) => /^item-/.test(b.id)) && j.posicao === null);
  // a chave não pode aparecer na janela, na página, na barra de endereço nem no armazenamento da página
  const vaza = await aba.avaliar(`(() => { const c = ${JSON.stringify(chave)}; return { janela: ${JSON.stringify(j.html)}.includes(c), pagina: document.documentElement.outerHTML.includes(c), url: location.href.includes(c) || location.hash !== '', local: JSON.stringify({ ...localStorage }).includes(c), sessao: JSON.stringify({ ...sessionStorage }).includes(c) }; })()`);
  confere(`${rotulo}: a chave NÃO aparece no HTML da janela, da página, na URL nem em localStorage/sessionStorage`, !Object.values(vaza).some(Boolean), JSON.stringify(vaza));
  return j;
}
async function janelaFechada(aba) { return aba.avaliar(`!document.getElementById('janela-compartilhar').open && document.activeElement?.id === 'compartilhar'`); }

function conferirZip(rotulo, zip, nomeEsperado, pastaSite) {
  const esperados = []; const varrer = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) varrer(path.join(d, e.name), rel); else esperados.push(rel); } };
  varrer(pastaSite, "");
  const t = spawnSync("unzip", ["-t", zip], { encoding: "utf8" });
  confere(`${rotulo}: unzip -t aprova o .zip`, t.status === 0 && /No errors detected/.test(t.stdout), (t.stdout + t.stderr).slice(-300));
  const py = spawnSync("python3", ["-I", "-c", `import zipfile, sys, json, hashlib, os
z = zipfile.ZipFile(sys.argv[1]); raiz = sys.argv[2]
r = {"teste": z.testzip(), "nomes": sorted(z.namelist()), "metodos": sorted({i.compress_type for i in z.infolist()}), "utf8": all(i.flag_bits & 0x800 for i in z.infolist()), "iguais": True}
for i in z.infolist():
    if hashlib.sha256(z.read(i)).digest() != hashlib.sha256(open(os.path.join(raiz, *i.filename.split("/")), "rb").read()).digest(): r["iguais"] = False
print(json.dumps(r))`, zip, pastaSite], { encoding: "utf8" });
  let r = {}; try { r = JSON.parse(py.stdout); } catch {}
  confere(`${rotulo}: zipfile do Python lê sem erro, sem compressão (método 0), nomes em UTF-8 e conteúdo idêntico (SHA-256) aos originais`, r.teste === null && JSON.stringify(r.metodos) === "[0]" && r.utf8 === true && r.iguais === true, py.stdout + py.stderr);
  confere(`${rotulo}: o .zip tem exatamente os arquivos do site (${esperados.length}, com “páginas/olá.txt”, sem o oculto .segredo)`, JSON.stringify(r.nomes) === JSON.stringify([...esperados].sort()) && r.nomes.includes("páginas/olá.txt") && !r.nomes.some((n) => n.includes(".segredo")), JSON.stringify(r.nomes));
}
const fragSumiu = (aba, chave) => aba.avaliar(`location.hash === '' && !location.href.includes(${JSON.stringify(chave)})`);

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
async function principal() {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(ORIG, { recursive: true }); fs.mkdirSync(P, { recursive: true });
  const agora = Date.now(), DIA = 24 * 3600 * 1000;
  const NOME_RETRATO = "Foto retrato é grande.png";

  // 1. Originais e prévias cifradas
  const retrato = path.join(ORIG, NOME_RETRATO), paisagem = path.join(ORIG, "paisagem.png"), pdf = path.join(ORIG, "proposta.pdf"), video = path.join(ORIG, "vídeo de teste.mp4"), siteDir = path.join(ORIG, "site");
  const t0 = Date.now();
  criarPng(retrato, 3000, 5000); criarPng(paisagem, 4000, 2250); criarPdf(pdf);
  console.log(`# PNG retrato ${(fs.statSync(retrato).size / 1048576).toFixed(1)} MiB e paisagem ${(fs.statSync(paisagem).size / 1048576).toFixed(1)} MiB (${Date.now() - t0} ms)`);
  let temVideo = false;
  if (spawnSync("ffmpeg", ["-version"]).status === 0) {
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12",
      "-vf", "noise=alls=35:allf=t", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "16M", "-maxrate", "16M", "-bufsize", "32M", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-movflags", "+faststart", video]);
    temVideo = r.status === 0 && fs.existsSync(video);
    if (!temVideo) console.log(`# ffmpeg não gerou o vídeo: ${r.stderr}`);
  }
  if (temVideo) console.log(`# vídeo ${(fs.statSync(video).size / 1048576).toFixed(1)} MiB`);
  const servEx = await ligarExterno(); const portaEx = servEx.address().port;
  criarSite(siteDir);
  fs.writeFileSync(path.join(siteDir, "index.html"), fs.readFileSync(path.join(siteDir, "index.html"), "utf8").replace("__EXTERNA__", `http://127.0.0.1:${portaEx}/fora.png`).replace("__LINK_EXTERNO__", `http://127.0.0.1:${portaEx}/destino-externo`));

  const prev = {};
  const fazer = async (nome, tipo, opc) => {
    const { id, chave } = novaPrevia(); prev[nome] = { id, chave };
    const comum = { destino: P, id, chave, expira: opc.expira ?? agora + 3 * DIA };
    if (tipo === "arquivo") await cifrarArquivo({ ...comum, arquivo: opc.arquivo });
    else prev[nome].ignorados = (await cifrarSite({ ...comum, pasta: opc.arquivo, nome: "Site de teste" })).ignorados;
  };
  await fazer("retrato", "arquivo", { arquivo: retrato });
  await fazer("paisagem", "arquivo", { arquivo: paisagem });
  await fazer("pdf", "arquivo", { arquivo: pdf });
  if (temVideo) await fazer("video", "arquivo", { arquivo: video });
  // o script do site tenta ler uma prévia de OUTRO id (a paisagem, que o navegador do teste abre antes e deixa decifrável)
  fs.writeFileSync(path.join(siteDir, "index.html"), fs.readFileSync(path.join(siteDir, "index.html"), "utf8").replace("__OUTRA__", `/previas/v/${prev.paisagem.id}/paisagem.png`));
  await fazer("site", "site", { arquivo: siteDir });
  // Grupos (manifesto versão 3): 2 imagens + 1 PDF + 1 site, e outro com vídeo
  const um = path.join(ORIG, "um.png"), dois = path.join(ORIG, "dois.png");
  criarPng(um, 800, 1200); criarPng(dois, 1200, 800);
  const NOMES_GRUPO = ["Foto um é bonita.png", "Site de teste", "proposta.pdf", "Foto dois com um nome muito comprido para conferir a quebra de linha na lista da janela e a reticência no painel do topo.png"];
  const TIPOS_GRUPO = ["Imagem", "Site", "PDF", "Imagem"];
  {
    const { id, chave } = novaPrevia(); prev.grupo = { id, chave };
    await cifrarGrupo({ destino: P, id, chave, nome: "Grupo de teste", expira: agora + 3 * DIA, itens: [
      { tipo: "arquivo", arquivo: um, nome: NOMES_GRUPO[0] }, { tipo: "site", pasta: siteDir, entrada: "index.html", nome: NOMES_GRUPO[1] },
      { tipo: "arquivo", arquivo: pdf, nome: NOMES_GRUPO[2] }, { tipo: "arquivo", arquivo: dois, nome: NOMES_GRUPO[3] }] });
    if (temVideo) {
      const g2 = novaPrevia(); prev.grupoVideo = g2;
      await cifrarGrupo({ destino: P, ...g2, nome: "Grupo com vídeo", expira: agora + 3 * DIA, itens: [{ tipo: "arquivo", arquivo: video, nome: "vídeo de teste.mp4" }, { tipo: "arquivo", arquivo: um, nome: "Foto um é bonita.png" }] });
    }
  }
  await fazer("vencida", "arquivo", { arquivo: pdf, expira: agora - 60_000 });
  await fazer("chegando", "arquivo", { arquivo: paisagem });
  await fazer("soExpiraJson", "arquivo", { arquivo: pdf });
  prev.chaveErrada = { id: prev.paisagem.id, chave: novaPrevia().chave };
  prev.inexistente = novaPrevia();
  // expira.json vencido e manifesto ainda válido (o prazo vale pelo menor dos dois)
  fs.writeFileSync(path.join(P, prev.soExpiraJson.id, "expira.json"), JSON.stringify({ expira: agora - 1000 }));
  bloqueados.add(prev.chegando.id);
  confere("cifra: arquivo oculto do site não foi cifrado", prev.site.ignorados.some((i) => i.caminho === ".segredo"));

  // 2. Cifra: decifrar de volta é idêntico; limpeza de vencidas
  {
    const saida = path.join(TMP, "decifrado"); const m = await decifrarParaTeste({ destino: P, id: prev.retrato.id, chave: prev.retrato.chave, saida });
    confere("cifra: decifrarParaTeste devolve o PNG idêntico (SHA-256)", shaArquivo(path.join(saida, m.entrada)) === shaArquivo(retrato));
    const idsDoRetrato = fs.readdirSync(path.join(P, prev.retrato.id));
    confere(`cifra: pedaços de 1 MiB (${m.arquivos[0].pedacos} pedaços) e nomes p/<id>/m.bin, expira.json, 0-<n>.bin`, m.arquivos[0].pedacos === Math.ceil(m.arquivos[0].tamanho / TAMANHO_PEDACO) && idsDoRetrato.includes("m.bin") && idsDoRetrato.includes("expira.json") && idsDoRetrato.includes("0-0.bin"));
    const copia = path.join(TMP, "p-limpeza"); fs.mkdirSync(path.join(copia, "semprazo"), { recursive: true }); fs.cpSync(path.join(P, prev.vencida.id), path.join(copia, prev.vencida.id), { recursive: true });
    fs.cpSync(path.join(P, prev.retrato.id), path.join(copia, prev.retrato.id), { recursive: true }); fs.writeFileSync(path.join(copia, ".gitkeep"), "");
    fs.mkdirSync(path.join(copia, "lixo")); fs.writeFileSync(path.join(copia, "lixo", "expira.json"), "{quebrado");
    const r = limparVencidas(copia, { agora });
    confere("limpeza: apaga vencida, sem expira.json e expira.json quebrado; mantém a válida e o .gitkeep",
      r.apagadas.length === 3 && fs.existsSync(path.join(copia, prev.retrato.id)) && !fs.existsSync(path.join(copia, prev.vencida.id)) && !fs.existsSync(path.join(copia, "semprazo")) && fs.existsSync(path.join(copia, ".gitkeep")), JSON.stringify(r));
  }

  // 3. Servidor e Chrome
  const srv = await ligarServidor(); const porta = srv.address().port;
  const BASE = `http://127.0.0.1:${porta}/previas/`;
  const link = (n) => `#${prev[n].id}.${prev[n].chave}`;
  await ligarChrome();
  try {
    const salvar = (nome, w) => path.join(SAIDA, `${nome}-${w}.png`);
    const viewports = [{ w: 390, h: 844, mobile: true }, { w: 1440, h: 900, mobile: false }];

    // 3a. Imagens retrato e paisagem, nos dois tamanhos de tela (e celular deitado)
    for (const [nome, rot, orig] of [["retrato", "imagem retrato 3000x5000", retrato], ["paisagem", "imagem paisagem 4000x2250", paisagem]]) {
      for (const vp of [...viewports, { w: 844, h: 390, mobile: true }]) {
        const aba = await abrirAba({ ...vp, nome: `${nome}-${vp.w}` });
        await abrirLink(aba, BASE, link(nome));
        const pronto = await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 25_000);
        confere(`${rot} ${vp.w}x${vp.h}: abre e carrega`, !!pronto);
        if (pronto) {
          await dormir(200);
          conferirMidia(`${rot} ${vp.w}x${vp.h}`, await aba.avaliar(MEDIR));
          if (nome === "retrato" && vp.w !== 844) await aba.captura(salvar("imagem-retrato", vp.w));
          if (vp.w === 390 && nome === "retrato") {
            confere("fragmento (#id.chave) some da barra de endereço", await fragSumiu(aba, prev.retrato.chave));
            const usaWorker = await aba.avaliar(`!!navigator.serviceWorker.controller`);
            confere("imagem veio do service worker (caminho virtual /v/<id>/)", usaWorker && (await aba.avaliar(`document.getElementById('midia').currentSrc`)).includes("/previas/v/"));
          }
        }
        if (vp.w === 1440 && nome === "retrato") {
          // Baixar: arquivo original, nome original, mesmo SHA-256
          const d = await baixarComClique(aba, "#baixar");
          const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
          confere(`imagem retrato: Baixar entrega o original (nome "${f}", SHA-256 igual)`, d.terminou && f === NOME_RETRATO && shaArquivo(path.join(d.pasta, f)) === shaArquivo(orig), JSON.stringify(d.arquivos));
        }
        await aba.fechar();
      }
    }

    // 3b. Recarregar depois que o fragmento sumiu (chave guardada no navegador)
    {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, nome: "recarregar" });
      await abrirLink(aba, BASE, link("paisagem"));
      await aba.ate(`document.getElementById('midia')`);
      await aba.avaliar(`location.reload()`).catch(() => {});
      confere("recarregar a página (sem o fragmento) ainda abre a prévia", !!(await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 15_000)));
      await aba.fechar();
    }

    // 3c. PDF
    {
      for (const vp of viewports) {
        const aba = await abrirAba({ ...vp, nome: `pdf-${vp.w}` });
        await abrirLink(aba, BASE, link("pdf"));
        const pronto = await aba.ate(`document.getElementById('midia') && document.getElementById('midia').tagName === 'IFRAME'`);
        confere(`PDF ${vp.w}x${vp.h}: abre num quadro`, !!pronto);
        if (pronto) { await dormir(500); conferirMidia(`PDF ${vp.w}x${vp.h}`, await aba.avaliar(MEDIR), { preencher: false }); }
        if (vp.w === 1440) {
          const r = await aba.avaliar(`(async () => { const u = document.getElementById('baixar').href; const r = await fetch(u); const b = await r.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); return { tipo: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), sha: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') }; })()`);
          confere("PDF: o caminho virtual entrega o PDF original (SHA-256) com tipo application/pdf e anexo ao baixar", r.sha === shaArquivo(pdf) && r.tipo === "application/pdf" && /^attachment;.*proposta\.pdf/.test(r.disp), JSON.stringify(r));
        }
        await aba.fechar();
      }
    }

    // 3d. Vídeo
    if (temVideo) {
      const orig = fs.readFileSync(video); const pedacos = Math.ceil(orig.length / TAMANHO_PEDACO);
      for (const vp of [...viewports, { w: 844, h: 390, mobile: true }]) {
        const aba = await abrirAba({ ...vp, nome: `video-${vp.w}` });
        registro.length = 0;
        await abrirLink(aba, BASE, link("video"));
        const meta = await aba.ate(`(() => { const v = document.getElementById('midia'); return v && v.tagName === 'VIDEO' && v.readyState >= 1 && v.videoWidth > 0; })()`, 25_000);
        confere(`vídeo ${vp.w}x${vp.h}: abre com metadados`, !!meta);
        if (!meta) { await aba.fechar(); continue; }
        const med = await aba.avaliar(MEDIR);
        conferirMidia(`vídeo ${vp.w}x${vp.h}`, med);
        if (vp.w === 390 || vp.w === 1440) {
          const atrib = await aba.avaliar(`(() => { const v = document.getElementById('midia'); return { controls: v.controls, playsinline: v.hasAttribute('playsinline') }; })()`);
          if (vp.w === 390) confere("vídeo: com controles e playsinline", atrib.controls && atrib.playsinline, JSON.stringify(atrib));
        }
        if (vp.w === 1440) {
          // toca sem baixar o arquivo inteiro antes
          await aba.avaliar(`document.getElementById('midia').play().catch(() => {})`);
          const tocou = await aba.ate(`(() => { const v = document.getElementById('midia'); return v.currentTime > 0.4 && !v.paused; })()`, 20_000);
          const baixados = new Set(registro.filter((r) => r.arq.endsWith(".bin") && r.arq.startsWith("0-")).map((r) => r.arq)).size;
          confere(`vídeo: começa a tocar sem baixar tudo antes (${baixados} de ${pedacos} pedaços pedidos)`, !!tocou && baixados < pedacos, `${baixados}/${pedacos}`);
          await aba.captura(salvar("video", vp.w));
          // Range direto no caminho virtual: fatia cruzando fronteira de pedaço, final aberto, sufixo e fora do intervalo
          const base = await aba.avaliar(`document.getElementById('midia').currentSrc`);
          const fat = async (cab) => aba.avaliar(`(async () => { const r = await fetch(${JSON.stringify(base)}, { headers: { Range: ${JSON.stringify(cab)} } }); const b = await r.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); return { s: r.status, cr: r.headers.get('content-range'), n: b.byteLength, sha: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') }; })()`);
          const r1 = await aba.sonda(() => fat(`bytes=${TAMANHO_PEDACO - 1000}-${TAMANHO_PEDACO + 1999}`));
          confere("Range cruzando a fronteira de pedaço: 206, Content-Range e bytes iguais ao original", r1.s === 206 && r1.n === 3000 && r1.cr === `bytes ${TAMANHO_PEDACO - 1000}-${TAMANHO_PEDACO + 1999}/${orig.length}` && r1.sha === sha(orig.subarray(TAMANHO_PEDACO - 1000, TAMANHO_PEDACO + 2000)), JSON.stringify(r1));
          const [r2, r3, r4] = await aba.sonda(async () => [await fat(`bytes=${orig.length - 500}-`), await fat("bytes=-777"), await fat(`bytes=${orig.length + 10}-`)]);
          confere("Range final aberto, sufixo e fora do intervalo (416)", r2.s === 206 && r2.n === 500 && r2.sha === sha(orig.subarray(orig.length - 500)) && r3.s === 206 && r3.n === 777 && r3.sha === sha(orig.subarray(orig.length - 777)) && r4.s === 416, JSON.stringify([r2, r3, r4]));
          // Baixar o original
          const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
          confere(`vídeo: Baixar entrega o original (nome "${f}", SHA-256 igual)`, d.terminou && f === path.basename(video) && shaArquivo(path.join(d.pasta, f)) === sha(orig), JSON.stringify(d.arquivos));
        }
        if (vp.w === 390) await aba.captura(salvar("video", 390));
        await aba.fechar();
      }
      // Pular para o meio ANTES de tocar, numa prévia ainda sem pedaços na memória do service worker
      {
        await fazer("video2", "arquivo", { arquivo: video });
        const aba = await abrirAba({ w: 1440, h: 900, nome: "video-pulo" });
        registro.length = 0;
        await abrirLink(aba, BASE, link("video2"));
        await aba.ate(`(() => { const v = document.getElementById('midia'); return v && v.tagName === 'VIDEO' && v.readyState >= 1 && v.videoWidth > 0; })()`, 25_000);
        registro.length = 0;
        const alvo = await aba.avaliar(`(() => { const v = document.getElementById('midia'); v.currentTime = v.duration * 0.6; v.play().catch(() => {}); return v.duration * 0.6; })()`);
        const pulou = await aba.ate(`(() => { const v = document.getElementById('midia'); return !v.seeking && v.currentTime >= ${alvo} && !v.paused && v.readyState >= 3; })()`, 20_000);
        const t = await aba.avaliar(`document.getElementById('midia').currentTime`);
        const pedidos = [...new Set(registro.filter((r) => r.arq.startsWith("0-")).map((r) => Number(r.arq.match(/0-(\d+)/)[1])))].sort((x, y) => x - y);
        confere(`vídeo: pula para o meio antes de tocar (currentTime ${t.toFixed(2)} s, alvo ${alvo.toFixed(1)} s) e toca de lá`, !!pulou && t > alvo, `t=${t}`);
        confere(`vídeo: o pulo buscou só pedaços do meio, sem baixar o arquivo inteiro (pedidos ${pedidos.join(",")} de ${pedacos})`, pedidos.length > 0 && pedidos.length < pedacos && !pedidos.includes(0) || (pedidos.length < pedacos && pedidos.some((p) => p >= pedacos * 0.45)), `pedidos=${pedidos}`);
        await aba.fechar();
      }
    } else console.log("# sem ffmpeg: testes de vídeo pulados");

    // 3e. Fallback sem service worker (Blob inteiro com barra de progresso)
    {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, pre: "window.__PREVIAS_TESTE = { semSW: true };", nome: "sem-sw" });
      await abrirLink(aba, BASE, link("retrato"));
      const viuProgresso = await aba.ate(`document.getElementById('progresso') || document.getElementById('midia')`, 15_000);
      const pronto = await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 25_000);
      confere("sem service worker: mostra a imagem pelo Blob inteiro (e a barra de progresso existiu)", !!viuProgresso && !!pronto && (await aba.avaliar(`document.getElementById('midia').src.startsWith('blob:')`)));
      if (pronto) conferirMidia("sem service worker 390x844", await aba.avaliar(MEDIR));
      const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
      confere("sem service worker: Baixar entrega o original (SHA-256 igual)", d.terminou && f === NOME_RETRATO && shaArquivo(path.join(d.pasta, f)) === shaArquivo(retrato), JSON.stringify(d.arquivos));
      await aba.fechar();
    }

    // 3f. Site: roda num iframe isolado (sandbox sem allow-same-origin), montado pela página site.html; o service worker não o serve
    {
      const SANDBOX_ESPERADO = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
      let abaSite;
      for (const vp of viewports) {
        const aba = await abrirAba({ ...vp, nome: `site-${vp.w}` });
        aba.esperados.push((e) => e.includes(prev.paisagem.id)); // a sonda do site pede de propósito outra prévia e leva CORS
        await abrirLink(aba, BASE, link("site"));
        const abriu = await aba.ate(`location.pathname === '/previas/site.html' && !!document.getElementById('quadro-site')`, 25_000);
        const js = abriu && await aba.ateNoQuadro(`document.getElementById('js-ok')?.textContent === 'js ok'`, 25_000);
        confere(`site ${vp.w}x${vp.h}: abre em /previas/site.html, num iframe, com o JavaScript do site rodando (script externo virou data:)`, !!js,
          js ? "" : `abriu=${!!abriu} url=${await aba.avaliar("location.href").catch(() => "?")} texto=${JSON.stringify(await aba.avaliar("document.body.innerText").catch(() => "?"))} erros=${aba.erros.join(" | ").slice(0, 300)} quadro=${await aba.noQuadro("document.body.innerText.slice(0,200)").catch((e) => String(e))}`);
        if (!js) { await aba.fechar(); continue; }
        const est = await aba.noQuadro(`(() => {
          const img = (i) => { const x = document.getElementById(i); return x.complete && x.naturalWidth > 0 && x.currentSrc.startsWith('data:image/png'); };
          const l = document.getElementById('logo'), e = document.getElementById('externa');
          return { bg: getComputedStyle(document.body).backgroundColor, cor: getComputedStyle(document.getElementById('titulo')).color, extra: getComputedStyle(document.getElementById('extra')).color,
            bgImg: getComputedStyle(document.getElementById('logo-css')).backgroundImage.slice(0, 27), titulo: document.title, logo: l.complete && l.naturalWidth === 64 && l.currentSrc.startsWith('data:image/png'),
            abs: img('abs'), srcset: img('srcset'), externa: e.complete && e.naturalWidth > 0 && e.currentSrc.startsWith('http://127.0.0.1'), sw: document.documentElement.scrollWidth, vw: innerWidth, origem: self.origin }; })()`);
        confere(`site ${vp.w}x${vp.h}: CSS aplicado (fundo verde, título laranja, @import e url() do CSS), imagem relativa carregada e título certo`,
          est.bg === "rgb(10, 100, 50)" && est.cor === "rgb(242, 174, 48)" && est.extra === "rgb(1, 2, 3)" && est.bgImg === 'url("data:image/png;base64,' && est.logo && est.titulo === "Site de teste", JSON.stringify(est));
        confere(`site ${vp.w}x${vp.h}: imagem com caminho absoluto (/img/...) e srcset também carregam; sem rolagem lateral; iframe ocupa a largura`, est.abs && est.srcset && est.sw <= est.vw && est.vw === vp.w, JSON.stringify(est));
        if (vp.w === 1440) confere("site: recurso de fora (outro endereço, http://127.0.0.1:<outra porta>) passa direto", est.externa);
        const iframeAttrs = await aba.avaliar(`(() => { const q = document.getElementById('quadro-site'); const b = q.getBoundingClientRect(); return { sandbox: q.getAttribute('sandbox'), temSrcdoc: q.hasAttribute('srcdoc'), src: q.getAttribute('src'), x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight, viewport: document.querySelector('meta[name=viewport]').content }; })()`);
        confere(`site ${vp.w}x${vp.h}: iframe com sandbox exato (sem allow-same-origin), srcdoc, embaixo do painel (ocupa o resto da tela) e meta viewport do site`,
          iframeAttrs.sandbox === SANDBOX_ESPERADO && !iframeAttrs.sandbox.includes("allow-same-origin") && iframeAttrs.temSrcdoc && iframeAttrs.src === null && iframeAttrs.x === 0 && iframeAttrs.w === iframeAttrs.vw && iframeAttrs.y >= 44 && iframeAttrs.y <= 80 && Math.abs(iframeAttrs.y + iframeAttrs.h - iframeAttrs.vh) < 1 && iframeAttrs.viewport === "width=device-width,initial-scale=1", JSON.stringify(iframeAttrs));
        await aba.captura(salvar("site", vp.w));
        if (vp.w === 1440) {
          confere("site: fragmento sumiu e a chave não está no endereço", !(await aba.avaliar(`location.href`)).includes(prev.site.chave) && (await aba.avaliar(`location.hash`)) === "");
          // isolamento: o script do site tenta ler o visualizador
          const sondaTxt = await aba.ateNoQuadro(`(() => { const t = document.getElementById('sonda').textContent; return t.startsWith('{') ? t : ''; })()`, 15_000);
          let sonda = {}; try { sonda = JSON.parse(sondaTxt); } catch {}
          const tentativas = ["indexedDB", "caches", "fetch", "parent.document", "top.location", "localStorage", "cookie", "serviceWorker"];
          confere("site isolado: indexedDB.open, caches.keys, fetch de outra prévia, parent.document, top.location, localStorage, cookie e service worker foram NEGADOS",
            tentativas.every((n) => /^negado:/.test(sonda[n] || "")) && sonda.origem === "null", sondaTxt);
          console.log(`# sonda do site: ${sondaTxt}`);
          confere("site isolado: o visualizador não vazou nada para a tela do site (sem chave, id, manifesto ou CryptoKey)",
            !!sondaTxt && ![prev.site.chave, prev.paisagem.chave, prev.paisagem.id, prev.site.id, "CryptoKey", "AES", "manifesto"].some((x) => sondaTxt.includes(x)));
          const controle = await aba.avaliar(`(async () => { const r = await fetch('/previas/v/${prev.paisagem.id}/paisagem.png'); return { s: r.status, n: (await r.arrayBuffer()).byteLength }; })()`);
          confere("site isolado: o mesmo pedido feito pelo visualizador (mesma origem) dá 200, então a negação veio do isolamento", controle.s === 200 && controle.n > 1000, JSON.stringify(controle));
          // o caminho virtual de site não existe (o service worker não serve site)
          const v = `/previas/v/${prev.site.id}/`;
          const st = await aba.sonda(() => aba.avaliar(`(async () => { const g = async (u) => (await fetch(u)).status; return { raiz: await g(${JSON.stringify(v)}), index: await g(${JSON.stringify(v + "index.html")}), css: await g(${JSON.stringify(v + "css/estilo.css")}), semBarra: await g(${JSON.stringify(v.slice(0, -1))}) }; })()`));
          confere("site: /previas/v/<id>/ de site dá 404 (raiz, index.html, css e sem barra final)", st.raiz === 404 && st.index === 404 && st.css === 404 && st.semBarra === 404, JSON.stringify(st));
          const idb = await aba.avaliar(`new Promise((ok) => { const r = indexedDB.open('ginga-previas', 1); r.onsuccess = () => { const g = r.result.transaction('previas').objectStore('previas').get(${JSON.stringify(prev.site.id)}); g.onsuccess = () => ok({ tem: !!g.result, naoExtraivel: g.result?.chave?.extractable === false, tipo: g.result?.chave?.type, semManifesto: g.result?.manifesto === undefined, campos: Object.keys(g.result || {}).sort().join(',') }); }; })`);
          confere("site: na IndexedDB só ficam id, chave (CryptoKey não extraível) e prazo, sem manifesto", idb.tem && idb.naoExtraivel && idb.tipo === "secret" && idb.semManifesto && idb.campos === "chave,expira,id", JSON.stringify(idb));
          // âncora (#) fica dentro da página; mensagens inválidas ou de outra origem de janela são ignoradas
          await aba.clicarNoQuadro("#ancora");
          const rolou = await aba.ateNoQuadro(`scrollY > 300 && window.__marca === 'mesma-pagina'`, 5000);
          confere("site: âncora (#fim) rola dentro da própria página, sem recarregar", !!rolou);
          await aba.avaliar(`window.postMessage({ ginga: 'navegar', href: 'pagina.html' }, '*')`);
          await aba.noQuadro(`(() => { const m = (d) => parent.postMessage(d, '*'); m({ ginga: 'navegar', href: 'pagina.html', extra: 1 }); m({ ginga: 'navegar', href: '.segredo' }); m({ ginga: 'navegar', href: '../../p/x/m.bin' });
            m({ ginga: 'navegar', href: 'https://example.com/' }); m({ ginga: 'navegar', href: 'nao-existe.html' }); m('navegar'); m({ ginga: 'navegar', href: 123 }); m({ ginga: 'navegar', href: '' }); m(['navegar', 'pagina.html']); return 1; })()`);
          await dormir(900);
          confere("site: mensagem de outra janela, com formato fora do estrito, caminho oculto, fora do manifesto ou externo é ignorada (fica na mesma página)",
            !!(await aba.noQuadro(`document.getElementById('titulo')?.textContent === 'Site de teste da Ginga' && window.__marca === 'mesma-pagina'`)));
          // link externo abre em nova aba; o iframe continua na página
          await aba.noQuadro(`window.scrollTo(0, 0)`);
          await aba.clicarNoQuadro("#externo");
          let nova = null; const limiteNova = Date.now() + 8000;
          while (!nova && Date.now() < limiteNova) { nova = (await cdp.enviar("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.includes("/destino-externo")); if (!nova) await dormir(150); }
          confere("site: link externo abre em nova aba e o site continua onde estava", !!nova && !!(await aba.noQuadro(`window.__marca === 'mesma-pagina'`)));
          if (nova) await cdp.enviar("Target.closeTarget", { targetId: nova.targetId });
          // página interna, voltar e histórico
          const noInicio = `document.getElementById('titulo')?.textContent === 'Site de teste da Ginga' && document.getElementById('js-ok')?.textContent === 'js ok'`;
          await aba.clicarNoQuadro("#ir-sobre");
          const sobre = await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Sobre o site' && getComputedStyle(document.body).backgroundColor === 'rgb(10, 100, 50)'`, 10_000);
          confere("site: página interna (sobre/) abre com o CSS por caminho relativo (../css) e o endereço guarda a página (?c=sobre/)", !!sobre && (await aba.avaliar(`new URLSearchParams(location.search).get('c')`)) === "sobre/");
          await aba.clicarNoQuadro("#voltar");
          confere("site: link relativo para a pasta pai (../) volta ao início", !!(await aba.ateNoQuadro(noInicio, 10_000)));
          await aba.clicarNoQuadro("#ir-pagina");
          confere("site: pagina.html abre", !!(await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Página interna'`, 10_000)));
          await aba.avaliar(`history.back()`);
          confere("site: botão voltar do navegador volta para a página anterior (início)", !!(await aba.ateNoQuadro(noInicio, 10_000)));
          await aba.clicarNoQuadro("#enviar");
          confere("site: envio de formulário GET relativo (action=sobre/) abre a página", !!(await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Sobre o site'`, 10_000)));
          await aba.avaliar(`history.back()`);
          await aba.ateNoQuadro(noInicio, 10_000);
          await aba.clicarNoQuadro("#ir-sem-barra");
          confere("site: pasta sem a barra final (sobre) abre a página da pasta", !!(await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Sobre o site'`, 10_000)));
          // recarregar: a chave guardada devolve a mesma página
          await aba.avaliar(`location.reload()`).catch(() => {});
          await dormir(300);
          confere("site: recarregar a página (sem o fragmento) reabre a mesma página interna", !!(await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Sobre o site'`, 20_000)));
          abaSite = aba; continue;
        }
        await aba.fechar();
      }
      if (abaSite) await abaSite.fechar();
    }

    // 3g. Prazo vence com a prévia já aberta
    {
      // arquivo: o service worker nega (410) e a IndexedDB é apagada
      const expiraCurto = Date.now() + 9_000;
      await fazer("arquivoCurto", "arquivo", { arquivo: paisagem, expira: expiraCurto });
      const aba = await abrirAba({ w: 1440, h: 900, nome: "prazo" });
      await abrirLink(aba, BASE, link("arquivoCurto"));
      const abriu = await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 15_000);
      confere("prazo curto: arquivo abre antes de vencer", !!abriu);
      // site: com a página aberta, ao passar o prazo o site some, aparece "Este link expirou" e a chave é apagada
      const expiraSite = Date.now() + 9_000;
      await fazer("siteCurto", "site", { arquivo: siteDir, expira: expiraSite });
      const abaS = await abrirAba({ w: 1440, h: 900, nome: "prazo-site" });
      abaS.esperados.push((e) => e.includes(prev.paisagem.id));
      await abrirLink(abaS, BASE, link("siteCurto"));
      const abriuS = await abaS.ateNoQuadro(`document.getElementById('js-ok')?.textContent === 'js ok'`, 20_000);
      confere("prazo curto: site abre antes de vencer", !!abriuS);
      await dormir(Math.max(0, Math.max(expiraCurto, expiraSite) - Date.now()) + 1500); // espera os prazos passarem
      const resp = await aba.sonda(() => aba.avaliar(`(async () => { const r = await fetch(document.getElementById('midia').getAttribute('src')); return { s: r.status, t: (await r.text()).includes('Este link expirou') }; })()`));
      confere("prazo curto: depois do prazo o service worker responde 410 “Este link expirou” ao arquivo", resp.s === 410 && resp.t, JSON.stringify(resp));
      const idbDe = (idp) => `new Promise((ok) => { const r = indexedDB.open('ginga-previas', 1); r.onsuccess = () => { const g = r.result.transaction('previas').objectStore('previas').get(${JSON.stringify(idp)}); g.onsuccess = () => ok(!!g.result); }; })`;
      confere("prazo curto: a chave do arquivo foi apagada da IndexedDB", (await aba.avaliar(idbDe(prev.arquivoCurto.id))) === false);
      const avisoS = await abaS.ate(`document.getElementById('aviso-expirou') && !document.getElementById('quadro-site')`, 5000);
      confere("prazo curto: com o site aberto, ao vencer o iframe some e aparece “Este link expirou”", !!avisoS);
      confere("prazo curto: a chave do site foi apagada da IndexedDB", (await abaS.avaliar(idbDe(prev.siteCurto.id))) === false);
      await aba.fechar(); await abaS.fechar();
    }

    // 3g2. Site grande demais para virar data: URL (limite 60 MB no visualizador; aqui baixado pelo gancho de teste)
    {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, pre: "window.__PREVIAS_TESTE = { limiteSite: 1000 };", nome: "site-grande", limpa: false });
      await abrirLink(aba, BASE, link("site"));
      const achou = await aba.ate(`document.getElementById('aviso-grande')?.textContent`, 20_000);
      confere("site acima do limite: mensagem clara em português e nenhum iframe", !!achou && /Este site é grande demais para abrir aqui/.test(achou) && /até 0 MB|até \d+(,\d)? MB/.test(achou) && (await aba.avaliar(`!document.getElementById('quadro-site')`)), String(achou));
      confere("site acima do limite: o painel continua na tela (Compartilhamento a 44 px) e Baixar avisa em vez de travar", await (async () => {
        const p = await aba.avaliar(PAINEL); await aba.clicar("#baixar"); const msg = await aba.ate(`document.getElementById('mensagem-painel')?.textContent`, 5000);
        return p.comp && p.comp.w >= 44 && /grande demais para baixar/.test(msg || "") && !!(await aba.avaliar(`!!document.getElementById('aviso-grande') && !document.querySelector('#baixar').disabled`));
      })());
      await aba.fechar();
    }

    // 3h. Avisos: vencida, chave errada, prazo só no expira.json
    for (const [nome, idAviso, textos] of [["vencida", "aviso-expirou", ["Este link expirou", "Peça um link novo a quem enviou."]], ["soExpiraJson", "aviso-expirou", ["Este link expirou"]], ["chaveErrada", "aviso-chave", ["Link incorreto ou incompleto"]]]) {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, nome: `aviso-${nome}`, limpa: false });
      await abrirLink(aba, BASE, link(nome));
      const achou = await aba.ate(`document.getElementById(${JSON.stringify(idAviso)})`, 15_000);
      const texto = achou ? await aba.avaliar(`document.getElementById(${JSON.stringify(idAviso)}).textContent`) : "";
      confere(`aviso (${nome}): mostra ${JSON.stringify(textos[0])}`, !!achou && textos.every((t) => texto.includes(t)), texto);
      confere(`aviso (${nome}): fragmento sumiu da barra`, await fragSumiu(aba, prev[nome].chave));
      await aba.fechar();
    }
    {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, nome: "link-incompleto", limpa: false });
      await aba.ir(`${BASE}#abc.def`);
      confere("aviso: link incompleto/malformado", !!(await aba.ate(`document.getElementById('aviso-incompleto')`, 8000)));
      await aba.ir(`${BASE}`);
      confere("página sem link mostra a orientação de abrir o link completo", !!(await aba.ate(`document.getElementById('aviso-inicio')`, 8000)));
      await aba.fechar();
    }

    // 3i. Prévia recém-publicada (404 por enquanto) e id inexistente
    {
      const pre = "window.__PREVIAS_TESTE = { intervalo: 700, limite: 25000 };";
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, pre, nome: "chegando", limpa: false });
      registro.length = 0;
      await abrirLink(aba, BASE, link("chegando"));
      const msg = await aba.ate(`document.getElementById('aviso-chegando')?.textContent.includes('A prévia está chegando, tente de novo em 1 minuto')`, 10_000);
      confere("prévia ainda com 404: mostra “A prévia está chegando, tente de novo em 1 minuto”", !!msg);
      await dormir(2200);
      const tentativas = registro.filter((r) => r.arq === "m.bin").length;
      confere(`prévia ainda com 404: tenta de novo sozinha (${tentativas} pedidos do manifesto)`, tentativas >= 3, String(tentativas));
      bloqueados.delete(prev.chegando.id);
      const apareceu = await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 15_000);
      confere("prévia ainda com 404: quando o GitHub publica, a prévia abre sozinha", !!apareceu);
      await aba.fechar();

      const aba2 = await abrirAba({ w: 390, h: 844, mobile: true, pre: "window.__PREVIAS_TESTE = { intervalo: 300, limite: 1500 };", nome: "inexistente", limpa: false });
      await abrirLink(aba2, BASE, `#${prev.inexistente.id}.${prev.inexistente.chave}`);
      await aba2.ate(`document.getElementById('aviso-chegando')`, 5000);
      const sumiu = await aba2.ate(`document.getElementById('aviso-sumiu')`, 15_000);
      confere("id inexistente: depois de esgotar as tentativas mostra “Prévia não encontrada”", !!sumiu);
      await aba2.fechar();
    }

    // 3k. Painel e janela: prévias versão 2 antigas (arquivo e site) continuam abrindo, agora com o painel e um item só
    {
      const aba = await abrirAba({ w: 390, h: 844, mobile: true, nome: "v2-painel-390" });
      await abrirLink(aba, BASE, link("paisagem"));
      await aba.ate(`(() => { const i = document.getElementById('midia'); return i && i.complete && i.naturalWidth > 0; })()`, 25_000);
      conferirPainel("v2 arquivo 390", await aba.avaliar(PAINEL), "paisagem.png", 390);
      const j = await abrirJanela(aba, "v2 arquivo 390", { nomes: ["paisagem.png"], tipos: ["Imagem"], atual: 0 }, prev.paisagem.chave);
      await aba.tecla("Escape"); await dormir(200);
      confere("v2 arquivo: Esc fecha a janela e o foco volta ao botão Compartilhamento", await janelaFechada(aba));
      const idb = await aba.avaliar(`new Promise((ok) => { const r = indexedDB.open('ginga-previas', 1); r.onsuccess = () => { const g = r.result.transaction('previas').objectStore('previas').get(${JSON.stringify(prev.paisagem.id)}); g.onsuccess = () => ok({ campos: Object.keys(g.result || {}).sort().join(','), versao: g.result?.manifesto?.versao, extr: g.result?.chave?.extractable }); }; })`);
      confere("v2 arquivo: registro na IndexedDB como antes (id, chave não extraível, prazo e manifesto versão 2)", idb.campos === "chave,expira,id,manifesto" && idb.versao === 2 && idb.extr === false, JSON.stringify(idb));
      await aba.fechar();
      const abaS = await abrirAba({ w: 390, h: 844, mobile: true, nome: "v2-site-painel-390" });
      abaS.esperados.push((e) => e.includes(prev.paisagem.id));
      await abrirLink(abaS, BASE, link("site"));
      await abaS.ateNoQuadro(`document.getElementById('js-ok')?.textContent === 'js ok'`, 25_000);
      conferirPainel("v2 site 390", await abaS.avaliar(PAINEL), "Site de teste", 390);
      await abrirJanela(abaS, "v2 site 390", { nomes: ["Site de teste"], tipos: ["Site"], atual: 0 }, prev.site.chave);
      await abaS.clicar("#fechar-janela"); await dormir(200);
      confere("v2 site: o botão Fechar fecha a janela e o foco volta ao botão Compartilhamento", await janelaFechada(abaS));
      await abaS.fechar();
    }

    // 3l. Grupo (versão 3): 0 foto, 1 site, 2 PDF, 3 foto de nome comprido
    {
      const G = prev.grupo, NOMES = NOMES_GRUPO, TIPOS = TIPOS_GRUPO;
      const eImagem = `(() => { const i = document.getElementById('midia'); return i && i.tagName === 'IMG' && i.complete && i.naturalWidth > 0; })()`;
      const noSite = `location.pathname === '/previas/site.html' && !!document.getElementById('quadro-site')`;
      const esp = (atual) => ({ nomes: NOMES, tipos: TIPOS, atual });
      for (const vp of viewports) {
        const mob = vp.w === 390, tag = `grupo ${vp.w}x${vp.h}`;
        const aba = await abrirAba({ ...vp, nome: `grupo-${vp.w}` });
        aba.esperados.push((e) => e.includes(prev.paisagem.id)); // a sonda do site pede de propósito outra prévia
        await abrirLink(aba, BASE, link("grupo"));
        const pronto = await aba.ate(eImagem, 25_000);
        confere(`${tag}: abre pelo link #<id>.<chave> no item 0 (imagem)`, !!pronto);
        if (!pronto) { await aba.fechar(); continue; }
        await dormir(200);
        conferirMidia(`${tag} item 0`, await aba.avaliar(MEDIR));
        conferirPainel(`${tag} item 0`, await aba.avaliar(PAINEL), NOMES[0], vp.w);
        confere(`${tag}: o fragmento some e o endereço fica ?p=<id> (sem chave)`, await fragSumiu(aba, G.chave) && (await aba.avaliar(`location.search`)) === `?p=${G.id}`);
        await aba.captura(salvar("grupo-painel", vp.w));
        await abrirJanela(aba, `${tag} item 0`, esp(0), G.chave);
        await aba.captura(salvar("grupo-janela", vp.w));
        if (mob) {
          await aba.tecla("Escape"); await dormir(200);
          confere("grupo: Esc fecha a janela e o foco volta ao botão Compartilhamento", await janelaFechada(aba));
          await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
          await aba.clicarEm(2, 2); await dormir(200);
          confere("grupo: clique no fundo escuro fecha a janela e devolve o foco ao botão", await janelaFechada(aba));
          await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
          await aba.clicar("#fechar-janela"); await dormir(200);
          confere("grupo: o botão Fechar fecha a janela", await janelaFechada(aba));
          await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
          const dentro = await aba.avaliar(`(() => { const b = document.querySelector('.janela-corpo').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 10 }; })()`);
          await aba.clicarEm(dentro.x, dentro.y); await dormir(150);
          confere("grupo: clique dentro da janela não a fecha", await aba.avaliar(`document.getElementById('janela-compartilhar').open`));
          await aba.tecla("Escape"); await dormir(200);
        } else {
          await aba.tecla("Escape"); await dormir(200);
          confere("grupo 1440: Esc fecha a janela e devolve o foco", await janelaFechada(aba));
        }
        // item 0 -> site (item 1): pela lista (celular) ou pelo botão Próximo (computador)
        await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
        await aba.clicar(mob ? "#janela-itens li:nth-child(2) a" : "#item-proximo");
        const abriuSite = await aba.ate(noSite, 25_000);
        confere(`${tag}: do item 0 para o site (item 1) em /previas/site.html?p=<id>&n=1`, !!abriuSite && (await aba.avaliar(`location.search`)) === `?p=${G.id}&n=1`, await aba.avaliar(`location.href`).catch(() => ""));
        const js = abriuSite && await aba.ateNoQuadro(`document.getElementById('js-ok')?.textContent === 'js ok'`, 25_000);
        confere(`${tag}: o site do grupo roda no iframe isolado`, !!js && (await aba.avaliar(`document.getElementById('quadro-site').getAttribute('sandbox')`)) === "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
        if (js) {
          const pn = await aba.avaliar(PAINEL);
          conferirPainel(`${tag} site`, pn, NOMES[1], vp.w);
          const q = await aba.avaliar(`(() => { const b = document.getElementById('quadro-site').getBoundingClientRect(); const c = document.querySelector('.cabecalho').getBoundingClientRect();
            const topo = document.elementFromPoint(innerWidth / 2, b.top + 3), centro = document.elementFromPoint(innerWidth / 2, innerHeight / 2), noPainel = document.elementFromPoint(8, c.top + 8);
            return { y: b.top, h: b.height, w: b.width, painelB: c.bottom, vh: innerHeight, vw: innerWidth, topo: topo?.id, centro: centro?.id, noPainel: noPainel?.closest('.cabecalho') ? 'painel' : noPainel?.id, sw: document.documentElement.scrollWidth }; })()`);
          confere(`${tag} site: o painel não cobre o site (iframe começa embaixo do painel e vai até o fim da tela; nada do painel sobre o iframe)`,
            q.y >= q.painelB - 0.5 && Math.abs(q.y + q.h - q.vh) < 1 && q.w === q.vw && q.topo === "quadro-site" && q.centro === "quadro-site" && q.noPainel === "painel" && q.sw <= q.vw, JSON.stringify(q));
          await aba.captura(salvar("site-painel", vp.w));
          // o painel sobrevive à navegação interna do site (mesmo elemento) e o endereço guarda n e c
          await aba.avaliar(`document.getElementById('baixar').dataset.marca = 'mesmo-painel'`);
          await aba.clicarNoQuadro("#ir-sobre");
          const sobre = await aba.ateNoQuadro(`document.getElementById('titulo')?.textContent === 'Sobre o site'`, 10_000);
          const ap = await aba.avaliar(`({ marca: document.getElementById('baixar')?.dataset.marca, h1: document.querySelector('.cabecalho h1')?.textContent, busca: location.search })`);
          confere(`${tag} site: navegação interna mantém o painel (mesmo elemento, nome do item) e o endereço leva n=1 e c=sobre/`, !!sobre && ap.marca === "mesmo-painel" && ap.h1 === NOMES[1] && ap.busca === `?p=${G.id}&n=1&c=sobre%2F`, JSON.stringify(ap));
          await abrirJanela(aba, `${tag} site`, esp(1), G.chave);
          await aba.clicar("#fechar-janela"); await dormir(200);
          if (vp.w === 1440) {
            // Baixar o site: .zip com os arquivos originais
            const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
            confere(`site: Baixar entrega “Site de teste.zip”`, d.terminou && f === "Site de teste.zip", JSON.stringify(d.arquivos));
            if (d.terminou && f) conferirZip("site .zip", path.join(d.pasta, f), "Site de teste.zip", siteDir);
          }
        }
        // site -> PDF (item 2) -> foto de nome comprido (item 3) -> volta ao PDF, sempre pela janela
        if (process.env.DEPURAR) await aba.avaliar(`window.__c = []; for (const t of ['pointerdown','click']) document.addEventListener(t, (e) => window.__c.push(t + ':' + (e.target.id || e.target.className || e.target.tagName)), true); document.getElementById('janela-compartilhar').addEventListener('close', () => window.__c.push('close'));`);
        if (process.env.DEPURAR) console.log("# pre", await aba.avaliar(`JSON.stringify({ aberto: document.getElementById('janela-compartilhar').open, foco: document.activeElement?.id, rect: document.getElementById('compartilhar').getBoundingClientRect().toJSON() })`));
        await aba.clicar("#compartilhar");
        if (process.env.DEPURAR) { await dormir(300); console.log("# pos", await aba.avaliar(`document.getElementById('janela-compartilhar').open + ' ' + JSON.stringify(window.__c)`)); } await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
        if (process.env.DEPURAR) await aba.avaliar(`window.__c = []; for (const t of ['pointerdown','mousedown','mouseup','click','pointerup']) document.addEventListener(t, (e) => window.__c.push(t + ':' + (e.target.id || e.target.className || e.target.tagName)), true); window.addEventListener('pagehide', () => window.__c.push('pagehide')); window.addEventListener('beforeunload', () => window.__c.push('beforeunload'))`);
        if (process.env.DEPURAR) console.log("# antes", await aba.avaliar(`JSON.stringify({ aberto: document.getElementById('janela-compartilhar').open, ponto: (() => { const r = document.getElementById('item-proximo').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e?.id || e?.className || e?.tagName; })() })`));
        await aba.clicar("#item-proximo");
        if (process.env.DEPURAR) { await dormir(600); console.log("# depois", await aba.avaliar(`location.href + ' ' + document.getElementById('janela-compartilhar')?.open + ' ' + JSON.stringify(window.__c)`)); }
        const pdfOk = await aba.ate(`location.pathname === '/previas/' && location.search === '?p=${G.id}&n=2' && document.getElementById('midia')?.tagName === 'IFRAME'`, 25_000);
        confere(`${tag}: do site para o PDF (item 2) em /previas/?p=<id>&n=2`, !!pdfOk, await aba.avaliar(`location.href + ' ' + JSON.stringify({ aberto: document.getElementById('janela-compartilhar')?.open, prox: document.getElementById('item-proximo')?.outerHTML, r: document.getElementById('item-proximo')?.getBoundingClientRect().toJSON() })`).catch(() => ""));
        if (pdfOk) {
          await dormir(500);
          conferirMidia(`${tag} PDF do grupo`, await aba.avaliar(MEDIR), { preencher: false });
          conferirPainel(`${tag} PDF`, await aba.avaliar(PAINEL), NOMES[2], vp.w);
          if (vp.w === 1440) {
            const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
            confere(`PDF do grupo: Baixar entrega o original (nome “${f}”, SHA-256 igual)`, d.terminou && f === "proposta.pdf" && shaArquivo(path.join(d.pasta, f)) === shaArquivo(pdf), JSON.stringify(d.arquivos));
          }
        }
        await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
        await aba.clicar("#item-proximo");
        const fotoOk = await aba.ate(`location.search === '?p=${G.id}&n=3' && ${eImagem}`, 25_000);
        confere(`${tag}: do PDF para a foto 2 (item 3, última) em ?p=<id>&n=3`, !!fotoOk, await aba.avaliar(`location.href`).catch(() => ""));
        if (fotoOk) {
          await dormir(200);
          conferirMidia(`${tag} foto do grupo`, await aba.avaliar(MEDIR));
          conferirPainel(`${tag} foto de nome comprido`, await aba.avaliar(PAINEL), NOMES[3], vp.w);
          await abrirJanela(aba, `${tag} item 3`, esp(3), G.chave);
          await aba.clicar("#fechar-janela"); await dormir(200);
          if (vp.w === 1440) {
            const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
            confere("foto do grupo: Baixar entrega o original com o nome do item (SHA-256 igual)", d.terminou && f === NOMES[3] && shaArquivo(path.join(d.pasta, f)) === shaArquivo(dois), JSON.stringify(d.arquivos));
          }
          await aba.clicar("#compartilhar"); await aba.ate(`document.getElementById('janela-compartilhar').open`, 3000);
          await aba.clicar("#item-anterior");
          confere(`${tag}: Anterior volta ao PDF (item 2)`, !!(await aba.ate(`location.search === '?p=${G.id}&n=2' && document.getElementById('midia')?.tagName === 'IFRAME'`, 25_000)));
        }
        await aba.fechar();
      }

      // endereços diretos ?p=<id>&n=<k> (a chave já está guardada neste navegador de teste) e o caminho virtual do service worker
      {
        const aba = await abrirAba({ w: 1440, h: 900, nome: "grupo-direto" });
        aba.esperados.push((e) => e.includes(prev.paisagem.id));
        await abrirLink(aba, BASE, link("grupo")); // guarda a chave
        await aba.ate(eImagem, 25_000);
        await aba.ir(`${BASE}?p=${G.id}&n=3`);
        confere("endereço ?p=<id>&n=3 abre direto a foto 2", !!(await aba.ate(`${eImagem} && document.querySelector('.cabecalho h1')?.textContent === ${JSON.stringify(NOMES[3])}`, 20_000)));
        await aba.ir(`${BASE}?p=${G.id}&n=1`);
        confere("endereço ?p=<id>&n=1 (item site) vai para site.html?p=<id>&n=1", !!(await aba.ate(`${noSite} && location.search === '?p=${G.id}&n=1'`, 25_000)));
        await aba.ir(`${BASE}?p=${G.id}&n=0`);
        confere("endereço ?p=<id>&n=0 abre o item 0", !!(await aba.ate(`${eImagem} && document.querySelector('.cabecalho h1')?.textContent === ${JSON.stringify(NOMES[0])}`, 20_000)));
        await aba.ir(`${BASE}site.html?p=${G.id}&n=2`);
        confere("site.html?p=<id>&n=2 (item que não é site) vai para o visualizador de arquivo", !!(await aba.ate(`location.pathname === '/previas/' && location.search === '?p=${G.id}&n=2' && document.getElementById('midia')`, 20_000)));
        for (const n of ["9", "abc"]) {
          await aba.ir(`${BASE}?p=${G.id}&n=${n}`);
          confere(`endereço com n=${n}: “Item não encontrado”, sem travar`, !!(await aba.ate(`document.getElementById('aviso-item')?.textContent.includes('Item não encontrado')`, 15_000)));
        }
        await aba.ir(`${BASE}?p=${G.id}&n=0`);
        await aba.ate(eImagem, 20_000);
        // service worker: caminho virtual <n>/<arquivo> só para itens "arquivo"; site nunca
        const m = await lerManifesto({ destino: P, id: G.id, chave: G.chave });
        const cam = (k) => encodeURIComponent(m.itens[k].arquivos[0].caminho);
        const get = (u, cab) => aba.avaliar(`(async () => { const r = await fetch(${JSON.stringify(u)}, ${JSON.stringify(cab || {})}); const b = await r.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); return { s: r.status, t: r.headers.get('content-type'), d: r.headers.get('content-disposition'), sha: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') }; })()`);
        const v = (suf) => `/previas/v/${G.id}/${suf}`;
        const r0 = await get(v(`0/${cam(0)}`)), r2 = await get(v(`2/${cam(2)}?baixar=1`)), r3 = await get(v(`3/${cam(3)}?baixar=1`));
        confere("service worker (grupo): /v/<id>/0/<arquivo> entrega a imagem original e /v/<id>/2/ o PDF, com o nome original do item no Content-Disposition",
          r0.s === 200 && r0.t === "image/png" && r0.sha === shaArquivo(um) && r2.s === 200 && r2.t === "application/pdf" && r2.sha === shaArquivo(pdf) && /^attachment;/.test(r2.d) && /filename="proposta\.pdf"/.test(r2.d)
          && r3.s === 200 && decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r3.d)?.[1] || "") === NOMES[3], JSON.stringify([r0, r2, r3]));
        const neg = await aba.sonda(async () => [await get(v(`1/index.html`)), await get(v(`1/css/estilo.css`)), await get(v(`1/`)), await get(v(`9/${cam(0)}`)), await get(v(`0/..%2F2%2F${cam(2)}`)), await get(v(`0/.segredo`))]);
        confere("service worker (grupo): arquivo de item site, item inexistente, caminho com .. e oculto dão 404 (site nunca é servido)", neg.every((r) => r.s === 404), JSON.stringify(neg.map((r) => r.s)));
        const raiz = await get(v(``));
        confere("service worker (grupo): a raiz /v/<id>/ leva ao 1º arquivo", raiz.s === 200 && raiz.sha === shaArquivo(um), JSON.stringify(raiz));
        const idb = await aba.avaliar(`new Promise((ok) => { const r = indexedDB.open('ginga-previas', 1); r.onsuccess = () => { const g = r.result.transaction('previas').objectStore('previas').get(${JSON.stringify(G.id)}); g.onsuccess = () => ok({ campos: Object.keys(g.result || {}).sort().join(','), versao: g.result?.manifesto?.versao, tipo: g.result?.manifesto?.tipo, itens: g.result?.manifesto?.itens?.length, extr: g.result?.chave?.extractable }); }; })`);
        confere("grupo: registro na IndexedDB { id, chave não extraível, expira, manifesto versão 3 inteiro }", idb.campos === "chave,expira,id,manifesto" && idb.versao === 3 && idb.tipo === "grupo" && idb.itens === 4 && idb.extr === false, JSON.stringify(idb));
        // formato: versão 3 aceita índices repetidos entre itens de site (mesma pasta), mas não dentro de um item
        const nz = await aba.avaliar(`(() => { const a = (i) => ({ i, caminho: 'x' + i, mime: 'text/html', tamanho: 1, pedacos: 1 }); const g = (itens) => window.GingaPainel.normalizar({ versao: 3, tipo: 'grupo', nome: 'g', expira: 1, itens });
          const site = (n, arq) => ({ n, tipo: 'site', nome: 's' + n, entrada: 'x0', arquivos: arq });
          return { reparte: !!g([site(0, [a(0), a(1)]), site(1, [a(0), a(1)])]), repeteNoItem: !!g([site(0, [a(0), a(0)])]), vazio: !!g([]), tipoRuim: !!g([{ n: 0, tipo: 'x', nome: 'a', arquivos: [a(0)] }]), v4: !!window.GingaPainel.normalizar({ versao: 4, tipo: 'grupo', expira: 1, itens: [] }) }; })()`);
        confere("formato: aceita versão 2 e 3; grupo de sites repartindo a mesma pasta (mesmos índices) vale; repetição dentro do item, grupo vazio, tipo ruim e versão 4 não", nz.reparte === true && nz.repeteNoItem === false && nz.vazio === false && nz.tipoRuim === false && nz.v4 === false, JSON.stringify(nz));
        await aba.fechar();
      }

      // largura mínima e tablet: nada de rolagem lateral com a janela aberta
      for (const [w, h] of [[320, 640], [768, 1024]]) {
        const aba = await abrirAba({ w, h, mobile: true, nome: `grupo-${w}` });
        aba.esperados.push((e) => e.includes(prev.paisagem.id));
        await aba.ir(`${BASE}?p=${G.id}&n=3`);
        await aba.ate(eImagem, 20_000);
        conferirPainel(`grupo ${w}x${h} item 3`, await aba.avaliar(PAINEL), NOMES[3], w);
        conferirMidia(`grupo ${w}x${h} item 3`, await aba.avaliar(MEDIR));
        await abrirJanela(aba, `grupo ${w}x${h}`, esp(3), G.chave);
        await aba.clicar("#fechar-janela");
        await aba.fechar();
      }
    }

    // 3m. Grupo com vídeo: abre, toca e Baixar entrega o original pelo service worker
    if (temVideo) {
      const orig = fs.readFileSync(video), V = prev.grupoVideo;
      const aba = await abrirAba({ w: 1440, h: 900, nome: "grupo-video" });
      await aba.ir(`${BASE}#${V.id}.${V.chave}`);
      const meta = await aba.ate(`(() => { const v = document.getElementById('midia'); return v && v.tagName === 'VIDEO' && v.readyState >= 1 && v.videoWidth > 0; })()`, 25_000);
      confere("grupo com vídeo: o item 0 (vídeo) abre com metadados", !!meta);
      if (meta) {
        conferirMidia("grupo com vídeo 1440x900", await aba.avaliar(MEDIR));
        conferirPainel("grupo com vídeo", await aba.avaliar(PAINEL), "vídeo de teste.mp4", 1440);
        await abrirJanela(aba, "grupo com vídeo", { nomes: ["vídeo de teste.mp4", "Foto um é bonita.png"], tipos: ["Vídeo", "Imagem"], atual: 0 }, V.chave);
        await aba.clicar("#fechar-janela"); await dormir(200);
        await aba.avaliar(`document.getElementById('midia').play().catch(() => {})`);
        confere("grupo com vídeo: toca", !!(await aba.ate(`(() => { const v = document.getElementById('midia'); return v.currentTime > 0.4 && !v.paused; })()`, 20_000)));
        const d = await baixarComClique(aba, "#baixar"); const f = d.arquivos.find((a) => !a.endsWith(".crdownload"));
        confere(`grupo com vídeo: Baixar entrega o original (nome “${f}”, SHA-256 igual)`, d.terminou && f === "vídeo de teste.mp4" && shaArquivo(path.join(d.pasta, f)) === sha(orig), JSON.stringify(d.arquivos));
      }
      await aba.fechar();
    }

    // 3j. Sem erro no console nas abas que deviam estar limpas
    const errosDe = (a) => a.erros.filter((e) => !a.esperados.some((f) => f(e)));
    const comErro = todosOsErros.filter((a) => errosDe(a).length);
    confere(`console sem erro em ${todosOsErros.length} abas de fluxo normal`, comErro.length === 0, comErro.map((a) => `${a.nome}: ${errosDe(a).slice(0, 3).join(" | ")}`).join(" ;; "));
  } finally {
    await desligarChrome();
    srv.close(); servEx.close();
  }
  console.log(`\nTotal: ${ok + falhas} conferências, ${ok} OK, ${falhas} FALHA(S)`);
  console.log(`Capturas em ${SAIDA}`);
  if (!process.env.MANTER) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(falhas ? 1 : 0);
}

principal().catch(async (e) => { console.error("ERRO NO TESTE:", e); await desligarChrome().catch(() => {}); process.exit(2); });
