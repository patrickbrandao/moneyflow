---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# "Parar" e "Finalizar sessão" não interrompem um lote de tools em andamento

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** cancelamento entre tools
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:108-127`, `apps/server/src/agents/runner.ts:213-231`, `apps/server/src/agents/runner.ts:434-528`, `apps/server/src/agents/tools-runtime.ts:337-358`, `apps/server/src/agents/mcp-client.ts:54-62`, `apps/server/src/services/conversations.ts:619-626`, `docs/011-agentes-de-ia.md:89`, `docs/026-sessoes-dos-agentes.md:12`
- **Depende de / relacionado a:** tarefa 053; tarefa 107
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O usuário aprova de uma vez 80 conciliações sugeridas pelo agente, vê que a terceira estava errada e clica em Parar. O sistema mostra "parando", mas executa as 80 antes de parar. Finalizar a sessão também não impede: as escritas continuam numa sessão que já aparece como finalizada.

### Evidência e análise técnica
- O heartbeat (`runner.ts:108-121`) só liga as flags `canceled`/`lost` e aborta o `AbortController`. Quem age sobre elas é `checkpoint()` (`runner.ts:123-127`), chamado uma vez por volta do laço (`runner.ts:214`).
- `resolvePending` (`runner.ts:492-525`) executa todas as tools pendentes da mensagem do assistente em sequência, sem `checkpoint()` entre elas, e só grava os resultados no fim (`runner.ts:526`). O cancelamento só é percebido na volta seguinte, depois do lote inteiro.
- `RunTools.execute` (`tools-runtime.ts:337-358`) não recebe o `signal` da execução. No MCP, `callTool` (`mcp-client.ts:55`) usa só `timeout: 60_000`, sem `signal`: cada tool externa segura o "parar" por até 60 s.
- O mesmo vale para a perda da reserva. O cabeçalho do runner (`runner.ts:44-45`) diz "perder a reserva = parar sem gravar mais nada", mas o lote continua executando, e `insertToolResults` grava sem a cerca do `lock_token`.
- `stopRun` (`conversations.ts:619-626`) só marca `cancel_requested_at` quando a execução está `running`. `finishSession` arquiva a conversa na mesma transação, e o worker continua escrevendo nela.

### Verificação (tentativa de refutação)
- Spec: `docs/011:89` diz "rodando, o worker encerra na próxima batida", e `docs/026:12` diz "a execução termina sozinha em até alguns segundos". O código só cumpre isso quando o cancelamento chega durante a chamada ao modelo, que é abortada pelo `signal`.
- Teste: `agents.test.ts:343-364` cancela durante "responda devagar", que é a chamada ao modelo. Nenhum teste cancela no meio de um lote de tools.
- A trava do banco (`ai_runs_lock_check`) só aparece no heartbeat. `appendEvent` e `insertMessage` não conferem o `lock_token`.
- A tarefa 053 tratou a repetição de escrita na retomada, não a interrupção de um lote vivo. Gravar o resultado de cada tool logo após executá-la, sugerido como opcional na 053, não foi feito. Essa gravação é pré-requisito de um cancelamento correto (ver Solução).

### Impacto
- Escritas que o usuário quis impedir acontecem: baixas, lançamentos, conciliações, mensagens ao Telegram. Isso pesa mais na conciliação, em que o modelo manda muitas tools por volta e a aprovação é em lote.
- Um lote de tools MCP lentas pode segurar o "parar" por minutos.

## Como reproduzir
1. Kit com `match_statement_line` em `ask`. O provedor falso responde com 20 `tool_use` de conciliação numa só mensagem.
2. Aprove todas (`POST /api/runs/:id/confirmations`, `approved`) e drene o worker.
3. Logo após o primeiro `tool_start`, chame `POST /api/runs/:id/cancel`.
4. As 20 linhas ficam conciliadas, e a execução só termina `canceled` depois delas.

## Solução proposta
1. Passar `checkpoint` (ou o `signal` e as flags) para `resolvePending` e chamá-lo antes de cada tool, a partir da segunda.
2. Ao cancelar no meio do lote, gravar numa transação os resultados reais das tools já executadas e "cancelado" para as restantes, e só então encerrar. Hoje `cancelOpenToolUses` (`runner.ts:533-546`) marcaria como "cancelado" também as tools que já rodaram, cujo resultado ainda não foi gravado, e o modelo seria enganado. A alternativa mais simples é gravar o resultado de cada tool logo depois de executá-la (o opcional da 053).
3. Repassar `signal` ao `callTool` do MCP (`RequestOptions.signal` do SDK) e, nas tools internas, ao `meta`, para os handlers longos que quiserem respeitá-lo.
4. Na perda da reserva (`lost`), parar sem gravar, como diz o cabeçalho. A retomada já trata o `tool_start` como interrompido (053).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/runner.ts
+++ b/apps/server/src/agents/runner.ts
@@ async function resolvePending(
-  for (const use of pending) {
+  for (const [index, use] of pending.entries()) {
+    if (index > 0) {
+      try {
+        await checkpoint();
+      } catch (stop) {
+        if (stop instanceof Canceled) {
+          const rest = pending.slice(index).map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: t.agents.errors.canceled, is_error: true }));
+          await insertToolResults(db, runId, conversationId, [...results, ...rest], files);
+        }
+        throw stop;
+      }
+    }
```

## Critérios de aceite
- [ ] Cancelar durante um lote de N escritas aprovadas executa no máximo a tool em andamento. As demais voltam "cancelado", e a execução termina `canceled` em segundos.
- [ ] As tools já executadas ficam com o resultado real no histórico, não "cancelado".
- [ ] Finalizar a sessão no meio do lote tem o mesmo efeito.
- [ ] Uma tool MCP em andamento é abortada pelo "parar".

## Testes recomendados
`apps/server/test/agents.test.ts`, no `describe` de execução: o cenário de "Como reproduzir", com um handler extra registrado por `registerInternalTool`. Esse handler espera um sinal do teste para que o cancelamento caia entre a 1ª e a 2ª tool. Conferir a contagem de execuções do handler (1), os `tool_result` (1 real e o resto "cancelado") e o status `canceled`. Em `test/fakes/fake-mcp.ts`, uma tool lenta para o caso do MCP.

## Limitações e suposições
Nada foi executado. O cenário de reserva perdida no meio do lote exige o heartbeat falhando por 2 minutos, o que é raro. O cenário do cancelamento é direto.

## Análise (triagem)

## Resolução (executor)
