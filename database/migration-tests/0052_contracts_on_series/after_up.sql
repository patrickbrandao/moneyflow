-- Conferências depois de subir a 0052 sobre o fixture. :pass = 1 na primeira subida, 2 depois de descer e subir de
-- novo (a descida perde a conta prevista que era cofre: na segunda, a parcela 1 do K1 cai no fallback da última baixa).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Atalhos dos ids do fixture.
-- K1: parcela i do ciclo y; K2: lado s, parcela i; K5: parcela i.
CREATE FUNCTION pg_temp.k1(y int, i int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-7000-8000-52000001' || lpad(y::text, 2, '0') || lpad(i::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.k2(s int, i int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-7000-8000-52000002' || lpad(s::text, 2, '0') || lpad(i::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.rule_of(p_contract text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.id FROM recurrence_rules r WHERE r.contract_id = ('00000000-0000-7000-8000-52000000' || p_contract)::uuid
$$;

-- O que saiu e o que entrou --------------------------------------------------------------------------------------------
SELECT hasnt_column('contracts', c) FROM unnest(ARRAY['payment_account_id', 'transit_account_id', 'late_fee_percent',
  'interest_month_percent', 'early_discount_percent', 'tolerance_cents', 'match_window_days', 'auto_settle']) c;
SELECT hasnt_column('titles', 'planned_transit_account_id');
SELECT has_column('contracts', c) FROM unnest(ARRAY['starts_on', 'ends_on']) c;
SELECT is((SELECT count(*)::int FROM titles WHERE origin = 'contract'), 0, 'nenhum título com origin contract');

-- Contratos: vigência e status ---------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT name, status, starts_on, ends_on, terminated_on FROM contracts ORDER BY name$$,
  $$VALUES ('Aluguel', 'active', date '2025-01-01', date '2026-12-31', NULL::date),
           ('Garagem', 'ended', date '2024-01-01', date '2024-12-31', NULL::date),
           ('Rascunho', 'draft', date '2026-02-01', date '2027-01-31', NULL::date),
           ('Suporte ACME', 'terminated', date '2025-03-15', date '2025-09-30', date '2025-09-30'),
           ('Taxa anual', 'active', date '2025-05-01', date '2026-04-30', NULL::date)$$,
  'vigência do primeiro início ao último fim (rescindido: até a rescisão); renovação pendente vira vigente');
SELECT results_eq(
  $$SELECT id, status, decided_at IS NOT NULL, new_cycle_id FROM contract_renewal_tasks ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-520000000b01'::uuid, 'approved', true, '00000000-0000-7000-8000-5200000000d2'::uuid),
           ('00000000-0000-7000-8000-520000000b02'::uuid, 'closed', true, NULL::uuid)$$,
  'a tarefa aprovada fica; a aberta é fechada');
SELECT is((SELECT count(*)::int FROM contract_cycles), 6, 'os ciclos ficam como histórico');
SELECT results_eq(
  $$SELECT ends_on, installments_count FROM contract_cycles ORDER BY contract_id, seq$$,
  $$VALUES (date '2025-12-31', 12::smallint), (date '2026-12-31', 12::smallint), (date '2026-03-14', 4::smallint),
           (date '2026-04-30', 1::smallint), (date '2027-01-31', 12::smallint), (date '2024-12-31', 12::smallint)$$,
  'fim e parcelas dos ciclos preservados (agora colunas comuns)');

-- Séries dos contratos ----------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM recurrence_rules WHERE contract_id IS NOT NULL), 3,
          'uma série por contrato com parcelas mensais/trimestrais (K1, K2, K5); parcela única e rascunho não têm');
SELECT results_eq(
  $$SELECT frequency, interval_count::int, anchor_day::int, starts_on, ends_on, installments_total::int, caixa_id,
           match_window_days::int, late_fee_percent, interest_month_percent, early_discount_percent, tolerance_cents,
           auto_settle
      FROM recurrence_rules WHERE contract_id = '00000000-0000-7000-8000-52000000c001'$$,
  $$VALUES ('monthly', 1, 10, date '2025-01-10', date '2026-12-10', NULL::int, '00000000-0000-7000-8000-5200000000c1'::uuid,
            20, 2.0000::numeric, 1.0000::numeric, 5.0000::numeric, 500::bigint, true)$$,
  'K1: mensal no dia 10, do primeiro ao último vencimento, na caixa do contrato, com os ajustes do contrato');
