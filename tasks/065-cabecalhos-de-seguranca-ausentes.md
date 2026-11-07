---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# Nenhum cabeçalho de segurança (CSP, frame-ancestors/X-Frame-Options) na API nem no SPA

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** cabeçalhos de segurança / clickjacking
- **Arquivos afetados:** `apps/server/src/app.ts:52-162` (SPA em `:147-157`), `apps/web/index.html`
- **Depende de / relacionado a:** 048 (a CSP seria a camada extra contra aquele XSS)
- **Esforço estimado:** P/M
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O site não diz ao navegador "não me coloque dentro de outra página" nem "só execute os meus scripts". São travas extras: elas não corrigem falhas, mas limitam o estrago quando uma acontece.

### Evidência e análise técnica
- Não há helmet, CSP, X-Frame-Options nem frame-ancestors em `apps/server/src`, no `Dockerfile` ou no compose.
- `apps/web/index.html` não tem meta CSP. O SPA é servido por `@fastify/static` (`app.ts:147-157`) só com `cache-control`.
- Só os downloads de anexo e `routes/agents.ts:303` mandam `nosniff`.

### Verificação (tentativa de refutação)
- O cookie `sameSite: 'lax'` não vai em iframe de outro site, o que já reduz muito o clickjacking.
- Não foi achado XSS no SPA, mas há markdown renderizado (`Markdown.tsx`) e o XSS de anexo da tarefa 048.
- O proxy de produção, que fica externo, pode já acrescentar esses cabeçalhos; isso não foi verificado.

### Impacto
Baixo hoje. Sem contenção, qualquer XSS futuro roda solto.

## Como reproduzir
`curl -I http://localhost:3000/` e `/api/health`: as respostas não trazem `content-security-policy` nem `x-frame-options`.

## Solução proposta
- Um hook `onSend` com `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: same-origin`.
- Uma CSP com `frame-ancestors 'none'; default-src 'self'`, ajustada às fontes do Google, ao script inline do tema (hash) e ao pdf.js.
- Registrar a decisão em `docs/001`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
@@
   await app.register(cookie);
   await app.register(rateLimit, { global: false });
+  app.addHook('onSend', async (_request, reply) => {
+    reply.header('x-frame-options', 'DENY');
+    reply.header('x-content-type-options', 'nosniff');
+    reply.header('referrer-policy', 'same-origin');
+  });
```

## Critérios de aceite
- [ ] Toda resposta traz os cabeçalhos.
- [ ] O SPA carrega sem violação de CSP (validar no e2e).
- [ ] `docs/001` atualizada.

## Testes recomendados
Integração conferindo os cabeçalhos em `/api/health` e em `/`, mais o e2e completo para pegar violações de CSP. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Não se sabe o que o proxy de produção já acrescenta.

## Análise (triagem)

Confirmado no código (app, 2026-11-07; sem triage, designada pela sessão principal): nenhuma resposta trazia `X-Frame-Options`, CSP ou `Referrer-Policy`; só os downloads de anexo (com a CSP `sandbox` da tarefa 048) e o download de `routes/agents.ts` mandavam `nosniff`. O SPA tem um `<script>` inline (o tema, antes da primeira pintura), as fontes do Google, o pdf.js com o worker servido pelo Vite e prévias por `blob:`. Achado extra no navegador: o Zod 4 testa `new Function("")` ao criar os schemas (JIT); sob uma CSP sem `unsafe-eval` ele cai no fallback, mas deixa uma violação de CSP no console a cada carga.

## Resolução (executor)

- `apps/server/src/security-headers.ts` (novo): hook `onSend` com `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: same-origin` em toda resposta; nas respostas `text/html` sem CSP própria, a CSP do SPA. Registrado em `buildApp` antes das rotas.
- CSP completa (`spaCsp`): `default-src 'self'; script-src 'self' <sha256 de cada script inline>; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Os hashes saem do `index.html` compilado, lido no boot (`WEB_DIST`): mudar o script do tema não exige mexer na CSP. Sem SPA servido, um HTML sai com `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
- A CSP `sandbox` dos downloads de anexo (tarefa 048) não é sobrescrita (o hook só define a CSP quando a rota não definiu); o PDF continua sem CSP. Os assets (JS, CSS, o worker do pdf.js) não recebem CSP.
- `packages/shared/src/zod-jitless.ts` (export `@moneyflow/shared/zod-jitless`): `z.config({ jitless: true })`, primeiro import do `apps/web/src/main.tsx`; a API não o importa.
- `docs/001` (linha "Cabeçalhos de segurança"), `docs/INDEX.md` e `docs/018` (a CSP do proxy da produção, se houver, vale junto).
- Testes: `apps/server/test/security-headers.test.ts` (o hash do script inline no `script-src`, as diretivas e nada de `unsafe-eval`; `/api/health`, `/api/auth/me` e um `/api` inexistente com os três cabeçalhos e sem CSP; `/`, uma rota do console e `/index.html` com a CSP do `index.html` servido por `WEB_DIST`; o asset sem CSP; sem SPA, a CSP mínima e a CSP própria da rota preservada). O `operation.test.ts` da tarefa 048 (sandbox nos downloads, PDF sem CSP) continua passando.
- Conferido no navegador (Chromium do Playwright, à mão, contra o build de produção do console servido pela API na 3099 com o banco de desenvolvimento): login e as telas `/`, `/entities`, `/caixas`, `/titles`, `/calendar`, `/flow`, `/reports`, `/contracts`, `/notes`, `/admin/ai`, `/account` e o PDF de um contrato no pdf.js, sem nenhuma violação de CSP (depois do `zod-jitless`) e com as fontes do Google carregando.

O que pode quebrar no e2e completo (não rodado aqui): imagens externas num markdown (do chat ou de um documento de contrato) deixam de carregar (`img-src` sem `https:`); qualquer `eval`/`new Function` no thread principal (o jsPDF traz o `canvg`, que só usa `Function("return this")` como último recurso e não chega lá); um `<script>` inline novo no `index.html` entra sozinho pelo hash, mas um inline injetado em tempo de execução não. Não foram exercitados no navegador: a exportação PDF (jsPDF), a gravação de áudio e o canvas com arraste; um teste e2e que falhe por `securitypolicyviolation`/console de erro aponta qual diretiva ajustar em `spaCsp`.
