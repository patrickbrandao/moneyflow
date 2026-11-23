---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 5d66b57
---

# Erros inesperados das tools viram "Algo deu errado" sem nenhum log

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** erro engolido / observabilidade
- **Arquivos afetados:** `apps/server/src/agents/tools-runtime.ts:149-151`, `apps/server/src/agents/tools-runtime.ts:161-170`, `apps/server/src/agents/tools-runtime.ts:337-358`, `apps/server/src/agents/runner.ts:389-415`, `apps/server/src/agents/runner.ts:455-459`, `apps/server/src/routes/mcp.ts:66-68`, `apps/server/src/routes/mcp.ts:80-82`, `apps/server/src/app.ts:97-114`, `packages/shared/src/i18n/errors.ts:482-490`
- **Depende de / relacionado a:** tarefa 063 (o mesmo padrão em `produceMessages`)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando uma ação do agente quebra por um defeito do sistema, e não por uma regra de negócio, o agente só ouve "Algo deu errado. Tente de novo." e o servidor não registra nada. Quem mantém o sistema não tem como saber que a tool está com defeito nem por quê. O agente ainda é convidado a tentar de novo uma ação que pode ter sido feita pela metade.

### Evidência e análise técnica
- `RunTools.execute` (`tools-runtime.ts:351-357`) captura qualquer exceção e devolve `toolErrorMessage(error)`. A prévia faz o mesmo no runner (`runner.ts:455-459`, `preErrors.set(use.id, toolErrorMessage(error))`), e a tool de segredo também (`executeSecretTool`, `tools-runtime.ts:149-151`).
- `toolErrorMessage` (`tools-runtime.ts:161-170`): `AppError` → mensagem; `ZodError` → a primeira issue; erro do banco com código em `DB_CODE_MESSAGES` (`errors.ts:482-490`: só 23514, 23505, 23503, 23502, 22P02, 42501, 22023) → mensagem; o resto (TypeError, `undefined` de um `!`, 40001, 40P01, 57014 de timeout, 53300, erro de rede de uma integração) → `t.errors.generic`. Nenhum desses caminhos chama um logger.
- No `/mcp` (`routes/mcp.ts:66-68,80-82`) é igual: `catch (error) { return { content: [{ text: toolErrorMessage(error) }], isError: true } }`, sem log.
- `ServiceContext` não leva logger, e o runner não loga o `outcome.isError`. Não há `log` no `RunTools` (`grep` por `log.` em `tools-runtime.ts`: nada).
- Nas rotas, o mesmo erro é registrado: `app.setErrorHandler` faz `request.log.info({ code }, 'regra do banco')` para as regras traduzidas e `request.log.error(error)` para o 500 (`app.ts:102-113`). A tool, que roda os mesmos serviços, perde os dois registros.
- Mesmo o erro traduzido chega ao modelo sem o código: o `AppError` traz `code` (o nome da constraint ou `pg_23514`), mas `toolErrorMessage` devolve só `message`. "A operação viola uma regra do sistema." sem dizer qual não ajuda o modelo a corrigir a entrada; a rota manda o código no JSON.
- Mesmo padrão no streaming (outro lugar do mesmo defeito: erro engolido sem log): em `callModel` (`runner.ts:389-415`), `flushing = flushing.then(...)`. Se um `appendEvent` falha uma vez, a promessa fica rejeitada, todos os deltas seguintes são descartados em silêncio e o `await flushing.catch(() => {})` final engole o erro. O console para de mostrar o texto ao vivo sem nenhum log.

### Verificação (tentativa de refutação)
- O erro também não fica no banco: o evento `tool_result` guarda só o `summary` (o texto genérico, até 200 caracteres, sem pilha), e `ai_messages` guarda o mesmo conteúdo.
- O `log.error` de `runner.ts:333` só cobre erros que derrubam a execução inteira. Erro de tool não derruba.
- A tarefa 063 corrigiu o mesmo padrão em outra área (`produceMessages`). Aqui ele continua.
- Não foi verificado se o Fastify loga algo do `/mcp` por conta própria: a rota faz `reply.hijack()` e o erro não sobe ao `setErrorHandler`.

### Impacto
Defeitos de handler e erros transitórios do banco (deadlock, timeout) nas tools (há 182, com muito código de prévia) ficam invisíveis em produção: o usuário só vê o agente "desistindo", e o defeito aparece como "o agente não conseguiu". Com "Tente de novo", o modelo repete escritas que podem ter gravado uma parte (por exemplo, `set_message_subscriptions`, que grava em várias transações). No streaming, o console deixa de mostrar o texto ao vivo sem explicação.

## Como reproduzir
- Registrar uma tool extra (`registerInternalTool`) cujo `run` lança `new TypeError('x')` e pedir ao provedor falso que a chame. O `tool_result` volta "Algo deu errado. Tente de novo." e nada aparece no log do worker. O mesmo vale pelo `/mcp` com um token pessoal.
- Alternativa: forçar um erro não traduzido numa prévia (por exemplo, uma tool cuja prévia acesse `title.settlements.find(...)!` de um registro inconsistente, ou um `statement_timeout` baixo na sessão).

