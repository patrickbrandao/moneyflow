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

# A API aceita fechar mês futuro, e o worker para de materializar as séries daquele mês sem dizer qual nem por quê

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** validação do fechamento e erro engolido no worker
- **Arquivos afetados:** `apps/server/src/services/audit.ts:161-172`, `packages/shared/src/schemas/operation.ts:423-428`, `apps/web/src/components/closing/ClosingTab.tsx:191-195`, `apps/server/src/agents/tool-handlers-admin.ts:500-518`, `apps/server/src/services/recurrence.ts:99-126`, `apps/server/src/worker.ts:33-34`
- **Depende de / relacionado a:** tarefa 063 (o mesmo padrão de `catch` sem log, corrigido só no `message-worker`)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A tela só deixa fechar até o mês atual, mas a API e o agente (tool `close_month`) aceitam qualquer mês. Se alguém fecha um mês do futuro por engano (um agente que entende "feche novembro" no ano errado, por exemplo), as séries recorrentes daquela caixa param de gerar as próximas ocorrências, e o único sinal é um contador `failed` no log do worker.

### Evidência e análise técnica
- `periodClosingInput.month` só confere o formato (`schemas/operation.ts:423-428`), e `closeMonth` só olha as linhas não conciliadas (`audit.ts:161-172`). O banco também não limita (`period_closings_month_check` exige só o dia 1). A tela põe `max={todayIso().slice(0, 7)}` no campo (`ClosingTab.tsx:195`), e a tool `close_month` (`tool-handlers-admin.ts:500-518`) não tem essa trava.
- Com o mês M fechado, `titles_period_lock` barra o INSERT de qualquer título com competência em M. No worker, `materializeRule` cria as ocorrências em sequência numa transação por série; a que cai em M falha e a transação inteira volta. Toda passada (a cada hora) tenta de novo a mesma e falha: a série não passa mais de M, nem os meses seguintes.
- `materializeAll` engole o erro: `catch { failed += 1; }` (`recurrence.ts:121-123`), sem o id da série nem a mensagem. O worker registra só `{ rules, created, skipped, failed }` em `info` (`worker.ts:33-34`).

### Verificação (tentativa de refutação)
- Spec 008: o fechamento é "após conciliação" e congela o que já aconteceu; nada fala em fechar mês que não começou. A trava da tela confirma a intenção.
- O comentário em `recurrence.ts:111` cita "competência num mês fechado" como exemplo esperado de falha, mas fora do mês futuro esse caso quase não ocorre: a ocorrência nova fica 12 meses à frente.
- Testes: `operation.test.ts:66-105` fecha um mês passado; nenhum caso de mês futuro nem de falha do worker.

### Impacto
As ocorrências futuras deixam de existir em silêncio: somem dos Previstos, do calendário e da conciliação, que não acha a ocorrência quando o pagamento entra no extrato. Para descobrir, é preciso ler o log e reabrir o mês (só o admin).

## Como reproduzir
1. Série mensal na caixa X (13 ocorrências até hoje + 12 meses).
2. `POST /api/caixas/X/closings { month: "<hoje + 13 meses, AAAA-MM>", force: true }` → 200.
3. `materializeAll(db, addMonths(today, 14))` → `failed: 1`, nenhuma ocorrência nova, e o log não diz qual série nem por quê.

## Solução proposta
1. `closeMonth` (e a prévia da tool): recusar mês depois do mês atual em São Paulo (422, mensagem pt-BR em `t.errors`), como a tela já faz.
2. `materializeAll`: receber o logger (ou devolver a lista) e registrar em `warn` o id da série e a mensagem do erro traduzido; contar à parte os erros de mês fechado.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/audit.ts
+++ b/apps/server/src/services/audit.ts
@@ export async function closeMonth(
   ctx.access.assertWrite(caixaId);
+  if (input.month > `${todayIso().slice(0, 7)}-01`) throw new AppError(422, 'closing_future_month', t.errors.closingFutureMonth);
--- a/apps/server/src/services/recurrence.ts
+++ b/apps/server/src/services/recurrence.ts
@@
-    } catch {
+    } catch (error) {
       failed += 1;
+      onError?.(id, error);
     }
```

## Critérios de aceite
- [ ] `POST /api/caixas/:id/closings` e a tool `close_month` com mês futuro respondem 422.
- [ ] Uma série que falha no worker aparece no log com o id e o motivo.

## Testes recomendados
`test/operation.test.ts`, no `describe('fechamento de mês (spec 008)')`: fechar o mês seguinte ao atual → 422. `test/titles.test.ts`: com um mês futuro fechado direto no banco, `materializeAll` chama o `onError` com o id da série.

## Limitações e suposições
Nada foi executado. A decisão de permitir ou não fechar o mês corrente (a tela permite) fica com o produto.

## Análise (triagem)

## Resolução (executor)
