# Estado: visualizador público de prévias (GitHub Pages)
Autoria: Dominique-Oliveira-Claude🤖🧡 · 23/11/2026

## Rodada 1 (23/11): pronto e testado localmente, nada enviado ao GitHub
- `site/` (vai para o Pages): `index.html`, `visualizador.js`, `sw.js`, `estilo.css`, `.nojekyll` (a rodada 2 acrescenta `site.html` e `site.js`).
- `ferramentas/cifra-previas.mjs` (copiar para portal/lib): `novaPrevia`, `cifrarArquivo`, `cifrarSite`, `linkDaPrevia`, `decifrarParaTeste`, `lerManifesto`.
- `ferramentas/limpar-vencidas.mjs <pasta p> [--simular]`: apaga prévias vencidas, sem `expira.json` válido ou com prazo acima de 400 dias.
- `.github/workflows/pages.yml`: push no main, à mão e de hora em hora (minuto 17); limpa, faz commit, implanta `site/` + `p/`.
- `ferramentas/testar.mjs`: `node ferramentas/testar.mjs` (Chrome sem janela, ~30 s, capturas em /tmp/claude-1000/previas-github/). `MANTER=1` guarda a pasta temporária.

## Decisões
- (Substituída na rodada 2) Site em navegação de topo para `<escopo>v/<id>/`: ficava na origem do visualizador e lia a IndexedDB. Ver a Rodada 2.
- Download: o `download` do `<a>` não passa pelo service worker no Chrome (o pedido vai à rede e dá 404). O clique abre `?baixar=1` num quadro escondido (resposta `attachment`, decifrada por pedaços, sem CSP `sandbox`, que também cancela download). Sem service worker, vira Blob inteiro.
- Fragmento: some da barra (`replaceState`) e a barra fica `?p=<id>`; a chave fica na IndexedDB "ginga-previas" como CryptoKey não extraível (provisória por 10 min até abrir o manifesto, depois vale até o prazo; no site, só `{id, chave, expira}`, sem manifesto). O service worker apaga as vencidas ao ativar e a cada 60 s de uso.
- 404 não distingue "chegando" de "inexistente": repete a cada 20 s por 5 min e então diz "Prévia não encontrada".
- Arquivo vazio tem 0 pedaços. `caminho` de uma prévia de arquivo é o nome sem barras nem ponto inicial; `nome` guarda o original.

## Para quem publica sites (portal)
- Endereço absoluto começando com `/` (ex.: `/wp-content/x.css`) agora vale: o visualizador resolve a partir da raiz do site (query `?ver=` é ignorada). Recursos `https://` de fora passam direto (fonte, CSS, imagem, Google Tag de um WordPress).
- Arquivos ocultos (nome com ponto) e ligações simbólicas não entram. Pasta sem `index.html` não lista (404).
- O site roda isolado (ver Rodada 2), mas continue só publicando sites da Ginga ou de clientes confiáveis: ele ainda pode chamar a internet (https) e mostrar o que quiser na tela.

## Limites conhecidos
- Sem service worker (aba privada do Firefox, navegador antigo): arquivo cai para Blob inteiro (memória: ~1 GB no celular é o teto prático); o site abre mesmo sem service worker (ele não usa).
- Vídeo com Range precisa do service worker; no iOS Safari o service worker funciona, mas o navegador pode descartá-lo e a IndexedDB depois de dias sem uso (a pessoa reabre o link).
- GitHub Pages: site publicado até 1 GB, repositório recomendado até 1 GB, arquivo até 100 MB por commit pelo git (pedaços de 1 MiB passam fácil; o total da prévia cabe no teto do repositório). Prévia de 4 GB não cabe no Pages; o limite real é o do repositório.
- Prazo conferido pelo relógio do aparelho de quem abre.
- A CSP está no `<meta>` do `index.html` (estrita) e do `site.html` (aberta, ver Rodada 2); `<meta>` não suporta `frame-ancestors` e o Pages não deixa pôr cabeçalhos.

