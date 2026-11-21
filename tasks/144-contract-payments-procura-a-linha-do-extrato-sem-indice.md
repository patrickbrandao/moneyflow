---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-11-21
commit:
---

# `contract_payments` procura a linha conciliada de cada baixa varrendo todas as linhas do sistema

- **Severidade:** baixa
- **Confiança:** provável (o `OR` com subconsulta não vira condição de índice; o plano real não foi visto)
- **Categoria:** desempenho
- **Subcategoria:** `OR` entre colunas diferentes num LATERAL por linha
- **Arquivos afetados:** `database/schema.sql:5747-5773` (`contract_payments`, CTE `legs`), `apps/server/src/services/contracts.ts:1045-1052,1097-1099`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A guia Pagamentos de um contrato e o painel de recorrentes ficam mais lentos conforme cresce o número de linhas de extrato conciliadas no sistema inteiro, e não só as do contrato. Para cada pagamento, o banco percorre todas as linhas conciliadas de todas as contas para descobrir se aquele pagamento veio do extrato.

### Evidência e análise técnica
Em `legs`, para cada baixa ativa das obrigações (`schema.sql:5762-5772`):
```sql
LEFT JOIN LATERAL (
  SELECT l.id, l.auto_settled, l.created_entry
    FROM statement_lines l JOIN movements m ON m.id = l.movement_id
   WHERE l.status = 'matched'
     AND (m.settlement_id IN (s.id, s.mirror_settlement_id)
          OR m.transfer_id IN (SELECT x.id FROM transfers x WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)))
   ORDER BY ... LIMIT 1) ln ON true
```
O `OR` liga duas colunas de `movements`, e um dos lados é um `IN (subconsulta)`. Um BitmapOr exige que os dois lados sejam indexáveis, e a subconsulta vira um filtro (SubPlan), não uma condição de índice. O PostgreSQL não reescreve `OR` entre colunas como `UNION`. Sobram dois caminhos: percorrer as linhas `matched` pelo índice parcial `statement_lines_movement_matched_key` e buscar cada movimento pela chave, ou percorrer `movements`. Os dois leem a tabela do sistema inteiro, uma vez por baixa.

Chamadores: a guia Pagamentos (`contracts.ts:1097-1099`, todas as baixas das obrigações do contrato) e o painel de recorrentes (`contracts.ts:1045-1052`, um `CROSS JOIN LATERAL contract_payments(c.id, ...)` por contrato com cobrança no cartão).

### Verificação (tentativa de refutação)
- Existem `movements_settlement_id_idx`, `movements_transfer_id_idx`, `transfers_settlement_id_key` e `statement_lines_movement_id_idx`. Separados, os dois lados do `OR` seriam buscas por índice. Juntos no `OR`, não.
- O ramo do cartão (`card_rows`) usa `l.card_invoice_item_id = pi.item_id`, que é indexado. Só `legs` tem o problema.
- `database/tests/0052_contracts_on_series.sql` confere os valores, não o plano.

### Impacto
O custo cresce com (baixas do contrato × linhas conciliadas do sistema). Um aluguel de três anos tem cerca de 36 baixas. Com dezenas de milhares de linhas conciliadas no banco, a guia Pagamentos passa a fazer centenas de milhares de junções. Quem tem só contratos pequenos não percebe.

## Como reproduzir
`EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM contract_payments('<contrato com 36 baixas>')` num banco com muitas linhas `matched`: o subplano de `ln` mostra `loops=36` com leitura das linhas conciliadas em cada volta.

## Solução proposta
Trocar o `OR` por dois ramos indexáveis, cada um pegando o melhor candidato, e ficar com o melhor dos dois:
```sql
LEFT JOIN LATERAL (
  SELECT * FROM (
    SELECT l.id, l.auto_settled, l.created_entry, l.matched_at
      FROM movements m JOIN statement_lines l ON l.movement_id = m.id AND l.status = 'matched'
     WHERE m.settlement_id IN (s.id, s.mirror_settlement_id)
    UNION ALL
    SELECT l.id, l.auto_settled, l.created_entry, l.matched_at
      FROM transfers x JOIN movements m ON m.transfer_id = x.id
      JOIN statement_lines l ON l.movement_id = m.id AND l.status = 'matched'
     WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)
  ) c
  ORDER BY c.auto_settled DESC, (c.created_entry IS NOT NULL) DESC, c.matched_at, c.id
  LIMIT 1) ln ON true
```

## Critérios de aceite
- [ ] O `EXPLAIN` de `contract_payments` mostra busca por índice em `movements.settlement_id` e em `transfers.settlement_id` dentro de `ln`.
- [ ] Os resultados de `database/tests/0051_contract_payments.sql` e `0052_contracts_on_series.sql` não mudam (origem `auto`, `reconciliation` e `manual`, `transfer_settlement` do histórico).

## Testes recomendados
`database/tests/0052_contracts_on_series.sql`: os casos existentes de origem da baixa, mais uma baixa com transferência conciliada só pela perna da transferência (`transfer_settlement`), para garantir que o segundo ramo continua achando a linha.

## Limitações e suposições
Nada foi executado. A ordem de desempate (`auto_settled`, `created_entry`, `matched_at`, `id`) foi mantida igual.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: no CTE `legs` de `contract_payments`, o LATERAL `ln` filtrava `m.settlement_id IN (…) OR m.transfer_id IN (SELECT … FROM transfers …)`. No plano do schema da 0057, isso aparece como filtro `((settlement_id = ANY (…)) OR (ANY (transfer_id = (hashed SubPlan …))))` sobre as linhas conciliadas, sem condição de índice em `movements`.

## Resolução (executor)

Migration `database/migrations/0058_query_performance.sql` (com as tarefas 146 e 147); teste `database/tests/0058_query_performance.sql`.

- O `ln` virou dois ramos num `UNION ALL`, com a mesma ordem de desempate (`auto_settled`, `created_entry`, `matched_at`, `id`):
  - movimento da baixa ou da perna do espelho: `movements.settlement_id = ANY (s.id, s.mirror_settlement_id)` e a linha por `movement_id`;
  - perna da transferência da baixa: `movements.transfer_id = ANY (ARRAY(SELECT x.id FROM transfers x WHERE x.settlement_id IN (…)))` e a linha por `movement_id`.
- No segundo ramo, a transferência vai num `ARRAY(…)` e não num JOIN. Com o JOIN, a estimativa de `movements.transfer_id` (quase todo nulo) levava o planejador a varrer as linhas num hash join.
- Testes:
  - Origem `auto`, `manual` com e sem linha, `reconciliation` pela perna da transferência (`transfer_settlement`, com `transfer_id` e `funding_account_id`) e pela perna do espelho; a linha só sugerida não conta.
  - Desempate entre a linha da baixa e a da transferência (ramos diferentes).
  - Com 1.500 linhas conciliadas e `ANALYZE`, o plano parte de `movements_settlement_id_idx` e de `movements_transfer_id_idx`, sem o `OR` com subconsulta.
  - O mesmo arquivo passou na função antiga antes da migration, então o resultado não mudou.
- Os pgTAP `0051_contract_payments.sql` e `0052_contracts_on_series.sql` passam sem mudança. `make dump` rodado.
- Nada a fazer na aplicação: a assinatura e as colunas são as mesmas.