SELECT results_eq(
  $$SELECT frequency, interval_count::int, anchor_day::int, starts_on, ends_on, caixa_id, match_window_days::int,
           late_fee_percent, tolerance_cents, auto_settle
      FROM recurrence_rules WHERE contract_id = '00000000-0000-7000-8000-52000000c002'$$,
  $$VALUES ('monthly', 3, 31, date '2025-04-30', date '2025-07-31', '00000000-0000-7000-8000-5200000000c2'::uuid, 15,
            NULL::numeric, 0::bigint, false)$$,
  'K2: trimestral no dia 31 (30/04, 31/07…); rescindido: termina no último vencimento não cancelado');
SELECT results_eq(
  $$SELECT frequency, interval_count::int, anchor_day::int, starts_on, ends_on
      FROM recurrence_rules WHERE contract_id = '00000000-0000-7000-8000-52000000c005'$$,
  $$VALUES ('monthly', 1, 15, date '2024-01-15', date '2024-12-15')$$, 'K5: encerrado');

-- Ocorrências: na ordem do vencimento, o calendário bate com cada título e a seguinte cai depois do fim.
SELECT is_empty($$
  SELECT t.id FROM titles t JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
   WHERE r.contract_id IS NOT NULL
     AND recurrence_occurrence_due(r.frequency, r.interval_count, r.anchor_day, r.starts_on, t.occurrence) <> t.due_date
$$, 'o calendário da série dá exatamente o vencimento de cada ocorrência migrada');
SELECT is_empty($$
  SELECT r.id FROM recurrence_rules r
   WHERE r.contract_id IS NOT NULL
     AND recurrence_occurrence_due(r.frequency, r.interval_count, r.anchor_day, r.starts_on,
                                   (SELECT max(t.occurrence) FROM titles t WHERE t.recurrence_rule_id = r.id) + 1) <= r.ends_on
$$, 'a ocorrência seguinte à última fica depois do fim: o worker não cria nada além nem repete um mês');

SELECT results_eq(
  $$SELECT t.occurrence::int, t.contract_cycle_id, t.contract_installment::int, t.amount_cents, t.status, t.origin
      FROM titles t WHERE t.contract_id = '00000000-0000-7000-8000-52000000c001' ORDER BY t.occurrence$$,
  $$SELECT n, CASE WHEN n <= 12 THEN '00000000-0000-7000-8000-5200000000d1'::uuid ELSE '00000000-0000-7000-8000-5200000000d2'::uuid END,
           CASE WHEN n <= 12 THEN n ELSE n - 12 END,
           CASE WHEN n > 12 THEN 120000::bigint WHEN n <= 6 THEN 100000::bigint ELSE 110000::bigint END,
           CASE n WHEN 1 THEN 'paid' WHEN 2 THEN 'paid' WHEN 3 THEN 'paid' WHEN 4 THEN 'partial' WHEN 5 THEN 'canceled'
                  ELSE 'open' END,
           'recurrence'
      FROM generate_series(1, 24) n$$,
  'K1: 24 ocorrências em ordem, com ciclo e parcela de antes como histórico, valores do aditivo e do reajuste, status');
SELECT is((SELECT count(*)::int FROM titles WHERE contract_id = '00000000-0000-7000-8000-52000000c001'
                                            AND recurrence_rule_id = pg_temp.rule_of('c001')), 24,
          'K1: todas as parcelas na série do contrato');
SELECT results_eq(
  $$SELECT t.id, t.origin, t.recurrence_rule_id = pg_temp.rule_of('c002'), t.occurrence::int, t.status, m.occurrence::int,
           m.recurrence_rule_id = t.recurrence_rule_id, m.contract_id
      FROM titles t JOIN titles m ON m.id = t.mirror_title_id
     WHERE t.contract_id = '00000000-0000-7000-8000-52000000c002' AND t.mirror_status IS NULL ORDER BY t.occurrence$$,
  $$VALUES (pg_temp.k2(1, 1), 'recurrence', true, 1, 'paid', 1, true, '00000000-0000-7000-8000-52000000c002'::uuid),
           (pg_temp.k2(1, 2), 'recurrence', true, 2, 'open', 2, true, '00000000-0000-7000-8000-52000000c002'::uuid),
           (pg_temp.k2(1, 3), 'recurrence', true, 3, 'canceled', 3, true, '00000000-0000-7000-8000-52000000c002'::uuid),
           (pg_temp.k2(1, 4), 'recurrence', true, 4, 'canceled', 4, true, '00000000-0000-7000-8000-52000000c002'::uuid)$$,
  'K2: o espelho repete série, ocorrência e contrato; canceladas continuam canceladas');