## Solução proposta
1. Dar um logger ao `RunTools` (o `deps.log` do runner, por `forAgent`) e ao `/mcp` (`request.log`; já há `r.log` na rota), e registrar, antes de traduzir: `info` com o código para `AppError`/erro de banco traduzido, `error` com a pilha para o resto (com `runId`, `toolUseId`, nome da tool). Alternativa: `toolErrorMessage` devolver também se o erro é "esperado" (traduzido) ou não; nos pontos que chamam, quando a mensagem cair no genérico, logar `{ err, tool: name, runId }` com `log.error`.
2. Incluir o código no texto para o modelo quando houver: `[ai_budgets_active_key] Já existe um registro com esses dados.`.
3. Para o erro genérico numa escrita, trocar "Tente de novo" por "confira o resultado antes de repetir" (como já faz a retomada em `runner.ts:509`).
4. Em `callModel`, encadear com `.catch` por flush (logando e seguindo), para uma falha não descartar o resto do stream.
5. Opcional: um id de correlação no texto ao modelo ("erro interno, ref. abc123") para casar com o log.
6. Segredos: nunca logar a entrada das tools de segredo. No ramo de `executeSecretTool`, logar só o nome e o tipo do erro, ou passar a mensagem por `scrubSecrets`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/tools-runtime.ts
+++ b/apps/server/src/agents/tools-runtime.ts
@@
     } catch (error) {
+      const known = error instanceof AppError || error instanceof ZodError || translateDbError(error);
+      this.log?.[known ? 'info' : 'error']({ err: error, tool: tool.name, toolUseId: meta.toolUseId, runId: meta.runId }, 'tool falhou');
       const message =
```

## Critérios de aceite
- [ ] Um erro não traduzido numa tool (execução, prévia, segredo, `/mcp`) gera uma linha `error` no log com a pilha, o nome da tool e o `runId`. O modelo continua recebendo a mensagem segura.
- [ ] O mesmo erro pelo `/mcp` gera log na API.
- [ ] O modelo recebe o código da regra do banco junto da mensagem.
- [ ] Segredos continuam fora do log (só nome da tool e ids).
- [ ] Uma falha de `appendEvent` num delta não impede os deltas seguintes e é logada.

## Testes recomendados
`apps/server/test/agents.test.ts`: tool registrada por `registerInternalTool` que lança `new Error('x')`/`TypeError`, com o `log` do teste trocado por um espião (`vi.fn`); o resultado ao modelo continua genérico, sem stack, e o logger recebe um `error`. No `/mcp`, o mesmo com `request.log` espionado. Um caso para a falha de `appendEvent` num delta.

## Limitações e suposições
Nada foi executado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `RunTools.execute`, a prévia no runner, `executeSecretTool` e o `/mcp` traduziam o erro sem log; o genérico mandava "Tente de novo"; o código da regra do banco não chegava ao modelo; e no `callModel` uma falha de `appendEvent` deixava a corrente rejeitada e descartava os deltas seguintes em silêncio.

## Resolução (executor)

- `ServiceContext.log` (opcional, `context.ts`): preenchido pela requisição (`app.ts`), pelo `/mcp` (`routes/mcp.ts`) e pelo runner (`agents/runner.ts`).
- `tools-runtime.ts`: `toolFailure` classifica o erro (esperado = `AppError`, Zod ou regra do banco traduzida; inesperado = o resto, com uma referência de 8 caracteres) e `reportToolError` registra `info` com o código no esperado e `error` com a pilha, a tool, o estágio (`run`/`preview`/`mcp`), o `runId`, o `toolUseId` e a referência no inesperado. Usado na execução, na prévia (runner), na tool de segredo e no `/mcp`. A tool MCP externa que falha gera um `warn`.
- Segredos: na tool de segredo o log leva só o tipo do erro, o código do banco e os quadros da pilha (sem a primeira linha, que tem a mensagem); nunca a entrada, a mensagem nem `meta.secrets`.
- Ao modelo: a regra do banco vai com o código (`[constraint] mensagem`); o erro inesperado vira `t.agents.errors.toolInternal(ref, write)` ("Erro interno … (ref. abc123) … confira o resultado antes de repetir" na escrita). `toolErrorMessage` (falha da execução inteira) continua com a mensagem genérica.
- `callModel` (exportado para o teste): cada gravação de delta tem o próprio `catch` com `warn`, e o flush vazio não grava nada.
- Testes: `apps/server/test/agents.test.ts`, `describe('erros das tools (tarefa 099)')` — leitura com `TypeError` (mensagem segura com a referência e o `error` no log com a pilha e o `runId`), regra do banco com `[pg_22P02]` e log `info`, prévia quebrada (estágio `preview`, sem cartão), `/mcp` com o log da requisição, tool de segredo sem a mensagem nem o valor no log, e o delta que falha sem descartar o seguinte.
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
