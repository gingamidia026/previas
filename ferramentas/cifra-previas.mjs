// Cifra das prévias da Ginga Mídia (formato versão 2 e, desde o item 123, versão 3 de grupo; o mesmo do visualizador em site/).
// Só módulos nativos do Node, sem caminho fixo: este arquivo é copiado para o portal (portal/lib).
//
// Formato (resumo; texto completo no plano dos itens 116 e 117):
//   id     = 16 bytes aleatórios em base64url (22 caracteres)
//   chave  = 32 bytes aleatórios em base64url (43 caracteres); vai só no fragmento do link (depois do #)
//   pedaço = até 1 MiB de conteúdo cifrado com AES-256-GCM; arquivo .bin = texto cifrado + etiqueta de 16 bytes
//   nonce  = 12 bytes = índice do arquivo (uint32 big-endian) + índice do pedaço (uint64 big-endian)
//            o manifesto usa índice de arquivo 0xFFFFFFFF e pedaço 0
//   pasta  = <destino>/<id>/expira.json, m.bin (manifesto cifrado) e <i>-<pedaço>.bin
//   arquivo vazio: 0 pedaços (nenhum .bin)
// Tudo é feito por fluxo: lê e grava um pedaço de cada vez (1 MiB na memória), então aguenta arquivo de vários GB.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const TAMANHO_PEDACO = 1024 * 1024;
export const INDICE_MANIFESTO = 0xFFFFFFFF;
export const RE_ID = /^[A-Za-z0-9_-]{22}$/;
export const RE_CHAVE = /^[A-Za-z0-9_-]{43}$/;

const TIPOS_MIME = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
  webmanifest: "application/manifest+json", txt: "text/plain", xml: "application/xml", csv: "text/csv", map: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg",
  pdf: "application/pdf", zip: "application/zip", wasm: "application/wasm",
};
export function mimeDe(nome) {
  const ext = (String(nome).match(/\.([A-Za-z0-9]+)$/)?.[1] || "").toLowerCase();
  return TIPOS_MIME[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Identificadores e link
// ---------------------------------------------------------------------------
export function novaPrevia() {
  return { id: crypto.randomBytes(16).toString("base64url"), chave: crypto.randomBytes(32).toString("base64url") };
}

export function linkDaPrevia(base, id, chave) {
  if (!RE_ID.test(id)) throw new Error("id inválido (esperado: 22 caracteres base64url)");
  if (!RE_CHAVE.test(chave)) throw new Error("chave inválida (esperado: 43 caracteres base64url)");
  return `${String(base).replace(/#.*$/, "").replace(/\/*$/, "/")}#${id}.${chave}`;
}

function conferirIdChave(id, chave) {
  if (!RE_ID.test(id || "")) throw new Error("id inválido (esperado: 22 caracteres base64url)");
  if (!RE_CHAVE.test(chave || "")) throw new Error("chave inválida (esperado: 43 caracteres base64url)");
  return Buffer.from(chave, "base64url");
}

// ---------------------------------------------------------------------------
// Cifra de um pedaço
// ---------------------------------------------------------------------------
function nonce(indiceArquivo, indicePedaco) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(indiceArquivo >>> 0, 0);
  n.writeBigUInt64BE(BigInt(indicePedaco), 4);
  return n;
}

function cifrarPedaco(chaveBytes, indiceArquivo, indicePedaco, dados) {
  const c = crypto.createCipheriv("aes-256-gcm", chaveBytes, nonce(indiceArquivo, indicePedaco), { authTagLength: 16 });
  return Buffer.concat([c.update(dados), c.final(), c.getAuthTag()]);
}

function decifrarPedaco(chaveBytes, indiceArquivo, indicePedaco, bin) {
  if (bin.length < 16) throw new Error("pedaço cifrado curto demais");
  const d = crypto.createDecipheriv("aes-256-gcm", chaveBytes, nonce(indiceArquivo, indicePedaco), { authTagLength: 16 });
  d.setAuthTag(bin.subarray(bin.length - 16));
  return Buffer.concat([d.update(bin.subarray(0, bin.length - 16)), d.final()]);
}

// Lê e cifra um arquivo em pedaços de 1 MiB, gravando <pasta>/<i>-<pedaço>.bin. Devolve {tamanho, pedacos}.
// Abre SEM seguir ligação simbólica; se vier `esperado` ({ dev, ino } do lstat feito antes), o descritor aberto tem de ser o mesmo arquivo.
async function cifrarArquivoEmPedacos(pasta, chaveBytes, indice, caminhoReal, esperado = null) {
  const fh = await fsp.open(caminhoReal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`não é arquivo comum: ${caminhoReal}`);
    if (esperado && (st.dev !== esperado.dev || st.ino !== esperado.ino)) throw new Error("o arquivo mudou durante a publicação; tente de novo");
    const buf = Buffer.allocUnsafe(TAMANHO_PEDACO);
    let total = 0, pedaco = 0;
    for (;;) {
      let lidos = 0;
      while (lidos < TAMANHO_PEDACO) {
        const { bytesRead } = await fh.read(buf, lidos, TAMANHO_PEDACO - lidos, total + lidos);
        if (bytesRead === 0) break;
        lidos += bytesRead;
      }
      if (lidos === 0) break;
      await fsp.writeFile(path.join(pasta, `${indice}-${pedaco}.bin`), cifrarPedaco(chaveBytes, indice, pedaco, buf.subarray(0, lidos)));
      total += lidos; pedaco++;
      if (lidos < TAMANHO_PEDACO) break;
    }
    return { tamanho: total, pedacos: pedaco };
  } finally { await fh.close(); }
}

