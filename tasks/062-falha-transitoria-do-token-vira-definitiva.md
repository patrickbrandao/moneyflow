---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# Uma falha transitória ao ler o token do bot marca a mensagem da outbox como falha definitiva

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** retry / classificação de erro
- **Arquivos afetados:** `apps/server/src/services/messages.ts:258-267,473-491`, `database/migrations/0020_messages.sql:428-433`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Um soluço do banco pode fazer o sistema desistir de vez de mandar um aviso do Telegram e mostrar uma falha falsa no sino.

### Evidência e análise técnica
- `messages.ts:483-491`: `catch (error) { const status = await markFailed(db, message.id, 'token unavailable', null, true); ...`. Qualquer exceção de `message_destination_token()` vira `permanent = true` e notifica `message_failed`: queda de conexão, timeout ou deadlock incluídos.
- A função do banco só levanta P0002 e 42501 (`0020:428-433`). O `inboundToken` (`:258-267`) já distingue esses códigos e relança o resto.

### Verificação (tentativa de refutação)
O comentário em `:473-477` fala em falha permanente só para 400/401/403/404. Não há outra proteção.

### Impacto
Lembretes, resumos e avisos perdidos sem retry, com um `message_failed` falso no sino.

## Como reproduzir
Teste de `deliver` com um `Executor` dublê que lança um erro genérico (não PG) na leitura do token: a mensagem fica `failed`, sem retry.

## Solução proposta
Tratar como permanente só 42501 e P0002. Nos outros casos, `markFailed(..., null, false)`, que segue o retry normal.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/messages.ts
+++ b/apps/server/src/services/messages.ts
@@
   } catch (error) {
-    const status = await markFailed(db, message.id, 'token unavailable', null, true);
+    const code = findPgError(error)?.code;
+    const permanent = code === '42501' || code === 'P0002';
+    const status = await markFailed(db, message.id, 'token unavailable', null, permanent);
     if (status === 'failed') await notifyFailure(db, message.id, 'token unavailable');
```
`findPgError` já é usado no mesmo arquivo (linha 263).

## Critérios de aceite
- [ ] Um erro não-PG ao ler o token deixa a mensagem para nova tentativa.
- [ ] Destino desativado (P0002/42501) continua falhando de vez.

## Testes recomendados
Em `test/vision.test.ts`, onde estão os testes da outbox: o dublê descrito em "Como reproduzir". Nada disso foi executado nesta auditoria.

## Limitações e suposições
Nenhuma relevante.

## Análise (triagem)
Sem triagem formal: designado ao `app` pela sessão principal. Confirmado em `services/messages.ts` (`deliver`): qualquer exceção de `message_destination_token()` virava `markFailed(..., true)` e `message_failed` no sino. A função só levanta P0002/42501 de propósito.

## Resolução (executor)
- `deliver` (`apps/server/src/services/messages.ts`): permanente só com `findPgError(error)?.code` P0002 ou 42501; o resto (queda de conexão, timeout, deadlock) vai a `markFailed(..., false)` e segue o retry/backoff da outbox. Comentário da função atualizado.
- Teste novo em `apps/server/test/vision.test.ts`: "token indisponível: erro transitório volta à fila; P0002/42501 do banco falham de vez (tarefa 062)" — `Executor` dublê que rejeita a leitura do token: com `Error` comum a mensagem volta a `pending` sem `message_failed`; com um erro PG P0002 vira `failed` com o aviso no sino.
- Specs: sem mudança de decisão (a 013 já fala em retry e falha permanente só para os erros definitivos).
- Rodado no Postgres local (`test:local`): o caso com `-t "tarefa 062"` (1/1) e `test/vision.test.ts` inteiro (11/11).
