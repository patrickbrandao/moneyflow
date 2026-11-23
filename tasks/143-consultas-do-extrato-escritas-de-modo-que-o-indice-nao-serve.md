---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Consultas do extrato escritas de um jeito que impede o uso dos índices feitos para elas

- **Severidade:** baixa
- **Confiança:** confirmado (os predicados não casam com nenhum índice); o tempo real não foi medido
- **Categoria:** desempenho
- **Subcategoria:** predicado que impede o índice (`EXISTS` no lugar da coluna, `coalesce` sobre colunas indexadas)
- **Arquivos afetados:** `apps/server/src/services/statements.ts:272-273,293-299,398-404,704-707`, `apps/server/src/services/audit.ts:150-157`, `database/schema.sql:18823` (`statement_lines_account_dedup_key`), `database/schema.sql:18886,18830,18907`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Importar um extrato, reconferir um lote e abrir a guia de fechamento de mês fazem buscas que leem todas as linhas de extrato da conta, ou de todo o sistema, quando bastaria ler as poucas que interessam. O banco já tem os índices certos, mas a forma da consulta impede que sejam usados.

### Evidência e análise técnica
1. **Deduplicação da importação** (`statements.ts:293-299` na prévia e `:398-404` na importação). A consulta é `financial_account_id = X AND NOT EXISTS (SELECT 1 FROM statement_imports si WHERE si.id = statement_lines.statement_import_id AND si.provisional) AND dedup_hash IN (...)` (o `notProvisional` de `:272-273`). O índice único feito para essa busca é parcial, `statement_lines_account_dedup_key (financial_account_id, dedup_hash) WHERE financial_account_id IS NOT NULL AND NOT provisional` (`schema.sql:18823`). Como a consulta não tem `NOT provisional`, o predicado do índice não é implicado e ele não pode ser usado. O plano cai em `statement_lines_financial_account_id_posted_on_idx` e lê todas as linhas da conta. `statement_lines.provisional` é a cópia da marca do lote mantida pelo banco (trigger `statement_lines_supersede_validate` e `statement_imports_sync_provisional`), então `NOT statement_lines.provisional` é equivalente ao `NOT EXISTS`.
2. **Sugestões já usadas no casamento** (`statements.ts:704-707`, em todo `autoMatch`: importação e "reconferir"). A consulta é `status = 'suggested' AND coalesce(financial_account_id, card_caixa_id) = (SELECT coalesce(...) FROM statement_imports ...)`. Não há índice só em `status`: `statement_lines_status_idx` começa por `statement_import_id`. E o `coalesce` esconde as colunas de `statement_lines_financial_account_id_posted_on_idx` e `statement_lines_card_caixa_id_posted_on_idx`. O resultado é uma varredura de `statement_lines` inteira, de todos os usuários.
3. **Pendências do fechamento de mês** (`audit.ts:150-157`, a guia Fechamento e o `closeMonth`): `coalesce(a.caixa_id, l.card_caixa_id) = caixa AND l.status IN ('new','suggested')`, também uma varredura da tabela inteira.

### Verificação (tentativa de refutação)
- `notProvisional` e `NOT provisional` dão o mesmo resultado: o banco recusa uma linha com `provisional` diferente do lote (`statement_lines_provisional_check`). Lote substituído continua `provisional = true` (imutável), como no `NOT EXISTS`.
- Não há índice em expressão `coalesce(financial_account_id, card_caixa_id)` nem índice parcial por `status`.
- A importação roda numa transação com muitas outras consultas; a deduplicação é uma só por arquivo, então o impacto lá é menor que o do item 2, que roda em cada casamento.

### Impacto
O custo cresce com o volume de linhas de extrato da conta (item 1) ou do sistema inteiro (itens 2 e 3) e aparece em cada importação, em cada "reconferir" e em cada abertura da guia de fechamento.

## Como reproduzir
`EXPLAIN` das três consultas num banco com algumas dezenas de milhares de linhas: o item 1 mostra `Index Scan using statement_lines_financial_account_id_posted_on_idx` com `Filter: dedup_hash = ANY(...)`, e os itens 2 e 3 mostram `Seq Scan on statement_lines`.

## Solução proposta
1. Trocar `notProvisional` por `NOT statement_lines.provisional` (ou `NOT l.provisional`) nas duas consultas de deduplicação.
2. Em `autoMatch`, usar o alvo já conhecido do lote: `status = 'suggested' AND financial_account_id = $conta` (ou `card_caixa_id = $cartão`). Se o volume pedir, o dba pode criar `statement_lines (financial_account_id) WHERE status = 'suggested'` e o equivalente do cartão.
3. Em `unreconciledByMonth`, separar em `l.financial_account_id IN (SELECT id FROM financial_accounts WHERE caixa_id = $caixa) OR l.card_caixa_id = $caixa`, que vira um BitmapOr nos dois índices com `posted_on`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/statements.ts
+++ b/apps/server/src/services/statements.ts
@@
-const notProvisional = sql`NOT EXISTS (SELECT 1 FROM statement_imports si
-                                    WHERE si.id = statement_lines.statement_import_id AND si.provisional)`;
+/** A marca do lote copiada na linha pelo banco: casa com o índice parcial statement_lines_account_dedup_key. */
+const notProvisional = sql`NOT statement_lines.provisional`;
```

## Critérios de aceite
- [ ] O `EXPLAIN` da deduplicação de conta usa `statement_lines_account_dedup_key`.
- [ ] O `EXPLAIN` das consultas de `autoMatch` e `unreconciledByMonth` não faz `Seq Scan on statement_lines`.
- [ ] Reimportar um arquivo continua acusando todas as linhas como duplicadas, e o consolidado continua entrando por cima do provisório.

## Testes recomendados
`apps/server/test/statements.test.ts`: o caso de reimportação (409 `statement_duplicated`) e `test/statement-supersede.test.ts`, o consolidado que repete as linhas do provisório (não pode ser deduplicado). Os dois existem e devem continuar passando sem mudança.

## Limitações e suposições
Nada foi executado. A troca é só de forma, sem mudança de resultado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código atual: os itens 1 e 2 já tinham sido corrigidos pela tarefa 139 (o `notProvisional` passou a ser `NOT statement_lines.provisional`, e o `autoMatch` lê as sugestões pela coluna do alvo do lote). Faltava o item 3: `unreconciledByMonth` (`audit.ts`) filtrava por `coalesce(a.caixa_id, l.card_caixa_id)` e o mês por `date_trunc`, o que impede os índices `(financial_account_id, posted_on)` e `(card_caixa_id, posted_on)`.

## Resolução (executor)

- `apps/server/src/services/audit.ts` (`unreconciledByMonth`, a guia Fechamento e o `closeMonth`): o alvo pelas colunas da linha, `l.financial_account_id IN (contas da caixa) OR l.card_caixa_id = caixa`, e o mês por intervalo (`posted_on >= mês AND posted_on < mês + 1`), sem o `LEFT JOIN` das contas. Mesmo resultado.
- Itens 1 e 2: já feitos pela tarefa 139; conferidos, sem mudança.
- Teste: `apps/server/test/operation.test.ts`, no fechamento de mês, as pendências por mês da caixa com o lote importado e a outra caixa sem nenhuma; os casos de reimportação (`test/statements.test.ts`) e do consolidado sobre o provisório (`test/statement-supersede.test.ts`) passam sem mudança.
- Verificação: `pnpm verify:quick` (nível rápido).
