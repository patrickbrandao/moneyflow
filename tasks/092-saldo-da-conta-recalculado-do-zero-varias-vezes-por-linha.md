---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 832da3f
---

# Saldo da conta somado desde a abertura várias vezes por linha (lotes, resumo e projeção)

- **Severidade:** média
- **Confiança:** confirmado (as chamadas repetidas e a soma desde a abertura); o tempo real não foi medido
- **Categoria:** desempenho
- **Subcategoria:** saldo recalculado do zero, sem índice de cobertura
- **Arquivos afetados:** `database/schema.sql:6174-6185` (`financial_account_balance_at`), `database/schema.sql:15760-15790` (`statement_import_balances`), `database/schema.sql:8324-8336` (`report_cash_projection`), `database/schema.sql:18536` (`movements_financial_account_id_occurred_on_idx`), `apps/server/src/services/statements.ts:866-901,916-921`, `apps/server/src/services/statement.ts:23,101,125-127`
- **Depende de / relacionado a:** tarefa 093 (o mesmo efeito do lado dos títulos)
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A guia de conciliação da conta, o resumo mensal e a projeção de caixa ficam mais lentos conforme a conta acumula movimentos. Para cada lote de extrato listado, o banco soma de novo, quatro ou cinco vezes, todos os movimentos desde a abertura da conta.

### Evidência e análise técnica
`financial_account_balance_at(conta, dia)` (`schema.sql:6174-6185`) soma todos os movimentos da conta até o dia. O índice `movements (financial_account_id, occurred_on)` (`schema.sql:18536`) não inclui `amount_cents`, então cada soma é uma varredura do índice com uma leitura da tabela por movimento.

- `statement_import_balances` (`schema.sql:15768-15775`) chama a função duas vezes por lote, em `app_balance_cents` e de novo dentro de `difference_cents`. A visão é achatada e o Postgres não elimina expressões repetidas.
- `importSql` (`statements.ts:866-901`) usa `b.app_balance_cents`, `b.difference_cents` e `b.difference_cents - prev.difference_cents`. São três expansões da expressão por linha, mais a do LATERAL `prev`, que lê `statement_import_balances` de novo. `listImports` (`statements.ts:916-921`) traz até 200 lotes. A guia Conciliação da conta faz entre 4 e 5 somas completas por lote com saldo.
- `accountSummary` (`statement.ts:125-127`) chama a função uma vez por mês do período. `accountStatement` e `accountSummary` (`statement.ts:23`, `:101`) chamam `listAccounts` da caixa inteira, que soma o saldo de todas as contas por `financial_account_balances`, só para achar uma conta.
- `report_cash_projection` (`schema.sql:8324-8336`): `acc_rows` é `accs CROSS JOIN hz`, e `today_cents` (soma até hoje) não depende do horizonte, mas é recalculado para cada um dos três horizontes padrão.
- `flow_graph_nodes` (`schema.sql:6466-6468`), `caixa_daily_balances` (`schema.sql:4487-4491`) e `account_daily_balances` (`schema.sql:84-89`) fazem uma soma desde a abertura por conta em cada chamada.

### Verificação (tentativa de refutação)
- `financial_account_balance_at` é SQL com `FROM`. Não é inlinada como expressão escalar, então cada referência é uma chamada.
- No LATERAL `prev` (ORDER BY ... LIMIT 1), o planejador pode adiar o cálculo caro para depois do LIMIT. Mesmo no melhor caso sobram quatro somas por lote.
- Não há tabela de saldos por mês nem coluna acumulada; `movements` é praticamente só de inserção (o mapa de visibilidade fica cheio), então um índice com `INCLUDE (amount_cents)` permitiria varredura só de índice.
- Nenhum teste mede o custo; a spec 009 exige a divergência acumulada e a do intervalo, mas não diz como calcular.

### Impacto
O custo cresce com (lotes listados × movimentos da conta). Numa conta corrente com cinco anos de extratos mensais (60 lotes e alguns milhares de movimentos), abrir a guia Conciliação faz centenas de somas completas. O resumo da conta e a projeção pagam o mesmo custo por mês ou por horizonte.

## Como reproduzir
1. Conta com 10 mil movimentos e 60 lotes com saldo.
2. `EXPLAIN (ANALYZE, BUFFERS)` do `importSql` com `WHERE i.financial_account_id = <conta>`: o plano mostra as chamadas de `financial_account_balance_at` por linha e milhões de buffers lidos.
3. Comparar com `SELECT financial_account_balance_at(conta, dia)` isolado: cada chamada lê o índice e a tabela desde a abertura.

