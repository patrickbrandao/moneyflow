---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: fd7a041
---

# Limite de corpo do JSON: o `/mcp` recusa acima de 1 MB e as rotas públicas leem até 20 MB antes de recusar

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** limite de corpo no parser
- **Arquivos afetados:** `apps/server/src/app.ts:58,73-87`, `apps/server/src/routes/mcp.ts:132-133`, `packages/shared/src/agents/tools-mcp.ts:12`, `docs/027-tools-de-controle-total.md:27`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A tool `upload_file` do `/mcp` promete arquivos de até 5 MB, mas qualquer arquivo acima de uns 750 KB volta com erro 413, porque a API corta todo JSON em 1 MB. Ao mesmo tempo, rotas abertas sem login (login e webhook do Telegram) aceitam ler até 20 MB na memória antes de recusar.

### Evidência e análise técnica
- O parser de `application/json` da aplicação é registrado com `bodyLimit: UPLOAD_BODY_LIMIT` (≈ 20 MB) e, depois de ler o corpo inteiro, recusa acima de 1 MB toda rota que não seja `config.rawUpload` (`app.ts:76-84`). O de `text/plain`/`*` também usa 20 MB (`app.ts:85-87`).
- No Fastify 5, a rota sem `bodyLimit` próprio fica com `_parserOptions.limit = null` (`fastify/lib/route.js:381`) e o `rawBody` usa então o limite do parser (`content-type-parser.js:244-252`). Resultado: o `bodyLimit: 1024 * 1024` do servidor (`app.ts:58`) não vale para nenhuma rota, e todas leem até 20 MB.
- `/mcp`: a rota declara `bodyLimit` de ≈ 7 MB para o `upload_file` em base64 (`mcp.ts:132-133`, `MCP_UPLOAD_MAX_BYTES = 5 MB`), mas não tem `rawUpload`. O parser lê os 7 MB e responde 413 pela checagem de 1 MB. A spec diz "o conteúdo em base64 até 5 MB (o corpo do `/mcp` aceita até ~7 MB)" (`docs/027:27`). O limite real é ≈ 768 KB de arquivo.
- O 413 sai pelo `setErrorHandler` como `{ code: 'bad_request', message: t.errors.validation }` (`app.ts:109-111`), não como JSON-RPC, e o cliente MCP vê uma falha de transporte.
- Rotas públicas (o `onRequest` não pede sessão): `/api/auth/login`, `/api/auth/logout` e `/api/telegram/webhook/:id`, que autentica pelo segredo só no handler, depois de ler o corpo. Cada requisição pode manter até 20 MB em memória (e o `Buffer.concat`). O limite de login (10 por minuto por IP) não protege o webhook nem o logout.

### Verificação (tentativa de refutação)
- Todas as rotas `rawUpload` já declaram `bodyLimit: UPLOAD_BODY_LIMIT` na própria rota (`attachments.ts:48`, `statements.ts:48,52`, `agents.ts:97`, `operation.ts:34,41`, `contracts.ts:29`), então o limite de 20 MB no parser não é necessário para elas. O backup tem parser próprio no escopo dele (`backup.ts:42`).
- O teste do `upload_file` (`agent-tools.test.ts:605-615`) usa um OFX pequeno e não passa de 1 MB.
- Nenhuma defesa no proxy da produção foi vista (projeto externo).

### Impacto
- Cliente MCP que sobe um PDF ou extrato comum (1 a 5 MB) falha sempre, contra o que a spec e a descrição da tool prometem.
- Sem login, poucas dezenas de corpos de 20 MB em paralelo ocupam centenas de MB da API.

## Como reproduzir
1. Token pessoal e um cliente MCP (ou `curl` com o JSON-RPC de `tools/call`) chamando `upload_file` com um arquivo de 2 MB em base64: resposta HTTP 413.
2. `curl -X POST /api/telegram/webhook/<uuid> -H 'content-type: application/json' --data-binary @arquivo-de-15MB.json`: a API lê os 15 MB e só então responde 413.

## Solução proposta
Tirar o `bodyLimit` dos dois parsers da aplicação (assim cada rota usa o próprio, ou o de 1 MB do servidor) e a checagem manual de 1 MB:

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
-  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (request, body, done) => {
+  // Sem bodyLimit aqui: vale o da rota (uploads e /mcp declaram o deles) ou o de 1 MB do servidor.
+  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
     if (isUpload(request)) return done(null, body);
-    if (body.length > 1024 * 1024) return done(Object.assign(new Error('payload too large'), { statusCode: 413 }), undefined);
     try {
       done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
@@
-  app.addContentTypeParser(['text/plain', '*'], { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (request, body, done) =>
+  app.addContentTypeParser(['text/plain', '*'], { parseAs: 'buffer' }, (request, body, done) =>
```
Opcional: devolver o 413 com `code: 'payload_too_large'` em vez de `bad_request`.

## Critérios de aceite
- [ ] `upload_file` com 4 MB de arquivo pelo `/mcp` grava o anexo.
- [ ] `POST /api/auth/login` e o webhook com corpo de 2 MB respondem 413 sem ler mais que 1 MB (com `content-length`, sem ler nada).
- [ ] Os uploads de 20 MB das rotas `rawUpload` continuam funcionando.

## Testes recomendados
- `apps/server/test/agent-tools.test.ts`: `upload_file` com ~2 MB pelo cliente MCP, esperando o `attachmentId`.
- `apps/server/test/auth.test.ts` ou `security-headers.test.ts`: `inject` de 2 MB em `/api/auth/login` e em `/api/telegram/webhook/:id`, esperando 413.

## Limitações e suposições
Nada foi executado. O caminho do limite foi lido no Fastify 5.12.5 instalado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no Fastify 5.12.5 instalado: o parser registrado com `bodyLimit` próprio vale para toda rota sem `bodyLimit` (`_parserOptions.limit = null` → o limite do parser), então todas as rotas liam até 20 MB, e a checagem manual de 1 MB depois da leitura recusava o `/mcp` (que declara ~7 MB, mas não é `rawUpload`). Todas as rotas `rawUpload` já declaram `bodyLimit: UPLOAD_BODY_LIMIT`; o backup tem parser próprio no escopo dele.

## Resolução (executor)

- `apps/server/src/app.ts`: os parsers de `application/json` e de `text/plain`/`*` ficam sem `bodyLimit` (assim vale o da rota ou o de 1 MB do servidor, e o Fastify recusa pelo `content-length` antes de ler) e sem a checagem manual de 1 MB. O 413 responde `payload_too_large` com `t.errors.payloadTooLarge` (antes, `bad_request` com "Dados inválidos.").
- Efeito: o `/mcp` aceita o `upload_file` de até 5 MB, como a spec 027 promete; o login, o logout e o webhook do Telegram, sem sessão, não leem mais de 1 MB; os uploads crus seguem em 20 MB pela rota; as demais rotas JSON continuam em 1 MB.
- Testes: `apps/server/test/agent-tools.test.ts` ("o upload_file pelo /mcp aceita até 5 MB…": 4 MB de arquivo pelo cliente MCP grava o anexo, e um PDF de ~3 MB pela rota de upload cru continua aceito) e `apps/server/test/auth.test.ts` ("limite do corpo nas rotas sem sessão": 2 MB em JSON no login e no webhook, e em texto puro no login, dão 413 `payload_too_large`).
- Spec: `docs/001`, linha "Limite do corpo".
- Verificação: `pnpm verify:quick` (com `test/auth.test.ts` e o caso novo de `test/agent-tools.test.ts`).