async function gravarManifestoEPrazo(pasta, chaveBytes, manifesto) {
  const json = Buffer.from(JSON.stringify(manifesto), "utf8");
  await fsp.writeFile(path.join(pasta, "m.bin"), cifrarPedaco(chaveBytes, INDICE_MANIFESTO, 0, json));
  // expira.json por último: a prévia só "existe" para a limpeza quando já está completa
  await fsp.writeFile(path.join(pasta, "expira.json"), JSON.stringify({ expira: manifesto.expira }));
}

async function prepararPasta(destino, id) {
  const pasta = path.join(path.resolve(destino), id);
  await fsp.mkdir(path.resolve(destino), { recursive: true });
  try { await fsp.mkdir(pasta); } catch (e) { if (e.code === "EEXIST") throw new Error(`a prévia ${id} já existe em ${destino}`); throw e; }
  return pasta;
}

function conferirExpira(expira) {
  if (!Number.isFinite(expira) || expira <= 0) throw new Error("expira deve ser um número (milissegundos desde 1970)");
  return Math.floor(expira);
}

// Nome do arquivo como caminho virtual: sem barras, sem controle, sem começar por ponto (parte oculta é recusada pelo visualizador)
export function caminhoSeguroDoNome(nome) {
  let c = String(nome || "arquivo").normalize("NFC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  c = c.replace(/^\.+/, (p) => "_".repeat(p.length));
  return (c || "arquivo").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Prévia de arquivo (imagem, vídeo, áudio, PDF ou qualquer outro)
// ---------------------------------------------------------------------------
// opções: { destino (pasta p/), id, chave, arquivo (caminho do original), nome (nome original, opcional), mime (opcional), expira (ms), criado (ms, opcional),
//           esperado (opcional: { dev, ino } do lstat feito antes; recusa se o arquivo aberto for outro) }
export async function cifrarArquivo({ destino, id, chave, arquivo, nome, mime, expira, criado, esperado = null }) {
  const chaveBytes = conferirIdChave(id, chave);
  expira = conferirExpira(expira);
  const nomeOriginal = String(nome || path.basename(arquivo));
  const pasta = await prepararPasta(destino, id);
  try {
    const caminho = caminhoSeguroDoNome(nomeOriginal);
    const { tamanho, pedacos } = await cifrarArquivoEmPedacos(pasta, chaveBytes, 0, arquivo, esperado);
    const manifesto = {
      versao: 2, tipo: "arquivo", nome: nomeOriginal, criado: Math.floor(criado ?? Date.now()), expira, entrada: caminho,
      arquivos: [{ i: 0, caminho, mime: mime || mimeDe(nomeOriginal), tamanho, pedacos }],
    };
    await gravarManifestoEPrazo(pasta, chaveBytes, manifesto);
    return { id, chave, pasta, manifesto };
  } catch (e) { await fsp.rm(pasta, { recursive: true, force: true }); throw e; }
}

// ---------------------------------------------------------------------------
// Prévia de site (pasta com index.html e o resto)
// ---------------------------------------------------------------------------
async function listarSite(raiz, rel = "", acumulado = { arquivos: [], ignorados: [] }) {
  const itens = await fsp.readdir(path.join(raiz, rel), { withFileTypes: true });
  itens.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const it of itens) {
    const relItem = rel ? `${rel}/${it.name}` : it.name;
    if (it.name.startsWith(".")) { acumulado.ignorados.push({ caminho: relItem, motivo: "oculto" }); continue; }
    if (it.isSymbolicLink()) { acumulado.ignorados.push({ caminho: relItem, motivo: "ligação simbólica" }); continue; }
    if (it.isDirectory()) await listarSite(raiz, relItem, acumulado);
    else if (it.isFile()) acumulado.arquivos.push(relItem);
    else acumulado.ignorados.push({ caminho: relItem, motivo: "não é arquivo comum" });
  }
  return acumulado;
}

// opções: { destino, id, chave, pasta (pasta do site), entrada ("index.html"), nome, expira, criado }
export async function cifrarSite({ destino, id, chave, pasta: pastaSite, entrada = "index.html", nome, expira, criado }) {
  const chaveBytes = conferirIdChave(id, chave);
  expira = conferirExpira(expira);
  const raiz = path.resolve(pastaSite);
  const { arquivos: lista, ignorados } = await listarSite(raiz);
  if (!lista.includes(entrada)) throw new Error(`o site não tem o arquivo de entrada "${entrada}"`);
  if (lista.length === 0) throw new Error("o site está vazio");
  const pasta = await prepararPasta(destino, id);
  try {
    const arquivos = [];
    for (let i = 0; i < lista.length; i++) {
      const caminho = lista[i];
      const { tamanho, pedacos } = await cifrarArquivoEmPedacos(pasta, chaveBytes, i, path.join(raiz, caminho));
      arquivos.push({ i, caminho, mime: mimeDe(caminho), tamanho, pedacos });
    }
    const manifesto = { versao: 2, tipo: "site", nome: String(nome || path.basename(raiz)), criado: Math.floor(criado ?? Date.now()), expira, entrada, arquivos };
    await gravarManifestoEPrazo(pasta, chaveBytes, manifesto);
    return { id, chave, pasta, manifesto, ignorados };
  } catch (e) { await fsp.rm(pasta, { recursive: true, force: true }); throw e; }
}

// ---------------------------------------------------------------------------
// Grupo de prévias (item 123, 25/11/2026): vários arquivos e sites com UM só id e UMA só chave (a criptografia de sempre vale
// para o grupo inteiro; o link é um só). Manifesto versão 3:
//   { versao: 3, tipo: "grupo", nome, criado, expira, itens: [ { n, tipo: "arquivo"|"site", nome, entrada, arquivos: [...] } ] }
// O índice `i` dos arquivos é único no grupo inteiro (o nonce usa esse índice), então cada pedaço continua com nonce próprio.
// Item do grupo: { tipo: "arquivo", arquivo (caminho real), nome, mime?, esperado? } ou { tipo: "site", pasta, entrada, nome }.
// ---------------------------------------------------------------------------
export const LIMITE_ITENS_GRUPO = 100;
export async function cifrarGrupo({ destino, id, chave, itens, nome, expira, criado }) {
  const chaveBytes = conferirIdChave(id, chave);
  expira = conferirExpira(expira);
  if (!Array.isArray(itens) || itens.length < 1) throw new Error("o grupo está vazio");
  if (itens.length > LIMITE_ITENS_GRUPO) throw new Error(`o grupo passa de ${LIMITE_ITENS_GRUPO} itens`);
  // Confere tudo antes de criar a pasta
  const listas = [];
  for (const it of itens) {
    if (it?.tipo === "site") {
      const raiz = path.resolve(it.pasta);
      const { arquivos: lista, ignorados } = await listarSite(raiz);
      const entrada = it.entrada || "index.html";
      if (!lista.includes(entrada)) throw new Error(`o site "${it.nome}" não tem o arquivo de entrada "${entrada}"`);
      listas.push({ raiz, lista, entrada, ignorados });
    } else if (it?.tipo === "arquivo") listas.push(null);
    else throw new Error("item de grupo com tipo desconhecido");
  }
  const pasta = await prepararPasta(destino, id);
  try {
    const manifestoItens = [], jaCifradas = new Map(); let proximo = 0;
    for (let n = 0; n < itens.length; n++) {
      const it = itens[n];
      const arquivos = []; let entrada;
      if (it.tipo === "arquivo") {
        const nomeOriginal = String(it.nome || path.basename(it.arquivo));
        const caminho = caminhoSeguroDoNome(nomeOriginal);
        const i = proximo++;
        const { tamanho, pedacos } = await cifrarArquivoEmPedacos(pasta, chaveBytes, i, it.arquivo, it.esperado || null);
        arquivos.push({ i, caminho, mime: it.mime || mimeDe(nomeOriginal), tamanho, pedacos });
        entrada = caminho;
        manifestoItens.push({ n, tipo: "arquivo", nome: nomeOriginal, entrada, arquivos });
      } else {
        const { raiz, lista } = listas[n];
        // Vários itens da mesma pasta (páginas diferentes do mesmo site) repartem os mesmos arquivos cifrados, sem gravar de novo
        if (!jaCifradas.has(raiz)) {
          const feitos = [];
          for (const caminho of lista) {
            const i = proximo++;
            const { tamanho, pedacos } = await cifrarArquivoEmPedacos(pasta, chaveBytes, i, path.join(raiz, caminho));
            feitos.push({ i, caminho, mime: mimeDe(caminho), tamanho, pedacos });
          }
          jaCifradas.set(raiz, feitos);
        }
        manifestoItens.push({ n, tipo: "site", nome: String(it.nome || path.basename(raiz)), entrada: listas[n].entrada, arquivos: jaCifradas.get(raiz) });
      }
    }
    const manifesto = { versao: 3, tipo: "grupo", nome: String(nome || manifestoItens[0].nome).slice(0, 200), criado: Math.floor(criado ?? Date.now()), expira, itens: manifestoItens };
    await gravarManifestoEPrazo(pasta, chaveBytes, manifesto);
    return { id, chave, pasta, manifesto };
  } catch (e) { await fsp.rm(pasta, { recursive: true, force: true }); throw e; }
}

// ---------------------------------------------------------------------------
// Decifrar (para teste e para o portal conferir o que publicou)
// ---------------------------------------------------------------------------
export async function lerManifesto({ destino, id, chave }) {
  const chaveBytes = conferirIdChave(id, chave);
  const bin = await fsp.readFile(path.join(path.resolve(destino), id, "m.bin"));
  return JSON.parse(decifrarPedaco(chaveBytes, INDICE_MANIFESTO, 0, bin).toString("utf8"));
}

// Decifra a prévia inteira para a pasta `saida`, por fluxo. Devolve o manifesto.
export async function decifrarParaTeste({ destino, id, chave, saida }) {
  const chaveBytes = conferirIdChave(id, chave);
  const manifesto = await lerManifesto({ destino, id, chave });
  const pasta = path.join(path.resolve(destino), id);
  const raizSaida = path.resolve(saida);
  const todos = manifesto.versao === 3 ? manifesto.itens.flatMap((it) => it.arquivos.map((a) => ({ ...a, caminho: `${it.n}/${a.caminho}` }))) : manifesto.arquivos;
  for (const arq of todos) {
    const alvo = path.resolve(raizSaida, ...arq.caminho.split("/"));
    if (alvo !== raizSaida && !alvo.startsWith(raizSaida + path.sep)) throw new Error(`caminho fora da pasta de saída: ${arq.caminho}`);
    await fsp.mkdir(path.dirname(alvo), { recursive: true });
    const fd = await fsp.open(alvo, "w");
    try {
      let total = 0;
      for (let p = 0; p < arq.pedacos; p++) {
        const dados = decifrarPedaco(chaveBytes, arq.i, p, await fsp.readFile(path.join(pasta, `${arq.i}-${p}.bin`)));
        await fd.write(dados);
        total += dados.length;
      }
      if (total !== arq.tamanho) throw new Error(`tamanho de ${arq.caminho} não confere (${total} em vez de ${arq.tamanho})`);
    } finally { await fd.close(); }
  }
  return manifesto;
}

