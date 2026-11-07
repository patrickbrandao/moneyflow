---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-07
commit: 9991a6b
---

# O guard de sessão compara a URL crua e o roteador a decodifica: `/%61pi/...` escapa da autenticação

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** bypass de autenticação (normalização de caminho)
- **Arquivos afetados:** `apps/server/src/app.ts:108-118`, `apps/server/src/routes/entities.ts:61-62`, `apps/server/src/integrations/lookup.ts:138-140`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O "porteiro" da API confere se o endereço começa com "/api/" na forma como foi escrito. Se uma letra vier codificada (`%61` é o "a"), o porteiro não reconhece o endereço. O roteador, por dentro, entende normalmente e atende sem login.

### Evidência e análise técnica
- `app.ts:110-112`: `const path = request.url.split('?')[0]!; if (!path.startsWith('/api/') || PUBLIC.has(path) || ...) return;`. `request.url` é `raw.url`, cru (`fastify@5.12.5/lib/request.js:165-167`).
- `find-my-way@9.10.0`: `Router.prototype.find` (`index.js:610-636`) decodifica o caminho inteiro antes de percorrer a árvore. `%61` não está na tabela de reservados (`lib/url-sanitizer.js`), então `decodeURI` transforma `/%61pi/lookup/cnpj/X` em `/api/lookup/cnpj/X`, que casa a rota.
- Segundo vetor: request-target absoluta (`GET http://host/api/lookup/cep/...`). O `raw.url` começa com `http`, e o roteador usa `getPathFromAbsoluteUrl` (`index.js:615-620`).
- As rotas `/api/lookup/cnpj/:value` e `/api/lookup/cep/:value` (`routes/entities.ts:61-62`) não usam `r.ctx` e respondem de verdade. As demais leem `r.ctx`, que fica nulo e provavelmente vira TypeError/500.

### Verificação (tentativa de refutação)
- O `app.ts` inteiro foi lido: há um único `onRequest` de sessão, sem `onRoute` nem preHandler por rota.
- `caseSensitive` é true por padrão, então `/API/` não funciona, mas `%61` funciona.
- O comentário em `app.ts:108` diz "toda rota /api ... exige cookie". Não é intencional. O teste `test/lookup.test.ts:160` cobre só o 401 na URL normal.

### Impacto
- Qualquer anônimo usa a consulta de CNPJ, que gasta a cota da chave paga do CNPJ Aberto (`lookup.ts:138-140`), e a de CEP: o servidor vira um proxy aberto para esses provedores.
- O defeito é estrutural: qualquer rota futura que não dependa de `ctx` fica pública.

## Como reproduzir
`GET /%61pi/lookup/cep/01001000` sem cookie responde com os dados do CEP em vez de 401.

## Solução proposta
- Decidir pela rota já resolvida pelo roteador (`request.routeOptions.url`), não pela URL crua.
- Alternativa: marcar as rotas públicas com `config: { public: true }` e exigir sessão em todas as outras.
- Opcional: responder 400 a request-target que não começa com `/`.
- Registrar em `docs/002` que a sessão é exigida por rota.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
@@
   app.addHook('onRequest', async (request) => {
-    const path = request.url.split('?')[0]!;
+    // O padrão da rota já resolvido pelo roteador (decodificado), não a URL crua.
+    const path = request.routeOptions.url;
+    if (path === undefined) return; // 404 do setNotFoundHandler
     // O webhook do Telegram (spec 029) não tem sessão: autentica pelo segredo do cabeçalho.
     if (!path.startsWith('/api/') || PUBLIC.has(path) || path.startsWith('/api/telegram/webhook/')) return;
```
Conferir que `PUBLIC` bate com os padrões registrados, que são estáticos, e que o `/*` do SPA e o `/mcp` seguem fora do guard.

## Critérios de aceite
- [ ] `GET /%61pi/lookup/cep/01001000`, `GET /api/lookup/%63ep/01001000` e `GET http://x/api/lookup/cep/01001000` sem cookie respondem 401.
- [ ] As rotas públicas, o webhook do Telegram e o `/mcp` continuam funcionando.

## Testes recomendados
`test/lookup.test.ts`, ou um novo `test/auth-guard.test.ts`, com `inject` nas três formas acima esperando 401. Incluir um GET autenticado com caminho codificado, para provar que continua funcionando com o cookie. Nada disso foi executado nesta auditoria.

## Limitações e suposições
A conclusão vem da leitura do código do find-my-way 9.10.0 e do Fastify 5.12.5 instalados, sem execução.

## Análise (triagem)

Confirmado no código atual: o `onRequest` de `apps/server/src/app.ts` decidia por `request.url` cru, e o find-my-way decodifica antes de casar a rota. `/%61pi/lookup/cnpj/X` respondia 200 sem cookie (o teste novo falha com 200 no código antigo). Executor: app (sessão principal designou).

## Resolução (executor)

- `apps/server/src/app.ts`: o guard decide pelo padrão da rota já resolvido (`request.routeOptions.url`), com a URL crua como reforço. Exige sessão se a rota **ou** o caminho cru começa com `/api/`; as públicas (`PUBLIC`, padrões estáticos) e o webhook do Telegram são reconhecidos pelo padrão da rota. Sem rota casada (404), vale o caminho cru, então um `/api/...` inexistente segue 401 sem cookie e 404 com ele, como antes. `/mcp` e o `/*` do SPA (padrão sem `/api/`) seguem fora do guard; o `/*` com caminho cru `/api/...` continua pedindo sessão, como antes.
- Teste novo em `apps/server/test/lookup.test.ts` ("exige sessão mesmo com o caminho codificado ou a request-target absoluta"): `/%61pi/...`, `/api/lookup/%63npj/...` e `/api/%6cookup/cep/...` por `inject`, e `GET http://x/api/lookup/cnpj/...` por um socket de verdade (o `inject` normaliza a URL), todos 401 sem chamar o provedor; com cookie, o caminho codificado responde 200; `/api/nao-existe` 401 sem cookie e 404 com ele; `/api/health` 200.
- Spec: `docs/002-usuarios-e-permissoes.md` (sessão exigida por rota).