## Solução proposta
1. (dba) Índice de cobertura: `CREATE INDEX movements_account_day_amount_idx ON movements (financial_account_id, occurred_on) INCLUDE (amount_cents)`, no lugar de `movements_financial_account_id_occurred_on_idx`. Ele também serve à FK. As somas passam a ser varredura só de índice.
2. (dba) `statement_import_balances`: calcular o saldo do app uma vez por lote, com `LEFT JOIN LATERAL (SELECT financial_account_balance_at(...) AS app) x ON true`, e derivar `difference_cents = bank_balance_cents - x.app`.
3. (dba) `report_cash_projection`: calcular `today_cents` num CTE por conta e juntar com os horizontes depois.
4. (app) `importSql`: ler `b.difference_cents` uma vez, num subselect ou LATERAL que devolva a coluna já calculada, e reaproveitar o valor em `difference_cents` e em `interval_difference_cents`. O LATERAL `prev` deve escolher o lote anterior só em `statement_imports` (ordem e LIMIT 1) e calcular o saldo apenas do escolhido. Uma janela `lag()` sobre a lista não serve, porque a lista para em 200 lotes e o anterior do mais antigo pode estar fora dela. `statement.ts` deve consultar só a conta pedida, e não `listAccounts` da caixa.
5. (dba, depois, se o volume pedir) Saldos de fechamento por mês e conta mantidos por trigger em `movements`, para que a soma comece no último mês fechado.

### Diff/patch proposto — NÃO APLICADO
```diff
--- statement_import_balances (trecho)
-        CASE WHEN ((i.financial_account_id IS NOT NULL) AND (i.bank_balance_on IS NOT NULL))
-             THEN public.financial_account_balance_at(i.financial_account_id, i.bank_balance_on) ELSE NULL::bigint END AS app_balance_cents,
-        CASE WHEN (...) THEN (i.bank_balance_cents - public.financial_account_balance_at(i.financial_account_id, i.bank_balance_on)) ... END AS difference_cents,
+        x.app AS app_balance_cents,
+        i.bank_balance_cents - x.app AS difference_cents,
 ...
+     LEFT JOIN LATERAL (SELECT CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
+                                    THEN public.financial_account_balance_at(i.financial_account_id, i.bank_balance_on) END AS app) x ON true
```

## Critérios de aceite
- [ ] `listImports` de uma conta com 60 lotes faz no máximo uma soma de saldo por lote (conferido por `EXPLAIN` ou `pg_stat_user_functions`).
- [ ] `report_cash_projection` soma o saldo de hoje uma vez por conta.
- [ ] As somas de saldo usam varredura só de índice em `movements`.
- [ ] Divergência acumulada e do intervalo, resumo da conta e projeção com os mesmos valores de antes.

## Testes recomendados
- `database/tests/0014_statements.sql` (e `0049_statement_provisional_imports.sql`): `statement_import_balances` com e sem saldo do banco e com lote substituído, sem mudar resultado.
- `database/tests/0018_reports.sql`: `report_cash_projection` com três horizontes, mesmo resultado.
- `apps/server/test/statements.test.ts`: divergência do intervalo entre lotes (caso existente), depois da reescrita do `importSql`.

