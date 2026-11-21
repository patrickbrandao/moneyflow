---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Saldos em aberto e vencidos recalculam a baixa de todos os títulos já pagos

- **Severidade:** média
- **Confiança:** confirmado (o formato das consultas); o tempo real depende do volume e não foi medido
- **Categoria:** desempenho
- **Subcategoria:** filtro sobre coluna calculada da `title_balances` que impede o índice
- **Arquivos afetados:** `database/schema.sql:13283-13304` (`title_balances`), `database/schema.sql:4499-4508` (`caixa_daily_balances`), `database/schema.sql:8340-8347` (`report_cash_projection`), `apps/server/src/services/caixas.ts:45-51`, `apps/server/src/services/titles.ts:115-120`, `apps/server/src/services/overview.ts:11-14`, `apps/server/src/services/message-worker.ts:727-728`, `apps/server/src/services/contracts.ts:180-184`
- **Depende de / relacionado a:** tarefa 146 (o mesmo efeito no canvas)
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A lista de caixas, a visão geral, o saldo projetado e a projeção de caixa ficam mais lentos a cada mês de uso. Para saber quanto falta pagar, o banco soma de novo as baixas de todos os títulos que a caixa já teve, inclusive os pagos há anos, que não devem mais nada.

### Evidência e análise técnica
A visão `title_balances` (`schema.sql:13283-13304`) calcula `open_cents` com um `LEFT JOIN LATERAL (SELECT sum(...) FROM settlements ...)` por título. Um filtro `open_cents > 0` só pode ser avaliado depois desse LATERAL, então o banco lê todos os títulos da caixa e faz a soma das baixas de cada um. O índice `titles_caixa_id_status_due_date_idx (caixa_id, status, due_date)` (`schema.sql:19019`) e o parcial `titles_due_date_idx ... WHERE status IN ('open','partial')` (`schema.sql:19061`) existem, mas nenhuma destas consultas filtra por `status`:

- `caixas.ts:47-51` (`summarySql`, usado por `listCaixas` e `getCaixa`): quatro subconsultas sobre `title_balances` por caixa (a pagar, a receber, quantidade e valor vencidos), sem `status` e, nas duas primeiras, sem nenhum filtro além de caixa, direção e arquivamento. `GET /api/caixas` é chamado pela navegação, pelos filtros e por vários formulários do console.
- `titles.ts:115-120` (`listTitles`, situações `unpaid` e `overdue`): `tb.open_cents > 0` e, em `overdue`, `t.due_date < hoje`. A visão geral (`overview.ts:13`) pede `overdue` sem período, ou seja, todos os títulos vencidos desde o início.
- `caixa_daily_balances` (`schema.sql:4499-4508`): o previsto usa `b.open_cents > 0` e `greatest(b.due_date, p_today) <= p_to`; nenhum dos dois limita a varredura.
- `report_cash_projection` (`schema.sql:8340-8347`): `open_items` pega todos os títulos da caixa com `open_cents > 0`, sem data nem `status`.
- `message-worker.ts:727-728` (resumo diário): todos os títulos com vencimento até hoje de todas as caixas gerais.
- `contracts.ts:180-184` (próxima ocorrência na lista de contratos): `x.status <> 'canceled'` deixa os pagos entrarem no LATERAL.

Pelos triggers (`settlements_refresh_title_status`, `titles_validate_status`), `open_cents > 0` equivale a `status IN ('open','partial')`: pago tem saldo zero, cancelado tem zero na visão, aberto e parcial têm saldo positivo. Acrescentar o predicado não muda o resultado e deixa o índice restringir as linhas antes do LATERAL. As consultas que já fazem isso mostram o padrão: `statements.ts:574` e `:622` e `message-worker.ts:136`.

### Verificação (tentativa de refutação)
- `title_balances` é uma visão simples e é achatada na consulta. Mesmo assim, o predicado sobre `open_cents` depende do LATERAL e não desce até a varredura de `titles`.
- Não há índice em expressão nem coluna materializada com o valor baixado: `titles` não guarda `settled_cents`.
- O equivalente com `status` vale por invariante do banco (`titles_status_settlements_check` e o recálculo no trigger). Não depende da aplicação.
- Nenhum teste mede esse custo. A spec não diz nada sobre o desempenho dessas telas.