## Rodada 2 (23/11): falha de segurança do site corrigida
- Falha: o site era servido pelo `sw.js` em `/previas/v/<id>/`, na mesma origem do visualizador. Um script dele (ex.: Google Tag) lia a IndexedDB `ginga-previas` e pedia `/previas/v/<outro id>/...`, que o service worker decifrava.
- Agora: `index.html` guarda só a chave e vai para `site.html?p=<id>` (+ `&c=<página>`). `site.js` busca e decifra os arquivos, reescreve o HTML (DOMParser) com data: URL para CSS, JS, imagens, fontes, vídeos, `url()`, `@import`, `srcset`, e entrega por `srcdoc` a um iframe `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"` (sem allow-same-origin: origem opaca, sem IndexedDB, caches, cookies, localStorage, service worker nem `parent.document`).
- `sw.js` só serve `tipo: "arquivo"`; `/previas/v/<id>/` de site dá 404 (testado). Site não passa mais pelo service worker.
- CSP própria em `site.html` (mais aberta, porque o srcdoc herda a política da página-mãe; a proteção vem do sandbox). A página que guarda a chave não tem innerHTML com dado do manifesto.
- Navegação: script injetado no iframe manda `postMessage({ginga:"navegar", href})`; `site.js` só aceita do `event.source` do iframe, com exatamente essas duas chaves, e confere o caminho no manifesto (oculto, `..`, fora do manifesto: ignorado). Histórico do navegador por `pushState` (`?p=<id>&c=<página>`): voltar, avançar e recarregar funcionam. Âncoras `#` rolam dentro da página (o script trata, porque no srcdoc um `href="#x"` resolveria contra a página-mãe). Link externo abre em nova aba. Formulário GET relativo navega (a query é ignorada). PDF, imagem, áudio e vídeo locais abrem em nova aba por blob; HTML e SVG nunca.
- Prazo: com o site aberto, ao vencer o iframe some, aparece "Este link expirou" e a chave é apagada.
- Limite de 60 MB (soma dos arquivos do site, porque tudo vira data: URL na memória), com mensagem clara; o gancho `window.__PREVIAS_TESTE.limiteSite` baixa o limite no teste.
- `.github/workflows/pages.yml`: actions presas por SHA (checkout v7.0.1, setup-node v7.1.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1; tags leves, SHA do commit).
- Testes: `node ferramentas/testar.mjs` agora tem a sonda do site (indexedDB, caches, fetch de outra prévia, parent.document, top.location, localStorage, cookie, service worker: todos negados; o mesmo fetch feito pelo visualizador dá 200). Conferido de verdade: com `allow-same-origin` posto de propósito, a sonda lê tudo e o teste falha. Capturas em /tmp/claude-1000/previas-github/site-390.png e site-1440.png.

## Limites do site isolado
- O site não abre arquivo local por código: `fetch`/XHR/`import()` de arquivo do próprio site, imagem criada por script com caminho relativo, iframe local e Web Worker local falham (srcdoc não tem endereço de pasta). Só o que está no HTML e no CSS é reescrito (inclusive `data-src`/`data-srcset`).
- Sem `allow-same-origin` o site não tem cookie, localStorage nem sessionStorage (acessar lança SecurityError; um script que não trata o erro para). Sem `allow-modals` (alert/confirm/print não abrem) e sem `allow-top-navigation`.
- `<base>` é removido; `<meta http-equiv=refresh>` não é tratado. CSP e X-Frame-Options em `<meta>` do site são removidos (data: não passaria). `integrity`/`crossorigin` saem dos recursos locais.
- A memória guarda os data: URL (base64, ~1,33x) de tudo o que já foi aberto; o teto de 60 MB é pelo site inteiro.
- Link de uma página para outra recarrega a página inteira (o estado do site se perde); `#hash` em outra página rola depois do carregamento.
- Outro Pages da mesma conta (mesma origem) ainda lê a IndexedDB, onde ficam as chaves (não extraíveis) de arquivo e site: não publicar nada de terceiros em `gingamidia026.github.io`.

## Para a gerência publicar
1. Criar `gingamidia026/previas` (público) e em Settings > Pages escolher "GitHub Actions" como fonte.
2. Enviar este repositório (ou a pasta `site/` com `site.html` e `site.js`, `ferramentas/`, `.github/` e `p/`) ao ramo main; o fluxo roda sozinho.
3. Conferir a aba Actions e abrir https://gingamidia026.github.io/previas/ com uma prévia de teste.
4. O envio do portal precisa manter `site/`, `.github/` e `ferramentas/` no commit (ramo órfão forçado: copiar tudo, não só `p/`).

## Rodada 3 (25/11): painel, janela de compartilhamento e grupo (item 123 da plataforma)
- `site/painel.js` (novo, usado por `index.html` e `site.html`): barra do topo com o nome do item, **Baixar** (amarelo) e **Compartilhamento**; o botão abre um `<dialog>` modal que explica o link (um só, chave dentro do próprio link e nunca no GitHub, conteúdo cifrado, validade, quantos itens) e lista os itens (nome, tipo, tamanho) com Anterior e Próximo. Todo texto do manifesto entra por `textContent`.
- Manifesto versão 3 (`tipo: "grupo"`, até 100 itens): endereço `?p=<id>&n=<k>`; a versão 2 vira um grupo de 1 item e continua abrindo. A chave segue na IndexedDB (não extraível), nunca no HTML, na URL, no localStorage nem no sessionStorage (testado).
- Site: o painel fica fora do iframe isolado e sobrevive à navegação interna; Baixar entrega um `.zip` feito no navegador com os arquivos originais.
- `ferramentas/cifra-previas.mjs` ganhou `cifrarGrupo` (idêntico a `portal/lib/cifra-previas.mjs` da plataforma).
- Teste: `node ferramentas/testar.mjs` (25/11 07:0x): **380 conferências, 380 OK**, 390, 768 e 1440 px, grupo de imagem, site, PDF e vídeo. Capturas copiadas para `docs/compartilhar-capturas/` da plataforma.
- Nada enviado ao GitHub; a gerência publica depois (ver "Para a gerência publicar").