SELECT results_eq(
  $$SELECT id, origin, contract_id, contract_cycle_id, recurrence_rule_id FROM titles
     WHERE id IN ('00000000-0000-7000-8000-520000020301', '00000000-0000-7000-8000-520000030101') ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-520000020301'::uuid, 'manual', '00000000-0000-7000-8000-52000000c002'::uuid, NULL::uuid, NULL::uuid),
           ('00000000-0000-7000-8000-520000030101'::uuid, 'manual', '00000000-0000-7000-8000-52000000c003'::uuid,
            '00000000-0000-7000-8000-5200000000d4'::uuid, NULL::uuid)$$,
  'multa e parcela única: avulsos ligados ao contrato');

-- Conta prevista ---------------------------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT t.occurrence::int, t.planned_account_id, t.planned_account_custom FROM titles t
     WHERE t.contract_id = '00000000-0000-7000-8000-52000000c001' AND t.occurrence IN (1, 2, 3, 8, 13) ORDER BY 1$$,
  format($$VALUES (1, %L::uuid, false), (2, '00000000-0000-7000-8000-5200000000a1'::uuid, true),
                  (3, %L::uuid, false), (8, '00000000-0000-7000-8000-5200000000a1'::uuid, false), (13, %L::uuid, false)$$,
         CASE :pass WHEN 1 THEN '00000000-0000-7000-8000-5200000000a2' ELSE '00000000-0000-7000-8000-5200000000a1' END,
         CASE :pass WHEN 1 THEN '00000000-0000-7000-8000-5200000000a2' ELSE '00000000-0000-7000-8000-5200000000a1' END,
         CASE :pass WHEN 1 THEN '00000000-0000-7000-8000-5200000000a2' ELSE '00000000-0000-7000-8000-5200000000a1' END),
  'prevista de outra caixa vira a de passagem (o cofre); a própria fica; sem conta: a da última baixa ativa do contrato');
SELECT results_eq(
  $$SELECT t.id, t.planned_account_id FROM titles t
     WHERE t.contract_id = '00000000-0000-7000-8000-52000000c002' AND t.occurrence = 1 ORDER BY t.mirror_status NULLS FIRST$$,
  $$VALUES (pg_temp.k2(1, 1), '00000000-0000-7000-8000-5200000000b1'::uuid), (pg_temp.k2(2, 1), NULL::uuid)$$,
  'K2: a conta da última baixa só no lado com baixas (o espelho na ACME fica sem)');
SELECT is((SELECT count(planned_account_id)::int FROM titles WHERE contract_id = '00000000-0000-7000-8000-52000000c005'), 0,
          'K5 sem baixas: sem conta');
SELECT is_empty($$SELECT t.id FROM titles t JOIN financial_accounts a ON a.id = t.planned_account_id
                   WHERE a.caixa_id <> t.caixa_id$$, 'toda conta prevista é da caixa do título');

-- Nada se perdeu: baixas, movimentos, transferências, conciliação, documentos, aditivo -------------------------------
SELECT results_eq(
  $$SELECT (SELECT count(*)::int FROM settlements), (SELECT count(*)::int FROM settlements WHERE reversed_at IS NULL),
           (SELECT count(*)::int FROM movements), (SELECT count(*)::int FROM transfers WHERE settlement_id IS NOT NULL),
           (SELECT count(*)::int FROM contract_documents), (SELECT count(*)::int FROM contract_document_versions),
           (SELECT count(*)::int FROM contract_amendments)$$,
  $$VALUES (6, 5, 9, 1, 3, 2, 1)$$, 'baixas, movimentos, transferência, documentos, versões e aditivo intactos');
SELECT results_eq(
  $$SELECT id, status, created_entry, auto_settled, movement_id FROM statement_lines ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-5200000009a1'::uuid, 'matched', 'settlement', false, '00000000-0000-7000-8000-5200000006a3'::uuid),
           ('00000000-0000-7000-8000-5200000009b1'::uuid, 'matched', 'transfer_settlement', true, '00000000-0000-7000-8000-5200000006b1'::uuid)$$,
  'linhas conciliadas intactas, inclusive a transfer_settlement automática');