## Limitações e suposições
Nada foi executado. O ganho do `INCLUDE` depende do `VACUUM` manter o mapa de visibilidade de `movements` em dia (autovacuum padrão).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no `schema.sql` antes da 0057: `statement_import_balances` chamava `financial_account_balance_at` duas vezes por lote (`app_balance_cents` e `difference_cents`), a função soma desde a abertura e o índice `movements (financial_account_id, occurred_on)` não cobria `amount_cents`; `report_cash_projection` somava o saldo de hoje por conta × horizonte. O `importSql` (`statements.ts:866-901`) expande `difference_cents` duas vezes e lê a visão de novo no LATERAL `prev`.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0057_balance_queries.sql` (grupo dos saldos, com as tarefas 093, 130 e 131); teste `database/tests/0057_balance_queries.sql`.

- Índice `movements_financial_account_id_occurred_on_idx` recriado com `INCLUDE (amount_cents)`, com o mesmo nome (continua servindo à FK). As somas por conta e data viram Index Only Scan, conferido no `EXPLAIN`.
- `statement_import_balances`:
  - O saldo do app sai de um `LEFT JOIN LATERAL (SELECT financial_account_balance_at(…) WHERE … OFFSET 0)`. O `OFFSET 0` impede o planejador de copiar a chamada para cada coluna que a usa, então há uma chamada por lote com saldo. O teste conta as chamadas por `pg_stat_get_xact_function_calls`: 5 lotes com saldo dão 5 chamadas, lendo saldo, divergência e intervalo.
  - Coluna nova no fim, `interval_difference_cents`: a divergência do lote menos a do lote anterior com saldo da mesma conta, não substituído, na ordem (`bank_balance_on`, `created_at`). É a mesma regra do LATERAL `prev`.
  - O cálculo é (banco − banco do anterior) − movimentos em (data do anterior, data do lote]. Não soma desde a abertura. Fica nula sem saldo, sem lote anterior ou com o anterior antes da abertura da conta.
  - O teste compara com a fórmula de antes: substituído fora do "anterior", mesma data desempatada pela criação, lote antes da abertura, lote sem saldo e cartão.
- `report_cash_projection`: o saldo de hoje vai para o CTE `accs AS MATERIALIZED` (uma soma por conta); `acc_rows` só soma os lançados futuros por horizonte. O teste com três horizontes confere os mesmos números.
- Decisões:
  - Manter o nome do índice, para o schema gerado mudar só no INCLUDE.
  - Não fazer o item 5 (saldos de fechamento por mês mantidos por trigger), que é "depois, se o volume pedir". Ele mexeria na escrita de `movements` e exigiria tirar a tabela derivada do backup.
- `docs/016` (Saldos e Extratos) atualizada. pgTAP rápido das áreas de saldo, extrato, calendário, relatórios, canvas e contratos passou. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`, para pegar a coluna nova `interval_difference_cents` de `statement_import_balances`.
2. `apps/server/src/services/statements.ts` (`importSql`): trocar `CASE WHEN i.superseded_by_import_id IS NULL THEN b.difference_cents - prev.difference_cents END` por `CASE WHEN i.superseded_by_import_id IS NULL THEN b.interval_difference_cents END` e apagar o `LEFT JOIN LATERAL (…) prev ON b.bank_balance_on IS NOT NULL`.
   - **Obrigatório antes do release.** Com a visão nova, o `prev` atual ordena por `pi.created_at` de outra tabela e calcula o saldo de todos os lotes anteriores da conta antes do `LIMIT 1`, o que dá custo quadrático por listagem. Com a coluna, a listagem faz uma soma por lote.
3. `apps/server/src/services/statement.ts` (`accountStatement` e `accountSummary`): ler só a conta pedida, por exemplo `SELECT … FROM financial_account_balances WHERE financial_account_id = $1` ou um `getAccountSummary(ctx, id)` em `caixas.ts`, em vez de `listAccounts` da caixa inteira e `.find`.
   - Opcional: no `accountSummary`, o `closing_cents` de cada mês pode vir de `financial_account_balance_at(conta, from − 1)` mais a soma acumulada dos `totals`. Fica uma soma desde a abertura, e não uma por mês.
4. `apps/server/test/statements.test.ts`: o caso existente da divergência do intervalo entre lotes tem de continuar passando com a coluna nova.

### Aplicação (app)

- `pnpm db:pull` já estava feito no branch de integração (a coluna `interval_difference_cents` está no schema gerado).
- `apps/server/src/services/statements.ts` (`importSql`): a divergência do intervalo vem de `b.interval_difference_cents` (nula no lote substituído, como antes) e o `LEFT JOIN LATERAL (…) prev` saiu. A listagem faz uma soma de saldo por lote.
- `apps/server/src/services/statement.ts`: `accountStatement` e `accountSummary` leem só a conta pedida (`listAccounts` ganhou o filtro `accountId`), e não a caixa inteira com `.find`. O `closing_cents` de cada mês do resumo sai do saldo antes do 1º mês mais o acumulado dos meses inteiros (duas somas, e não uma desde a abertura por mês), nulo quando o fim do mês é antes da abertura, como `financial_account_balance_at`.
- Testes: `apps/server/test/account-summary.test.ts`, no resumo, uma conta aberta no meio do período (mês antes da abertura nulo, mês da abertura e período começando no meio do mês, iguais ao `financial_account_balance_at` do fim de cada mês); o caso existente da divergência do intervalo em `test/statements.test.ts` e os de `test/statement-supersede.test.ts` passam sem mudança.
- Verificação: `pnpm verify:quick` (nível rápido).