### Impacto
O custo cresce com o histórico inteiro de cada caixa (títulos × uma sonda em `settlements` por título), multiplicado por quatro em `summarySql` e pelo número de caixas legíveis. Isso pesa na navegação de todo usuário, na visão geral, no calendário com saldo projetado, no relatório de projeção e no laço de mensagens. Com poucos anos de uso fica em dezenas de milissegundos; com caixas de empresa (milhares de títulos por ano) cresce sem limite.

## Como reproduzir
1. Num banco de desenvolvimento, gerar 20 mil títulos pagos numa caixa (com baixa) e 50 em aberto.
2. `EXPLAIN (ANALYZE, BUFFERS)` da subconsulta de `caixas.ts:51` para essa caixa: o plano lê os 20 mil títulos e faz 20 mil sondas em `settlements`.
3. Repetir com `AND tb.status IN ('open','partial')`: o plano usa `titles_caixa_id_status_due_date_idx` e lê só os 50.

## Solução proposta
1. (dba) Em `caixa_daily_balances` e `report_cash_projection`, acrescentar `b.status IN ('open','partial')` junto de `open_cents > 0`. No previsto do calendário, acrescentar também `b.due_date <= p_to`: a condição atual `greatest(b.due_date, p_today) <= p_to` já implica isso, e a forma explícita é indexável.
2. (dba, opcional e mais forte) Guardar `titles.settled_cents` mantido pelo mesmo trigger que já recalcula o `status` (`settlements_refresh_title_status`) e reescrever `title_balances` sem o LATERAL. Com isso, um índice parcial `(caixa_id, due_date) WHERE status IN ('open','partial')` cobre as listas e os totais. Exige o teste pgTAP de que o valor acompanha inserir, estornar e excluir baixa.
3. (app) Acrescentar `status IN ('open','partial')` em `caixas.ts:48-51`, `titles.ts:116` e `:119`, `message-worker.ts:728` e trocar `x.status <> 'canceled'` por `x.status IN ('open','partial')` em `contracts.ts:183`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/caixas.ts
+++ b/apps/server/src/services/caixas.ts
@@
-  coalesce((SELECT sum(tb.open_cents) FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.direction = 'payable' AND tb.archived_at IS NULL), 0)::bigint AS payable_open_cents,
+  coalesce((SELECT sum(tb.open_cents) FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.status IN ('open', 'partial')
+              AND tb.direction = 'payable' AND tb.archived_at IS NULL), 0)::bigint AS payable_open_cents,
```
```diff
--- a/database/migrations/00NN_open_balance_status_filter.sql (caixa_daily_balances)
+++
-     WHERE b.caixa_id = p_caixa_id AND b.open_cents > 0 AND b.archived_at IS NULL
+     WHERE b.caixa_id = p_caixa_id AND b.status IN ('open', 'partial') AND b.open_cents > 0 AND b.archived_at IS NULL
+       AND b.due_date <= p_to
```

## Critérios de aceite
- [ ] Nenhuma consulta de saldo em aberto ou vencido sobre `title_balances` fica sem `status IN ('open','partial')`; `rg "open_cents > 0" apps/server/src database/migrations` confere.
- [ ] O `EXPLAIN` das quatro subconsultas de `summarySql` e de `caixa_daily_balances` usa um índice de `titles` com `status`.
- [ ] Os totais da lista de caixas, da visão geral, do calendário e da projeção continuam iguais.

## Testes recomendados
- `database/tests/0017_calendar.sql` e `0018_reports.sql`: os casos de saldo previsto e projeção continuam passando, mais um caso com título pago antigo e baixa estornada (volta a contar).
- `apps/server/test/titles.test.ts` (não há `caixas.test.ts`): um `describe` novo para os totais de `GET /api/caixas` e `GET /api/overview` (a pagar, a receber e vencidos) com títulos pagos, parciais, cancelados, arquivados e com baixa estornada.
- Se for feito o passo 2: pgTAP de `titles.settled_cents` em `0009_settlements.sql` (inserir, estornar, excluir a baixa e mudar o valor do título).

## Limitações e suposições
Nada foi executado. A conclusão sobre o plano vem da forma da visão (LATERAL com agregação) e dos índices existentes; o ganho real depende da distribuição dos dados.

## Análise (triagem)

## Resolução (executor)