SELECT results_eq(
  $$SELECT contract_cycle_id, recurrence_rule_ids, cardinality(affected_title_ids) FROM contract_amendments$$,
  $$VALUES ('00000000-0000-7000-8000-5200000000d1'::uuid, '{}'::uuid[], 6)$$, 'aditivo: ciclo e títulos atingidos');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'titles' AND action = 'insert'
                     AND record_id = pg_temp.k1(1, 1)), 'auditoria de antes preservada');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'titles' AND action = 'update' AND actor_kind = 'system'
                     AND record_id = pg_temp.k1(1, 1) AND 'recurrence_rule_id' = ANY (changed_columns)),
          'a conversão do título fica na auditoria como system');

-- contract_payments pelas obrigações ------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT kind, occurrence, status, settled_cents, interest_cents, fine_cents, discount_cents, cash_cents, paid_on, days,
           overdue, last_origin
      FROM contract_payments('00000000-0000-7000-8000-52000000c001', NULL, '2025-06-30', '2025-04-20')$$,
  $$VALUES ('title', 1, 'paid', 100000::bigint, 166::bigint, 2000::bigint, 0::bigint, 102166::bigint, date '2025-01-15', 5, false, 'auto'),
           ('title', 2, 'paid', 100000, 0, 0, 5000, 95000, date '2025-02-08', -2, false, 'manual'),
           ('title', 3, 'paid', 100000, 0, 0, 0, 100000, date '2025-03-12', 2, false, 'reconciliation'),
           ('title', 4, 'partial', 40000, 0, 0, 0, 40000, NULL::date, 10, true, 'manual'),
           ('title', 6, 'open', 0, 0, 0, 0, 0, NULL::date, NULL::int, false, NULL::text)$$,
  'K1 até junho: as ocorrências não canceladas com as baixas ativas, os dias e a origem');
SELECT is((SELECT funding_account_id FROM contract_payments('00000000-0000-7000-8000-52000000c001') WHERE occurrence = 1),
          '00000000-0000-7000-8000-5200000000b1'::uuid, 'a conta da Empresa que financiou a baixa de P1');
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-52000000c001')), 23,
          'K1: 23 ocorrências não canceladas');
SELECT results_eq(
  $$SELECT kind, recurrence_rule_id IS NULL, title_id FROM contract_payments('00000000-0000-7000-8000-52000000c002')$$,
  $$VALUES ('title', false, pg_temp.k2(1, 1)), ('title', false, pg_temp.k2(1, 2)),
           ('title', true, '00000000-0000-7000-8000-520000020301'::uuid)$$,
  'K2: o lado do contrato, sem as canceladas, com a multa avulsa');

-- Séries que não são de contrato ------------------------------------------------------------------------------------
SELECT is((SELECT caixa_id FROM recurrence_rules WHERE id = '00000000-0000-7000-8000-5200000000aa'),
          '00000000-0000-7000-8000-5200000000c1'::uuid, 'série comum: a caixa dos títulos');
SELECT ok(NOT EXISTS (SELECT 1 FROM recurrence_rules WHERE id = '00000000-0000-7000-8000-5200000000ab'), 'regra órfã removida');
SELECT results_eq(
  $$SELECT t.occurrence::int, t.caixa_id, r.caixa_id, r.ends_on, r.id = '00000000-0000-7000-8000-5200000000ac'
      FROM titles t JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
     WHERE t.description = 'Limpeza' ORDER BY t.occurrence$$,
  $$VALUES (1, '00000000-0000-7000-8000-5200000000c1'::uuid, '00000000-0000-7000-8000-5200000000c1'::uuid, date '2025-02-20', false),
           (2, '00000000-0000-7000-8000-5200000000c1'::uuid, '00000000-0000-7000-8000-5200000000c1'::uuid, date '2025-02-20', false),
           (3, '00000000-0000-7000-8000-5200000000c2'::uuid, '00000000-0000-7000-8000-5200000000c2'::uuid, NULL::date, true)$$,
  'série com ocorrência movida de caixa: dividida; a parte antiga termina no último vencimento dela');

SELECT * FROM finish();
ROLLBACK;
