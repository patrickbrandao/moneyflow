-- Conferências depois de descer a 0052 (melhor esforço): os contratos voltam ao modelo de parcelas da 0051.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_column('contracts', c) FROM unnest(ARRAY['payment_account_id', 'transit_account_id', 'late_fee_percent',
  'interest_month_percent', 'early_discount_percent', 'tolerance_cents', 'match_window_days', 'auto_settle']) c;
SELECT has_column('titles', 'planned_transit_account_id');
SELECT hasnt_column('contracts', c) FROM unnest(ARRAY['starts_on', 'ends_on']) c;
SELECT hasnt_column('recurrence_rules', c) FROM unnest(ARRAY['caixa_id', 'contract_id', 'auto_settle']) c;
SELECT hasnt_table('card_recurring_charges');
SELECT has_function('contract_payments', ARRAY['uuid', 'uuid', 'date']);
SELECT is((SELECT attgenerated::text FROM pg_attribute WHERE attrelid = 'contract_cycles'::regclass AND attname = c), 's',
          c || ' volta a ser gerada') FROM unnest(ARRAY['ends_on', 'installments_count']) c;

-- Parcelas de volta: origin contract, sem série, com o ciclo e a parcela de antes.
SELECT results_eq(
  $$SELECT contract_id, count(*)::int, count(contract_cycle_id)::int, count(recurrence_rule_id)::int
      FROM titles WHERE origin = 'contract' GROUP BY contract_id ORDER BY contract_id$$,
  $$VALUES ('00000000-0000-7000-8000-52000000c001'::uuid, 24, 24, 0), ('00000000-0000-7000-8000-52000000c002'::uuid, 9, 8, 0),
           ('00000000-0000-7000-8000-52000000c003'::uuid, 1, 1, 0), ('00000000-0000-7000-8000-52000000c005'::uuid, 12, 12, 0)$$,
  'as parcelas e os títulos extras voltam a origin contract');
SELECT is((SELECT count(*)::int FROM recurrence_rules r
            WHERE NOT EXISTS (SELECT 1 FROM titles t WHERE t.recurrence_rule_id = r.id)), 0,
          'as séries dos contratos saem; nenhuma regra órfã');
SELECT results_eq(
  $$SELECT contract_installment::int, amount_cents, status FROM titles
     WHERE contract_cycle_id = '00000000-0000-7000-8000-5200000000d1' ORDER BY contract_installment$$,
  $$SELECT n, CASE WHEN n <= 6 THEN 100000::bigint ELSE 110000::bigint END,
           CASE n WHEN 1 THEN 'paid' WHEN 2 THEN 'paid' WHEN 3 THEN 'paid' WHEN 4 THEN 'partial' WHEN 5 THEN 'canceled'
                  ELSE 'open' END
      FROM generate_series(1, 12) n$$, 'K1 ciclo 1 como antes');

-- Contrato K1: renovação pendente de novo, com a tarefa aberta; ajustes de volta a partir da série.
SELECT results_eq(
  $$SELECT status, late_fee_percent, interest_month_percent, early_discount_percent, tolerance_cents, match_window_days,
           auto_settle, payment_account_id, transit_account_id
      FROM contracts WHERE id = '00000000-0000-7000-8000-52000000c001'$$,
  $$VALUES ('renewal_pending', 2.0000::numeric, 1.0000::numeric, 5.0000::numeric, 500::bigint, 20::smallint, true,
            NULL::uuid, NULL::uuid)$$,
  'K1: renovação pendente, ajustes restaurados (conta das parcelas perdida)');
SELECT results_eq(
  $$SELECT id, status, decided_at IS NULL FROM contract_renewal_tasks ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-520000000b01'::uuid, 'approved', false),
           ('00000000-0000-7000-8000-520000000b02'::uuid, 'open', true)$$, 'a tarefa fechada volta a aberta');
SELECT results_eq($$SELECT name, status FROM contracts ORDER BY name$$,
  $$VALUES ('Aluguel', 'renewal_pending'), ('Garagem', 'ended'), ('Rascunho', 'draft'), ('Suporte ACME', 'terminated'),
           ('Taxa anual', 'active')$$, 'status de antes');

-- Conta prevista: a de passagem (cofre) não é mais aceita como prevista e fica nula; corrente/poupança ficam.
SELECT results_eq(
  $$SELECT contract_installment::int, planned_account_id, planned_transit_account_id FROM titles
     WHERE contract_cycle_id = '00000000-0000-7000-8000-5200000000d1' AND contract_installment IN (1, 2, 8)
     ORDER BY 1$$,
  $$VALUES (1, NULL::uuid, NULL::uuid), (2, '00000000-0000-7000-8000-5200000000a1'::uuid, NULL::uuid),
           (8, '00000000-0000-7000-8000-5200000000a1'::uuid, NULL::uuid)$$, 'conta prevista de volta ao modelo da 0051');

-- Nada se perdeu.
SELECT results_eq(
  $$SELECT (SELECT count(*)::int FROM settlements), (SELECT count(*)::int FROM movements),
           (SELECT count(*)::int FROM transfers), (SELECT count(*)::int FROM contract_documents),
           (SELECT count(*)::int FROM contract_amendments), (SELECT count(*)::int FROM contract_cycles)$$,
  $$VALUES (6, 9, 1, 3, 1, 6)$$, 'baixas, movimentos, transferência, documentos, aditivo e ciclos intactos');
SELECT results_eq(
  $$SELECT id, status, created_entry, auto_settled FROM statement_lines ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-5200000009a1'::uuid, 'matched', 'settlement', false),
           ('00000000-0000-7000-8000-5200000009b1'::uuid, 'matched', 'transfer_settlement', true)$$, 'linhas intactas');
SELECT results_eq(
  $$SELECT installment, status, paid_on, days, last_origin
      FROM contract_payments('00000000-0000-7000-8000-52000000c001', '00000000-0000-7000-8000-5200000000d1', '2025-04-20')
     WHERE installment <= 4$$,
  $$VALUES (1, 'paid', date '2025-01-15', 5, 'auto'), (2, 'paid', date '2025-02-08', -2, 'manual'),
           (3, 'paid', date '2025-03-12', 2, 'reconciliation'), (4, 'partial', NULL::date, 10, 'manual')$$,
  'contract_payments da 0051 lê as parcelas de volta');

-- As checagens do COMMIT do modelo antigo passam.
SELECT lives_ok($$SET CONSTRAINTS ALL IMMEDIATE$$, 'checagens adiadas coerentes');

SELECT * FROM finish();
ROLLBACK;
