// Visualizador público de prévias da Ginga Mídia (GitHub Pages).
// Lê o link https://.../previas/#<id>.<chave>, guarda a chave, apaga o fragmento da barra de endereço, baixa
// p/<id>/m.bin (manifesto cifrado com AES-256-GCM), decifra com WebCrypto e mostra a prévia.
//  - tipo "arquivo": a mídia fica numa linha própria da grade (nunca passa da tela) e vem do service worker, com Range;
//    sem service worker, o arquivo é decifrado inteiro num Blob, com barra de progresso.
//  - manifesto versão 3 (grupo de itens): endereço ?p=<id>&n=<k> mostra o item k (padrão 0); item "site" vai para site.html?p=<id>&n=<k>.
//    A versão 2 (arquivo ou site) vale como um grupo de 1 item. O painel do topo e a janela de compartilhamento ficam em painel.js.
//  - tipo "site": guarda só a chave (sem manifesto) e vai para site.html, que decifra o site e o roda num iframe isolado
//    (sandbox sem allow-same-origin). O sw.js NÃO serve site, porque um site servido na origem do visualizador leria a IndexedDB.
// Nada de rede além do próprio endereço; textos da prévia entram só com textContent.
(() => {
  "use strict";
  const T = window.__PREVIAS_TESTE || {}; // gancho de teste (a CSP impede que alguém de fora o defina)
  const PEDACO = 1024 * 1024;
  const INTERVALO = T.intervalo ?? 20_000;   // nova tentativa de prévia recém-publicada
  const LIMITE = T.limite ?? 5 * 60_000;     // desiste depois de 5 minutos
  const PROVISORIO = 10 * 60_000;            // validade da chave guardada antes de o manifesto abrir
  const RE_ID = /^[A-Za-z0-9_-]{22}$/;
  const RE_CHAVE = /^[A-Za-z0-9_-]{43}$/;
  const BASE = new URL("./", document.baseURI).pathname; // ex.: /previas/
  const raiz = document.getElementById("raiz");
  const Painel = window.GingaPainel;

  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const b64u = (t) => { const s = atob(t.replace(/-/g, "+").replace(/_/g, "/")); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  function nonce(i, c) { const n = new Uint8Array(12), v = new DataView(n.buffer); v.setUint32(0, i >>> 0); v.setBigUint64(4, BigInt(c)); return n; }
  const decifrar = (chave, i, c, bytes) => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i, c), tagLength: 128 }, chave, bytes);

  // ----------------------------------------------------------------------
  // IndexedDB "ginga-previas" (a mesma do sw.js): { id, chave (CryptoKey não extraível), expira, manifesto }
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
  const gravarRegistro = (reg) => banco("readwrite", (s) => s.put(reg));
  const apagarRegistro = (id) => banco("readwrite", (s) => s.delete(id)).catch(() => {});
  async function limparVencidas() {
    try {
      const db = await abrirBanco();
      await new Promise((ok) => {
        const t = db.transaction("previas", "readwrite"); const c = t.objectStore("previas").openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur) return; if (!(cur.value.expira > Date.now())) cur.delete(); cur.continue(); };
        t.oncomplete = () => { db.close(); ok(); }; t.onerror = t.onabort = () => { db.close(); ok(); };
      });
    } catch {}
  }
  async function avisarWorker(id) {
    try { const r = await navigator.serviceWorker.getRegistration(BASE); r?.active?.postMessage({ tipo: "esquecer", id }); } catch {}
  }

  // ----------------------------------------------------------------------
  // Pedaços de interface
  // ----------------------------------------------------------------------
  function el(tag, props = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === "texto") e.textContent = v; else if (k in e && k !== "list") e[k] = v; else e.setAttribute(k, v); }
    for (const f of filhos) if (f) e.append(f);
    return e;
  }
  function aviso({ titulo, texto, girar = false, botao, marca = true, id }) {
    const m = el("main", { className: "aviso", role: "status" });
    if (id) m.id = id;
    if (girar) m.append(el("p", { className: "girar" }));
    if (marca) m.append(el("p", { className: "marca", texto: "Ginga Mídia" }));
    m.append(el("h1", { texto: titulo }));
    if (texto) m.append(el("p", { className: "detalhe", texto }));
    if (botao) { const b = el("button", { className: "baixar", type: "button", texto: botao.texto }); b.addEventListener("click", botao.acao); m.append(b); }
    raiz.replaceChildren(m);
    return m;
  }
  const avisoExpirou = () => aviso({ id: "aviso-expirou", titulo: "Este link expirou", texto: "Peça um link novo a quem enviou." });
  const avisoChave = () => aviso({ id: "aviso-chave", titulo: "Link incorreto ou incompleto", texto: "A chave deste link não confere. Abra o link inteiro, do jeito que foi enviado, ou peça um link novo a quem enviou." });
  const avisoIncompleto = () => aviso({ id: "aviso-incompleto", titulo: "Link incompleto", texto: "Abra o link inteiro, com tudo o que vem depois do #. Se ele não abrir, peça um link novo a quem enviou." });
  const avisoSumiu = () => aviso({ id: "aviso-sumiu", titulo: "Prévia não encontrada", texto: "Este link não existe ou a prévia já foi apagada. Peça um link novo a quem enviou." });
  const avisoRede = (acao) => aviso({ id: "aviso-rede", titulo: "Não foi possível carregar a prévia", texto: "Confira a conexão com a internet e tente de novo.", botao: { texto: "Tentar de novo", acao } });
  const avisoFormato = () => aviso({ id: "aviso-formato", titulo: "Formato desconhecido", texto: "Esta prévia foi feita num formato que este visualizador não entende. Peça um link novo a quem enviou." });

  const { formatarData, tamanhoLegivel } = Painel;
  const avisoItem = (id) => aviso({ id: "aviso-item", titulo: "Item não encontrado", texto: "Este link não tem o item pedido. Abra o link pelo primeiro item.", botao: { texto: "Abrir o primeiro item", acao: () => location.assign(`${BASE}?p=${id}`) } });

  // ----------------------------------------------------------------------
  // Service worker
  // ----------------------------------------------------------------------
  async function prepararWorker(precisaControlar) {
    if (T.semSW || !("serviceWorker" in navigator) || !window.isSecureContext) return false;
    try {
      await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
      const pronto = await Promise.race([navigator.serviceWorker.ready, esperar(8000).then(() => null)]);
      if (!pronto) return false;
      if (precisaControlar && !navigator.serviceWorker.controller) {
        await Promise.race([new Promise((ok) => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true })), esperar(4000)]);
        if (!navigator.serviceWorker.controller) return false;
      }
      return true;
    } catch { return false; }
  }

  // ----------------------------------------------------------------------
  // Carregar o manifesto
  // ----------------------------------------------------------------------
  async function tentarUmaVez(id, chave) {
    let rm, re;
    try {
      [rm, re] = await Promise.all([
        fetch(`${BASE}p/${id}/m.bin`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }),
        fetch(`${BASE}p/${id}/expira.json`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }),
      ]);
    } catch { return { estado: "rede" }; }
    let expiraJson = null;
    if (re.ok) { try { const j = await re.json(); if (typeof j?.expira === "number" && Number.isFinite(j.expira)) expiraJson = j.expira; } catch {} }
    if (expiraJson !== null && expiraJson <= Date.now()) return { estado: "expirou" };
    if (rm.status === 404) return { estado: "pendente" };
    if (!rm.ok) return { estado: "rede" };
    let manifesto;
    try {
      const claro = await decifrar(chave, 0xFFFFFFFF, 0, await rm.arrayBuffer());
      manifesto = JSON.parse(new TextDecoder().decode(claro));
    } catch { return { estado: "chave" }; }
    const grupo = Painel.normalizar(manifesto);
    if (!grupo) return { estado: "formato" };
    if (grupo.expira <= Date.now()) return { estado: "expirou" };
    return { estado: "ok", manifesto, grupo };
  }

  async function carregar(id, chave, n = 0) {
    const inicio = Date.now();
    for (;;) {
      raiz.replaceChildren(el("main", { className: "aviso", role: "status" }, el("p", { className: "girar" }), el("h1", { texto: "Abrindo a prévia…" })));
      const r = await tentarUmaVez(id, chave);
      if (r.estado === "ok") {
        // Site da versão 2: só a chave e o prazo (sem manifesto), o bastante para recarregar site.html; o sw.js não serve site.
        // Versão 2 arquivo e versão 3 (grupo): o manifesto inteiro, de que o sw.js precisa para os itens de arquivo (ele só indexa esses)
        const soSite = r.manifesto.versao === 2 && r.manifesto.tipo === "site";
        await gravarRegistro(soSite ? { id, chave, expira: r.grupo.expira } : { id, chave, expira: r.grupo.expira, manifesto: r.manifesto });
        avisarWorker(id);
        return mostrar(id, chave, r.grupo, n);
      }
      if (r.estado === "expirou") { await apagarRegistro(id); avisarWorker(id); return avisoExpirou(); }
      if (r.estado === "chave") { const reg = await lerRegistro(id); if (reg && !reg.manifesto) await apagarRegistro(id); return avisoChave(); }
      if (r.estado === "formato") return avisoFormato();
      if (r.estado === "rede") return avisoRede(() => carregar(id, chave, n));
      // pendente: a prévia acabou de ser publicada e o GitHub Pages ainda não a mostra
      if (Date.now() - inicio + INTERVALO > LIMITE) { await apagarRegistro(id); return avisoSumiu(); }
      const m = aviso({ id: "aviso-chegando", girar: true, titulo: "A prévia está chegando, tente de novo em 1 minuto", texto: "Esta página tenta sozinha a cada 20 segundos, por até 5 minutos." });
      const contagem = el("p", { className: "detalhe" });
      m.append(contagem);
      const fim = Date.now() + INTERVALO;
      while (Date.now() < fim) { contagem.textContent = `Nova tentativa em ${Math.max(0, Math.ceil((fim - Date.now()) / 1000))} s`; await esperar(Math.min(1000, Math.max(20, fim - Date.now()))); }
    }
  }

  // ----------------------------------------------------------------------
  // Mostrar
  // ----------------------------------------------------------------------
  async function mostrar(id, chave, grupo, n) {
    const item = grupo.itens[n];
    if (!item) return avisoItem(id);
    document.title = `${item.nome} · Ginga Mídia`;
    if (item.tipo === "site") return abrirSite(id, n);
    return telaArquivo(id, chave, grupo, item);
  }

  // Site: vai para site.html (página própria, com CSP mais aberta), que decifra os arquivos e mostra o site num iframe com
  // sandbox sem allow-same-origin. Não precisa de service worker.
  function abrirSite(id, n) {
    location.replace(`${BASE}site.html?p=${id}&n=${n}`);
  }

  function telaArquivo(id, chave, grupo, item) {
    const arq = item.arquivos[0];
    const mime = String(arq.mime || "application/octet-stream").toLowerCase();
    // versão 3: o caminho virtual leva o número do item na frente (/v/<id>/<n>/<arquivo>); versão 2 não muda
    const virtual = `${BASE}v/${id}/${grupo.versao === 3 ? `${item.n}/` : ""}${arq.caminho.split("/").map(encodeURIComponent).join("/")}`;
    return prepararWorker(true).then((comWorker) => {
      const palco = el("main", { className: "palco", id: "palco" });
      // Com service worker o botão é um link para o caminho virtual com ?baixar=1 (resposta "attachment", decifrada aos pedaços,
      // sem pôr o arquivo na memória). O clique abre isso num quadro escondido: o "download" do <a> não passa pelo service worker no Chrome.
      const botao = comWorker
        ? el("a", { id: "baixar", className: "baixar", href: `${virtual}?baixar=1`, download: item.nome })
        : el("button", { id: "baixar", className: "baixar", type: "button" });
      if (comWorker) botao.addEventListener("click", (ev) => {
        ev.preventDefault();
        document.getElementById("quadro-baixar")?.remove();
        const q = el("iframe", { id: "quadro-baixar", hidden: true, title: "Download", tabIndex: -1 });
        q.setAttribute("aria-hidden", "true");
        q.src = botao.href;
        document.body.append(q);
      });
      botao.title = `Baixar o arquivo original (${tamanhoLegivel(arq.tamanho)})`;
      const { cabecalho } = Painel.montar({ id, grupo, n: item.n, base: BASE, baixar: botao });
      const rodape = el("footer", { className: "rodape", id: "rodape", texto: `Prévia enviada pela Ginga Mídia · disponível até ${formatarData(grupo.expira)}` });
      raiz.replaceChildren(cabecalho, palco, rodape);

      const mostrarMidia = (src) => {
        let m;
        if (mime.startsWith("image/")) m = el("img", { alt: item.nome, decoding: "async" });
        else if (mime.startsWith("video/")) m = el("video", { controls: true, playsInline: true, preload: "metadata" });
        else if (mime.startsWith("audio/")) m = el("audio", { controls: true, preload: "metadata" });
        else if (mime === "application/pdf") m = el("iframe", { title: item.nome });
        else {
          palco.replaceChildren(el("div", { className: "sem-previa" }, el("p", { texto: `Este tipo de arquivo (${tamanhoLegivel(arq.tamanho)}) não tem visualização aqui. Use o botão Baixar.` })));
          return;
        }
        m.classList.add("midia"); m.id = "midia";
        if (m.tagName === "VIDEO" || m.tagName === "AUDIO" || m.tagName === "IMG") m.addEventListener("error", () => {
          palco.replaceChildren(el("div", { className: "sem-previa", id: "erro-midia" }, el("p", { texto: "Este navegador não conseguiu mostrar o arquivo. Use o botão Baixar." })));
        });
        m.src = src;
        palco.replaceChildren(m);
      };

      if (comWorker) { mostrarMidia(virtual); return; }

      // Sem service worker: decifra o arquivo inteiro num Blob, com barra de progresso
      const barra = el("progress", { max: 1, value: 0, id: "progresso" });
      const legenda = el("p", { id: "progresso-texto", texto: "Preparando o arquivo… 0%" });
      palco.replaceChildren(el("div", { className: "progresso" }, legenda, barra));
      let blobPronto = null, emAndamento = null;
      const prepararBlob = () => emAndamento ||= (async () => {
        const partes = []; let feito = 0;
        for (let c = 0; c < arq.pedacos; c++) {
          const r = await fetch(`${BASE}p/${id}/${arq.i}-${c}.bin`, { credentials: "omit", referrerPolicy: "no-referrer" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const claro = await decifrar(chave, arq.i, c, await r.arrayBuffer());
          partes.push(claro); feito += claro.byteLength;
          barra.value = feito / Math.max(1, arq.tamanho);
          legenda.textContent = `Preparando o arquivo… ${Math.floor(100 * feito / Math.max(1, arq.tamanho))}%`;
        }
        return (blobPronto = new Blob(partes, { type: arq.mime }));
      })();
      botao.addEventListener("click", async () => {
        try {
          const blob = blobPronto || await prepararBlob();
          const url = URL.createObjectURL(blob);
          const a = el("a", { href: url, download: item.nome }); document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch { palco.replaceChildren(el("div", { className: "sem-previa" }, el("p", { texto: "Não foi possível baixar o arquivo. Tente de novo." }))); }
      });
      prepararBlob().then((blob) => mostrarMidia(URL.createObjectURL(blob)))
        .catch(() => { palco.replaceChildren(el("div", { className: "sem-previa", id: "erro-midia" }, el("p", { texto: "Não foi possível carregar o arquivo. Atualize a página para tentar de novo." }))); });
    });
  }

  // ----------------------------------------------------------------------
  // Início
  // ----------------------------------------------------------------------
  function apagarFragmento(id) {
    try { history.replaceState(null, "", `${location.pathname}${id ? `?p=${id}` : ""}`); } catch {}
  }

  async function iniciar() {
    limparVencidas();
    const h = location.hash.slice(1);
    if (h) {
      const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(h);
      apagarFragmento(m ? m[1] : null);
      if (!m) return avisoIncompleto();
      let chave;
      try { chave = await crypto.subtle.importKey("raw", b64u(m[2]), "AES-GCM", false, ["decrypt"]); } catch { return avisoChave(); }
      // Guarda a chave já (não extraível) para o recarregar da página funcionar depois que o fragmento sumiu
      if (!(await lerRegistro(m[1]))) await gravarRegistro({ id: m[1], chave, expira: Date.now() + PROVISORIO }).catch(() => {});
      return carregar(m[1], chave, 0); // chegando pelo link com chave, abre o item 0
    }
    const p = new URLSearchParams(location.search).get("p");
    if (p && RE_ID.test(p)) {
      const reg = await lerRegistro(p);
      if (reg && reg.chave && reg.expira > Date.now()) {
        const v = new URLSearchParams(location.search).get("n");
        const n = v === null ? 0 : /^\d{1,3}$/.test(v) ? Number(v) : -1; // -1: número inválido, cai em "Item não encontrado"
        return carregar(p, reg.chave, n);
      }
      return aviso({ id: "aviso-fechada", titulo: "Abra o link da prévia de novo", texto: "Esta prévia não está guardada neste navegador. Abra o link inteiro, com tudo o que vem depois do #, ou peça um link novo a quem enviou." });
    }
    return aviso({ id: "aviso-inicio", titulo: "Prévias da Ginga Mídia", texto: "Abra o link completo da prévia que você recebeu, com tudo o que vem depois do #." });
  }
  iniciar().catch(() => avisoRede(() => location.reload()));
})();
