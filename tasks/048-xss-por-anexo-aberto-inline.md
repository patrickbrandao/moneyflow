---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-07
commit: 9991a6b
---

# XSS armazenado por anexo aberto inline com o Content-Type de quem envia

- **Severidade:** alta
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** XSS armazenado / Content-Type controlado pelo usuário
- **Arquivos afetados:** `apps/server/src/routes/attachments.ts:39,46-52`, `apps/server/src/services/attachments.ts:88-91,117,222,230`, `apps/server/src/services/title-entry.ts:142`, `apps/server/src/services/statements.ts:419`, `packages/shared/src/agents/media.ts:58-67`, `apps/web/src/components/attachments/AttachmentsPanel.tsx:176,185`, `database/migrations/0011_attachments.sql:20-22`
- **Depende de / relacionado a:** 065 (CSP global é a camada extra); agrava 054 (restauração do dump)
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O sistema guarda o anexo com o tipo que o próprio remetente declara. Quando alguém clica em "Abrir", esse tipo vai para o navegador no mesmo endereço do console. Uma página HTML (ou um SVG com script) anexada roda como se fosse o próprio MoneyFlow, com o login de quem abriu. Se quem abre é um admin, o script tem os poderes do admin.

### Evidência e análise técnica
- Upload: `mime: r.headers['content-type'] ?? ''` (`routes/attachments.ts:39`). O `cleanMime` (`services/attachments.ts:88-91`) e o CHECK do banco (`0011_attachments.sql:20-22`) conferem só a sintaxe, então `text/html`, `image/svg+xml` e `application/xhtml+xml` passam. O valor é gravado como chegou (`services/attachments.ts:117`).
- Download: com `r.query.inline === '1'`, a resposta leva `content-type: file.mimeType` e `Content-Disposition: inline` (`routes/attachments.ts:46-52`). O `x-content-type-options: nosniff` não impede que o navegador renderize um `text/html` declarado.
- O front envia `file.type` (`apps/web/src/lib/upload.ts:16`): um `.html` comum já sobe como `text/html`, sem forjar requisição. "Abrir" e o clique no nome usam `attachmentUrl(row.id, true)` com `target="_blank"` (`AttachmentsPanel.tsx:176,185`), e o painel está na `EntityPage`.
- Para anexar a uma entidade basta `assertRegistryWrite` (editor de qualquer caixa). Na leitura, `caixaId === null` libera qualquer autenticado (`services/attachments.ts:222`), e o admin lê qualquer anexo (`:230`).
- Outros caminhos com o mime do cliente: anexo do chat (`chatMime` em `packages/shared/src/agents/media.ts:58-67`), `upload_file` do `/mcp`, lote de extrato (`services/statements.ts:419`) e o XML da NF-e (`services/title-entry.ts:142`, que grava o mime do cliente salvo `application/octet-stream`).

### Verificação (tentativa de refutação)
- `apps/server/src/app.ts` não tem `onSend`, helmet nem CSP. O `fastifyStatic` só define `cache-control`. Não há CSP no `Dockerfile`, no compose nem em `apps/web/index.html`.
- Documentos de contrato não são afetados: `contract-documents.ts:224,355` gravam sempre `application/pdf`, e o markdown fica em tabela.
- Nenhuma spec trata do tipo servido inline; não é intencional.

### Impacto
Um editor de qualquer caixa sobe a admin: o script chama, com o cookie do admin, `GET /api/backup/full` (senhas, chaves de IA, tokens), a revelação de senhas, a criação de usuários ou a restauração do dump.

## Como reproduzir
1. Como editor de uma caixa, `POST /api/attachments?target=entity&targetId=<entidade>&fileName=x.html` com `Content-Type: text/html` e um `<script>` que faz `fetch('/api/backup/full')`.
2. Como admin, abrir a entidade e clicar no nome do anexo (ou abrir `/api/attachments/<id>/download?inline=1`).
3. O script roda na origem do console com a sessão do admin.

