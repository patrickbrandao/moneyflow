---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-20
commit:
---

# Pagamentos de contrato no extrato no banco (F19)

## Descrição
A seção "Banco (dba)" da spec [033](../docs/033-pagamentos-de-contrato-no-extrato.md): em `contracts`, a conta das parcelas, a de passagem, os encargos (multa, juros ao mês, desconto, tolerância), a janela e `auto_settle`; em `titles`, a conta prevista, a de passagem e `planned_account_custom`; em `statement_lines`, a baixa com transferência no `created_entry` e `auto_settled`; a leitura `contract_payments`. Atualizar a 016 e o `schema.sql`.

Ordem: depois da [039](039-regras-por-conta-no-banco.md) (migration seguinte à 0050); a [042](042-pagamentos-de-contrato-na-aplicacao.md) depende desta.

## Como reproduzir
Não se aplica (recurso novo). Pronto: pgTAP da migration passando em `make -C database test`.

## Análise (triagem)
Designada direto pela sessão principal (pedido do usuário em 2026-10-20).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0051_contract_payments.sql`, teste novo `database/tests/0051_contract_payments.sql` (131 testes) e as listas de colunas de `0008_titles.sql`, `0014_statements.sql` e `0032_contracts.sql` ajustadas. `make test` completo: 47 arquivos, 3657 testes, PASS (inclui o down da 0051). `schema.sql` regravado. Detalhes na [016](../docs/016-banco-de-dados.md) (Títulos, Contratos → Conta das parcelas e encargos, Extratos).

- **contracts**: `payment_account_id`, `transit_account_id` (FKs `financial_accounts`, RESTRICT, com índice), `late_fee_percent`/`interest_month_percent`/`early_discount_percent` `numeric(6,4)` nulos (0–20, 0–10, 0–50: `contracts_late_fee_percent_check`, `contracts_interest_month_percent_check`, `contracts_early_discount_percent_check`), `tolerance_cents bigint NOT NULL DEFAULT 0` (`contracts_tolerance_cents_check`, ≥ 0), `match_window_days smallint NOT NULL DEFAULT 15` (`contracts_match_window_days_check`, 0–45), `auto_settle boolean NOT NULL DEFAULT false`. O teto de 10% da parcela na tolerância ficou na aplicação (o valor da parcela muda por ciclo e aditivo).
- **Contas** (trigger `contracts_validate_accounts`/`titles_validate_planned_account`, auxiliar `payment_accounts_assert`): `23514 contracts_payment_account_check` / `titles_planned_account_check` — conta das parcelas/prevista não é `checking`/`savings`; `23514 contracts_transit_account_check` / `titles_planned_transit_account_check` — passagem faltando com a conta de outra caixa, passagem com a conta da própria caixa, passagem sem conta, ou passagem de outra caixa. A passagem pode ser de qualquer tipo (inclusive cofre). Revalida quando o contrato (rascunho) ou o título muda de caixa.
- **financial_accounts** (trigger `financial_accounts_validate_payment_refs`): a conta referenciada como das parcelas/prevista não muda de caixa nem deixa de ser `checking`/`savings`; a de passagem não muda de caixa — mesmos nomes de constraint acima, conforme a referência. Excluir conta referenciada: `23503 contracts_payment_account_id_fkey`, `contracts_transit_account_id_fkey`, `titles_planned_account_id_fkey`, `titles_planned_transit_account_id_fkey`.
- **titles**: `planned_account_id`, `planned_transit_account_id` (FKs, RESTRICT), `planned_account_custom boolean NOT NULL DEFAULT false` (sem regra no banco). Índices `titles_planned_account_id_idx` (FK, não nulos), `titles_planned_account_open_idx` (conta + vencimento, só `open`/`partial`) e `titles_planned_transit_account_id_idx`. Fora da trava de mês fechado e do espelho.
- **statement_lines**: `created_entry = 'transfer_settlement'` (a baixa na conta de passagem + a transferência com `settlement_id`; `movement_id` = a perna da transferência na conta da linha; o desfazer apaga as duas). `statement_lines_created_entry_check` aceita o valor; `23514 statement_lines_created_entry_links_check` exige `movement_id` e, pelo trigger `statement_lines_validate_created_entry`, que seja movimento de transferência com `settlement_id`. `auto_settled boolean NOT NULL DEFAULT false`: `23514 statement_lines_auto_settled_check` — só em `matched` com `created_entry` `settlement`/`transfer_settlement`.
- **Leitura**: `contract_payments(p_contract_id uuid, p_cycle_id uuid DEFAULT NULL, p_today date DEFAULT hoje em SP)` → `title_id, contract_cycle_id, cycle_seq, installment, installments_count, competence_date, due_date, amount_cents, status, settled_cents, open_cents, interest_cents, fine_cents, discount_cents, cash_cents, settlement_count, last_settled_on, paid_on, days, overdue, account_id, funding_account_id, planned_account_id, planned_transit_account_id, planned_account_custom, last_origin, settlements jsonb`. Parcelas não canceladas do lado do contrato; origem `manual|reconciliation|auto`. `EXECUTE` para `moneyflow_app`, `SECURITY INVOKER`.
- **Down**: `transfer_settlement` vira nulo (linha conciliada sem a marca), `auto_settled` e as colunas saem.
- Para a 042: `pnpm db:pull`; traduzir as constraints acima; `deleteCreatedEntry` para `transfer_settlement` (soltar a linha, apagar os movimentos da baixa e a transferência, a baixa); limpar `auto_settled` junto com `created_entry` (desfazer, ignorar, a troca do provisório — que pode levar a marca para a linha do consolidado junto com `created_entry`); `LINE_CREATED_ENTRIES` no shared; antes de excluir uma conta, soltar as referências (ou recusar com o `23503`); conferir no backup (019) a ordem das FKs novas de `contracts`/`titles` para `financial_accounts`.
