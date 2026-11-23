---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: alta
criada: 2026-11-21
commit: 8ed8fd2
---

# Senhas e tokens vão em texto claro para o log quando uma consulta falha

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** segredo em log pelos parâmetros da consulta
- **Arquivos afetados:** `apps/server/src/app.ts:97-114`, `apps/server/src/main.ts:46-49`, `apps/server/src/services/users.ts:30-35,125,166,180`, `apps/server/src/services/messages.ts:173-177,196,486-495`, `apps/server/src/services/telegram-inbound.ts:183,234,321`, `apps/server/src/auth/bootstrap.ts:15`, `apps/server/src/services/ai-admin.ts:195`
- **Depende de / relacionado a:** tarefa 108 (a queda do banco é o gatilho mais comum)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se o banco de dados piscar (reinício, conexão caída) enquanto alguém faz login, a senha digitada fica gravada por extenso no log da API. O mesmo vale para o token do bot do Telegram, a senha de um usuário criado pelo admin e a chave de um provedor de IA. Quem lê os logs passa a ver segredos que o sistema promete nunca registrar.

### Evidência e análise técnica
- O Drizzle 0.45 embrulha toda falha de consulta em `DrizzleQueryError`, cuja mensagem é `Failed query: <sql>\nparams: <valores>` e que guarda `query` e `params` como propriedades próprias (`node_modules/.pnpm/drizzle-orm@0.45.4_…/drizzle-orm/errors.js:10-19`; lançado em `pg-core/session.js:41-98`).
- O tratamento central (`app.ts:97-114`) só traduz erro de negócio (`AppError`) e erro do Postgres com código conhecido (`translateDbError`, que exige um código de 5 caracteres e `DB_CODE_MESSAGES`). Todo o resto — conexão recusada, "Connection terminated unexpectedly", 57P01, 53300, 40P01, 57014 — cai em `request.log.error(error)` (`app.ts:112`).
- O serializador de erro do pino (`pino-std-serializers@7.1.0/lib/err.js:28-40`) copia `message`, `stack` (que começa pela mensagem) e todas as propriedades enumeráveis: `params` vai inteiro para o JSON do log.
- Consultas com segredo em parâmetro na minha área:
  - `authenticate` e `changeOwnPassword`: `SELECT auth_login(${login}, ${password})` (`users.ts:166,180`);
  - `insertUser`/`updateUser`: a senha no INSERT/UPDATE (`users.ts:30-35,125`);
  - destino Telegram: `bot_token` no INSERT/UPDATE (`messages.ts:173-177,196`);
  - webhook: `telegram_webhook_authenticate(${destinationId}, ${secret})` (`telegram-inbound.ts:234`), e o código de pareamento (`telegram-inbound.ts:183,321`);
  - fora da área, pelo mesmo caminho: `api_key = ${input.apiKey}` (`ai-admin.ts:195`) e os cabeçalhos secretos do MCP.
- No boot, `main.ts:46-49` faz `console.error(error)`: se `ensureInitialAdmin` falhar (por exemplo, `ADMIN_EMAIL` que viola a CHECK de `users`), o `util.inspect` imprime a mensagem e `params` com o `ADMIN_PASSWORD`.
- Efeito colateral menor: `deliver` devolve `String(error.message)` ao "Enviar teste" (`messages.ts:495`), então a tela mostra o SQL do `message_destination_token`.

### Verificação (tentativa de refutação)
- `app.ts:54` só redige `req.headers.cookie` e `req.headers.authorization`; não há `serializers` próprios nem `redact` de `err.*` (procurei `serializers|redact` em `apps/server/src`).
- O worker usa `pino` cru (`main.ts:19`), também sem serializador.
- Os erros 23xxx de cadastro são traduzidos e não chegam ao log; o vazamento fica nas falhas de infraestrutura, que são justamente as que acontecem em reinício do banco e em deploy.
- A auditoria de 2026-11-07 (lote A) não registrou isto (nenhuma tarefa cita `DrizzleQueryError` ou `params`).
- AGENTS.md, "Regras da aplicação": a senha nunca vai a logs; o token do bot e as chaves de IA ficam fora de logs.

### Impacto
Durante qualquer instabilidade do banco, cada login gera uma linha de log com usuário e senha em texto puro (a senha é texto puro por decisão do produto, então o log vira uma cópia da coluna blindada). Logs costumam ir para agregadores com retenção longa e acesso mais amplo que o banco.

## Como reproduzir
1. `pnpm dev` com o Postgres local.
2. Pare o Postgres (`make -C database down`, ou `pg_terminate_backend` das conexões da aplicação).
3. `POST /api/auth/login` com `{"login":"admin","password":"Senha-De-Teste"}`.
4. O log da API mostra `"err":{"type":"DrizzleQueryError","message":"Failed query: select auth_login($1, $2) as id\nparams: admin,Senha-De-Teste", "params":["admin","Senha-De-Teste"], …}`.