## Solução proposta
- Servir inline só uma lista de tipos seguros: imagens raster, PDF, áudio, vídeo, `text/plain` e `text/markdown`. Qualquer outro tipo sai sempre como `attachment`.
- Mandar `Content-Security-Policy: sandbox` nas respostas de download que não são PDF. O PDF fica sem ela, porque o sandbox pode bloquear o visualizador do Chrome numa aba nova.
- NF-e: gravar sempre `application/xml` (`title-entry.ts:142`).
- Opcional: normalizar o mime no upload (`text/html`/SVG como `application/octet-stream`).
- Documentar os "tipos exibidos inline" em `docs/016-banco-de-dados.md` (Anexos) e `docs/025-chat-multimidia.md`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/routes/attachments.ts
+++ b/apps/server/src/routes/attachments.ts
@@
+/** Tipos que o navegador pode abrir inline sem executar script na origem do console. */
+const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/[a-z0-9.+-]+|video\/(mp4|webm)|text\/plain|text\/markdown)$/;
+
 export async function attachmentRoutes(app: FastifyInstance) {
@@
   app.get('/api/attachments/:id/download', async (r: Req, reply) => {
     const file = await attachments.downloadAttachment(r.ctx, param(r, 'id'));
-    const inline = r.query.inline === '1';
+    const inline = r.query.inline === '1' && INLINE_SAFE.test(file.mimeType);
     const content = Buffer.from(file.content);
@@
         .header('accept-ranges', 'bytes');
+    if (file.mimeType !== 'application/pdf') reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'");
--- a/apps/server/src/services/title-entry.ts
+++ b/apps/server/src/services/title-entry.ts
@@
-        mime: file.mime && file.mime !== 'application/octet-stream' ? file.mime : 'application/xml',
+        mime: 'application/xml',
```

## Critérios de aceite
- [ ] `text/html`, `image/svg+xml` e `application/xhtml+xml` com `inline=1` respondem `Content-Disposition: attachment`.
- [ ] Toda resposta de download que não é PDF leva `content-security-policy` com `sandbox`.
- [ ] As prévias de imagem, PDF, áudio e markdown do chat e dos contratos continuam funcionando.
- [ ] A NF-e enviada com `content-type: text/html` grava `application/xml`.
- [ ] Specs 016 e 025 atualizadas.

## Testes recomendados
Integração em `apps/server/test` (por exemplo `chat-media.test.ts`, ou um `attachments.test.ts` novo): subir um anexo de entidade com `text/html` e outro com `image/svg+xml`, baixar com `inline=1` e conferir os cabeçalhos. Conferir que `image/png` e `application/pdf` seguem inline (`contracts.test.ts:854` e `chat-media.test.ts:275` já usam `inline=1`). E2E opcional: "Abrir" num `.html` baixa o arquivo. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Leitura estática, sem execução. Os anexos antigos com tipo perigoso passam a ser só baixados. Falta CSP global no SPA (tarefa 065).

## Análise (triagem)

**Veredito: procede, reproduzido** (triagem em 2026-11-07, código do `1ebb073`).

**Reprodução.** Um teste de integração temporário, rodado no modo local e apagado depois (`pnpm --filter @moneyflow/server test:local`): um usuário comum, editor da caixa A, sobe três anexos numa entidade (`text/html`, `image/svg+xml` e `application/xhtml+xml`, corpo `<script>fetch("/api/backup/full")</script>`). O admin baixa cada um com `?inline=1`, e as três respostas saem assim:
`200`, `content-type` igual ao enviado, `content-disposition: inline; filename="x.html"` e nenhum `content-security-policy`. O navegador renderiza esse HTML/SVG na origem do console, com o cookie de quem abriu.

**Causa confirmada.**
- `apps/server/src/routes/attachments.ts`: o upload grava `r.headers['content-type']`. O download, com `inline === '1'`, devolve `file.mimeType` com `Content-Disposition: inline` sem filtrar o tipo. O `nosniff` não impede que um `text/html` declarado seja renderizado.
- `cleanMime` (`services/attachments.ts`) e o CHECK `attachments_mime_type_check` (0011) conferem só a sintaxe, não o tipo. Não é falha do banco: o banco pode guardar qualquer tipo, e quem decide o que pode ser exibido é quem serve o arquivo.
- `assertReadable`: anexo de entidade (`caixaId === null`) é legível por qualquer autenticado, e o admin lê tudo. Por isso um editor de qualquer caixa alcança o admin.
- O front usa `inline` em `AttachmentsPanel.tsx` (nome e "Abrir", em `target=_blank`; também a linha 140), `agents/AttachmentPreview.tsx` (img, PdfThumb/PdfViewer, fetch do markdown, AudioPlayer) e `contracts/DocumentView.tsx` (PdfViewer).
- Nenhum `onSend`, helmet ou CSP em `apps/server/src/app.ts` (grep sem resultados).

**Onde corrigir.** O ponto que cobre todos os caminhos de entrada (painel de anexos, chat/`chatMime`, `upload_file` do `/mcp`, lote de extrato e NF-e) é a rota de download. A lista de tipos seguros para inline e o `Content-Security-Policy: sandbox` ficam lá, como propõe o diff. Os ajustes por caminho de upload são uma camada extra, não a correção. NF-e: gravar sempre `application/xml` em `title-entry.ts`. Normalizar o mime no upload é opcional, e a recomendação é não fazer: o arquivo continua baixável com o tipo original, e a regra fica num lugar só.

**Cuidados para o executor.**
- O CSP `sandbox` numa resposta usada como sub-recurso (`<img>`, `<audio>`, `fetch` do markdown, pdf.js por fetch) não muda nada: CSP de resposta só vale para documentos. Mesmo assim, confirme as prévias pelo e2e de chat multimídia. Deixar o PDF sem sandbox, como proposto, mantém o visualizador do Chrome na aba nova.
- `text/markdown` e `text/plain` inline são seguros (não executam script). Mantenha `nosniff`.
- Anexos antigos com tipo perigoso passam a ser só baixados. Não precisa de migration.

**Arquivos afetados.** `apps/server/src/routes/attachments.ts` (principal), `apps/server/src/services/title-entry.ts` e um teste novo `apps/server/test/attachments.test.ts` (ou um `describe` em `operation.test.ts`, que já tem o bloco "anexos"). Specs: `docs/025-chat-multimidia.md` (download/Range) e a seção de anexos de `docs/016-banco-de-dados.md`, com o texto vindo do `app` como documentação. `database/` não muda, então não há parte do `dba`.

**Specs.** 016 (Anexos), 025 (download do anexo) e 002 (sessão em cookie, impacto na escalada para admin).

**Risco.** Alto: escalada de editor para admin e exfiltração do backup completo (senhas, chaves de IA, tokens). Correção pequena e localizada. O risco de regressão está nas prévias inline (imagem, PDF, áudio, markdown), que os testes existentes (`contracts.test.ts`, `chat-media.test.ts`, com `inline=1`) e o e2e de agentes cobrem.

**Como verificar.**
1. Integração: `text/html`, `image/svg+xml` e `application/xhtml+xml` com `inline=1` respondem `content-disposition: attachment…`. Todo download que não é PDF traz `content-security-policy` com `sandbox`. `image/png`, `application/pdf`, `audio/mpeg` e `text/markdown` seguem `inline`. A NF-e enviada como `text/html` grava `application/xml`.
2. `pnpm verify:quick` (com o teste novo/alterado). Opcional: `pnpm --filter @moneyflow/e2e exec playwright test agentes.spec.ts` para as prévias.

**Relacionadas.** 065 (CSP global no SPA, camada complementar; não bloqueia esta) e 054.

**Executor:** `app`. **Tipo:** bug. **Prioridade:** alta. Não depende de decisão de produto.

## Resolução (executor)

**O que mudou.**
- `apps/server/src/routes/attachments.ts`: lista `INLINE_SAFE` (imagens raster png/jpeg/gif/webp/avif, `application/pdf`, `audio/*`, `video/mp4`/`webm`, `text/plain`, `text/markdown`) exportada como `isInlineSafeMime`; o `?inline=1` só vale para esses tipos, o resto sai como `attachment`. Toda resposta de download que não é PDF leva `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; media-src 'self'`; o `nosniff` continua. A rota de download é o ponto único, então cobre todos os caminhos de entrada (painel, chat, `upload_file` do `/mcp`, extrato, NF-e) e os anexos antigos, sem migration.
- `apps/server/src/services/title-entry.ts`: o XML da NF-e é gravado sempre como `application/xml`.
- Não normalizei o mime no upload (recomendação da triagem).

**Testes.** `apps/server/test/operation.test.ts`, `describe('anexos')`: caso novo "tipos que executam script nunca abrem inline…" (editor anexa `text/html`, `image/svg+xml` e `application/xhtml+xml` a uma entidade; o admin baixa com `inline=1` e recebe `attachment`, `sandbox` e `nosniff`; png, mp3, markdown e texto seguem inline com o sandbox; o PDF inline sem CSP; sem `inline=1`, download). O caso da NF-e passou a enviar `content-type: text/html` e confere `application/xml` gravado. `contracts.test.ts` e `chat-media.test.ts` (que usam `inline=1`) passam sem mudança.

**Specs.** `docs/016-banco-de-dados.md` (Anexos: tipos exibidos inline e o CSP) e `docs/025-chat-multimidia.md` (download do anexo).