## Solução proposta
1. Em `errors.ts`, um `safeError(error)` para log: se o erro tem `query` e `params` (o `DrizzleQueryError`), devolve `{ type, message: 'Failed query: ' + query, query, cause }` com a causa (o erro do `pg`, sem os valores) e sem `params`; a pilha é reconstruída sem a linha `params:`.
2. Usar esse serializador como `serializers.err` no logger do Fastify (`app.ts:54`) e no `pino` do worker (`main.ts:19`); trocar o `console.error(error)` de `main.ts:47` por uma mensagem saneada.
3. `deliver` devolve à tela um texto fixo ("token indisponível") em vez da mensagem do erro.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/errors.ts
+++ b/apps/server/src/errors.ts
+/** Erro para log, sem os parâmetros da consulta (podem levar senha, token ou chave). */
+export function safeError(error: unknown): unknown {
+  const e = error as { query?: string; params?: unknown; cause?: unknown; name?: string } | null;
+  if (!e || typeof e.query !== 'string' || !('params' in e)) return error;
+  const pg = findPgError(error);
+  return { type: 'DrizzleQueryError', message: `Failed query: ${e.query}`, query: e.query,
+           cause: pg ? { code: pg.code, message: pg.message, constraint: pg.constraint } : String((e.cause as Error)?.message ?? '') };
+}
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
-    logger: logger === true ? { level: config.logLevel, redact: [...] } : logger,
+    logger: logger === true
+      ? { level: config.logLevel, redact: [...], serializers: { err: (err) => pino.stdSerializers.err(safeError(err) as Error) } }
+      : logger,
```

## Critérios de aceite
- [ ] Nenhum log da API nem do worker contém o valor de um parâmetro de consulta que falhou.
- [ ] O log continua trazendo o SQL e o código/mensagem do Postgres.
- [ ] A falha no boot com `ADMIN_*` não imprime a senha.

## Testes recomendados
- `apps/server/test/auth.test.ts`: app com `logger: { stream }` capturando a saída e um `db` dublê cujo `execute` rejeita com um `DrizzleQueryError` real (`new DrizzleQueryError('select auth_login($1, $2) as id', ['u', 'Segredo-123'], new Error('Connection terminated'))`); `POST /api/auth/login` responde 500 e o texto capturado não contém `Segredo-123`, mas contém `auth_login`.
- Unitário de `safeError` (mesmo arquivo ou `test/errors.test.ts`), inclusive com a cadeia `cause` do `pg`.

## Limitações e suposições
Nada foi executado; o formato do log foi deduzido do código instalado do Drizzle e do pino. Não conferi os outros `log.*({ err })` fora da minha área (runner, backup), que passam pelo mesmo serializador e ganham a correção junto.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código: o tratamento central (`app.ts`) mandava todo erro não traduzido a `request.log.error(error)`, e o `DrizzleQueryError` leva `params` como propriedade e na mensagem ("Failed query: …\nparams: …"), que o serializador do pino copia (mensagem, pilha e propriedades). Reproduzido no teste novo: antes da correção, a linha do log do 500 do login trazia a senha duas vezes (em `err.message`/`stack` e no `msg`, que o pino tira da mensagem do erro). O worker usava `pino` cru, o boot fazia `console.error(error)` e o aviso da assinatura que falhou (`message-worker.ts`) gravava `String(error.message)`.

## Resolução (executor)

- `apps/server/src/errors.ts`: `loggableError(erro)` devolve um clone sem os valores, mantendo a classe: no `DrizzleQueryError`, a mensagem fica `Failed query: <sql>`, a pilha é reconstruída sem a linha `params:`, `params` sai e `pg` resume o erro do Postgres da causa (código, severidade, mensagem, constraint, tabela, coluna, rotina); no erro do Postgres, sai o `detail` (repete a linha recusada: "Failing row contains (…)", "Key (…)=(…)"); a cadeia de `cause` é saneada. `errorText(erro, max)` é o texto curto (motivo de uma falha): a mensagem do Postgres e o SQL, nunca os parâmetros. `redactQueryParams` tira a linha de qualquer texto.
- `apps/server/src/log.ts` (novo): `logSerializers.err` e o gancho `logHooks.logMethod`, que troca o erro pelo saneado antes do pino (o `msg` da linha vem da mensagem do erro em `log.error(erro)` e em `log.error({ err })` sem texto). `apiLoggerOptions` (o logger do Fastify; aceita opções próprias, como o `stream` dos testes) e `workerLogger` (o do worker) usam os dois. Todo `log.*(erro)`/`log.*({ err })` da API, do runner, dos laços e do `/mcp` passa por eles.
- `main.ts`: o worker usa `workerLogger`; a falha do boot imprime `loggableError(erro)` (o `ADMIN_PASSWORD` de um `ensureInitialAdmin` recusado não sai).
- Textos de erro gravados ou devolvidos: `errorText` no aviso da assinatura que falhou (`message-worker.ts`), no motivo da tarefa agendada e da receita que falharam (`agent-tasks.ts`, `reconcile-recipes.ts`), na falha por linha da conciliação em lote e da troca do provisório (`reconciliation.ts`, `statement-supersede.ts`) e na transcrição (`agents/transcriptions.ts`). O `deliver` devolve "token unavailable" ao "Enviar teste" em vez da mensagem com o SQL.
- Testes: `apps/server/test/errors.test.ts` (novo): o serializador com um `DrizzleQueryError` real e a causa do Postgres com o segredo no `detail` (sem o segredo, com o SQL e o código), o erro embrulhado como causa e o do Postgres solto, `errorText`, o pino do worker (`log.error(erro)`, `log.error({ err })` e `logMessageTick`) e o 500 do login com o banco falhando (app com `logger: { stream }`): o log tem `auth_login` e o id da requisição, nunca a senha.
- Spec: `docs/001` ganhou a linha "Logs e erros".
- Verificação: `pnpm verify:quick` (com `test/errors.test.ts` e `test/security-headers.test.ts`).
