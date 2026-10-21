-- Testes de 0052_contracts_on_series (spec 034): o calendário da série no banco, a série com caixa, contrato e ajustes
-- de reconhecimento, os títulos de série ligados ao contrato, a cobrança esperada no cartão (com o valor por degraus),
-- a compra ligada à ocorrência (uma não estornada por ocorrência), o rascunho, a notificação "não cobrada", a baixa
-- sem confirmação da compra e a leitura contract_payments() pelas obrigações. A migração dos contratos de antes,
-- com dados, está em migration-tests/0052_contracts_on_series (make test-migration M=0052).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Roda o SQL, força as checagens do COMMIT e devolve "SQLSTATE constraint" (ou 'ok'). Em erro, desfaz.
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE p_sql;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(nullif(cn, ''), '-');
END
$$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-7000-8000-00000052' || p)::uuid
$$;

-- Estrutura -------------------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['card_recurring_charges', 'card_recurring_charge_amounts']) t;
SELECT columns_are('card_recurring_charges', ARRAY['recurrence_rule_id', 'payer_caixa_id', 'entity_id', 'category_id',
  'description', 'amount_cents', 'created_at', 'updated_at']);
SELECT columns_are('card_recurring_charge_amounts', ARRAY['recurrence_rule_id', 'from_occurrence', 'amount_cents',
  'created_at', 'updated_at']);
SELECT col_is_pk('card_recurring_charges', 'recurrence_rule_id');
SELECT col_is_pk('card_recurring_charge_amounts', ARRAY['recurrence_rule_id', 'from_occurrence']);
SELECT col_not_null('recurrence_rules', c) FROM unnest(ARRAY['caixa_id', 'match_window_days', 'tolerance_cents', 'auto_settle']) c;
SELECT col_is_null('recurrence_rules', c)
  FROM unnest(ARRAY['contract_id', 'late_fee_percent', 'interest_month_percent', 'early_discount_percent']) c;
SELECT col_default_is('recurrence_rules', 'match_window_days', '15');
SELECT col_default_is('recurrence_rules', 'tolerance_cents', '0');
SELECT col_default_is('recurrence_rules', 'auto_settle', 'false');
SELECT col_type_is('recurrence_rules', c, 'numeric(6,4)')
  FROM unnest(ARRAY['late_fee_percent', 'interest_month_percent', 'early_discount_percent']) c;
SELECT col_not_null('contracts', 'starts_on');
SELECT col_is_null('contracts', 'ends_on');
SELECT col_is_null('contract_cycles', c) FROM unnest(ARRAY['ends_on', 'installments_count', 'duration_months',
  'periodicity', 'total_cents', 'due_day']) c;
SELECT col_is_null('contract_amendments', 'contract_cycle_id');
SELECT col_default_is('contract_amendments', 'recurrence_rule_ids', '{}');

SELECT fk_ok('recurrence_rules', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('recurrence_rules', 'contract_id', 'contracts', 'id');
SELECT fk_ok('card_recurring_charges', 'recurrence_rule_id', 'recurrence_rules', 'id');
SELECT fk_ok('card_recurring_charges', 'payer_caixa_id', 'caixas', 'id');
SELECT fk_ok('card_recurring_charges', 'entity_id', 'entities', 'id');
SELECT fk_ok('card_recurring_charges', 'category_id', 'categories', 'id');
SELECT fk_ok('card_recurring_charge_amounts', 'recurrence_rule_id', 'card_recurring_charges', 'recurrence_rule_id');
SELECT fk_ok('card_purchases', 'contract_id', 'contracts', 'id');
SELECT fk_ok('card_purchases', ARRAY['recurrence_rule_id', 'card_caixa_id'], 'recurrence_rules', ARRAY['id', 'caixa_id']);
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = 'recurrence_rules_contract_id_fkey'), 'n',
          'excluir o contrato (rascunho) solta a série: ON DELETE SET NULL');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = 'card_recurring_charges_recurrence_rule_id_fkey'), 'c',
          'a cobrança some com a série');
SELECT has_index('recurrence_rules', i) FROM unnest(ARRAY['recurrence_rules_caixa_id_idx', 'recurrence_rules_contract_id_idx']) i;
SELECT has_index('card_purchases', i) FROM unnest(ARRAY['card_purchases_contract_id_idx', 'card_purchases_recurrence_rule_id_idx']) i;
SELECT has_index('contracts', 'contracts_ends_on_idx');
SELECT hasnt_index('contract_renewal_tasks', i) FROM unnest(ARRAY['contract_renewal_tasks_open_key', 'contract_renewal_tasks_due_on_idx']) i;
SELECT is_empty($$
  SELECT c.conrelid::regclass::text || '.' || c.conname
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN ('recurrence_rules'::regclass, 'card_recurring_charges'::regclass,
                        'card_recurring_charge_amounts'::regclass, 'card_purchases'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND (i.indkey::int2[])[0] = c.conkey[1])
$$, 'toda FK nova tem índice começando pela sua primeira coluna');

SELECT has_trigger('recurrence_rules', 'recurrence_rules_integrity_check');
SELECT has_trigger('titles', t) FROM unnest(ARRAY['titles_recurrence_integrity_check', 'titles_validate_contract',
  'titles_validate_planned_account']) t;
SELECT has_trigger('card_recurring_charges', t) FROM unnest(ARRAY['card_recurring_charges_validate',
  'card_recurring_charges_integrity_check', 'card_recurring_charges_audit', 'card_recurring_charges_set_updated_at']) t;
SELECT has_trigger('card_recurring_charge_amounts', t)
  FROM unnest(ARRAY['card_recurring_charge_amounts_audit', 'card_recurring_charge_amounts_set_updated_at']) t;
SELECT has_trigger('card_purchases', t) FROM unnest(ARRAY['card_purchases_validate_occurrence',
  'card_purchases_recurrence_integrity_check', 'card_purchases_contract_integrity_check']) t;
SELECT has_trigger('contracts', 'contracts_integrity_check');
SELECT hasnt_trigger('contracts', t) FROM unnest(ARRAY['contracts_renewal_pending_check', 'contracts_validate_accounts']) t;
SELECT hasnt_trigger('contract_renewal_tasks', 'contract_renewal_tasks_integrity_check');
SELECT hasnt_function('payment_accounts_assert');
SELECT has_function('contract_payments', ARRAY['uuid', 'date', 'date', 'date']);
SELECT hasnt_function('contract_payments', ARRAY['uuid', 'uuid', 'date']);

SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['card_recurring_charges', 'card_recurring_charge_amounts']) t;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'a aplicação executa ' || f)
  FROM unnest(ARRAY['contract_payments(uuid, date, date, date)', 'recurrence_occurrence_due(text, integer, integer, date, integer)',
                    'card_recurring_charge_amount(uuid, integer)']) f;
SELECT ok(NOT has_function_privilege('moneyflow_app', 'audit_row_keyed()', 'EXECUTE'), 'auditoria por chave é interna');

-- Calendário (o mesmo de occurrenceDueDate do shared) ---------------------------------------------------------------
SELECT results_eq(
  $$SELECT recurrence_occurrence_due(f, i, a, s, n) FROM (VALUES
      ('monthly', 1, 31, date '2026-01-31', 1), ('monthly', 1, 31, date '2026-01-31', 2), ('monthly', 1, 31, date '2026-01-31', 3),
      ('monthly', 1, 31, date '2024-01-31', 2), ('monthly', 3, 10, date '2026-01-10', 4), ('monthly', 1, 10, date '2026-11-25', 3),
      ('yearly', 1, 29, date '2024-02-29', 2), ('yearly', 1, 29, date '2024-02-29', 5),
      ('weekly', 1, 1, date '2026-10-14', 1), ('weekly', 2, 1, date '2026-10-14', 2), ('weekly', 1, 3, date '2026-10-14', 1),
      ('monthly', 1, 10, date '2026-01-10', 0)) v (f, i, a, s, n)$$,
  $$VALUES (date '2026-01-31'), (date '2026-02-28'), (date '2026-03-31'), (date '2024-02-29'), (date '2026-10-10'),
           (date '2027-01-10'), (date '2025-02-28'), (date '2028-02-29'), (date '2026-10-19'), (date '2026-11-02'),
           (date '2026-10-14'), (NULL::date)$$,
  'mês curto usa o último dia, intervalo, anual em bissexto, semanal no dia ISO; n < 1 = nulo');

-- Dados base ------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Minha Empresa'),
  (pg_temp.u('e003'), 'company', 'Imobiliária'), (pg_temp.u('e004'), 'company', 'Nu Pagamentos'),
  (pg_temp.u('e005'), 'company', 'Netflix'), (pg_temp.u('e006'), 'company', 'ACME'),
  (pg_temp.u('e007'), 'company', 'Outro Emissor');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true),
  (pg_temp.u('c002'), 'Empresa', 'general', pg_temp.u('e002'), true),
  (pg_temp.u('c003'), 'ACME', 'general', pg_temp.u('e006'), true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  (pg_temp.u('c010'), 'Nubank', 'credit_card', pg_temp.u('e004'), pg_temp.u('c001'), 500000, 3, 10, '1111'),
  (pg_temp.u('c011'), 'Outro cartão', 'credit_card', pg_temp.u('e007'), pg_temp.u('c001'), 500000, 3, 10, '2222');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  (pg_temp.u('a001'), pg_temp.u('c001'), 'checking', 'Corrente Casa', '2026-01-01'),
  (pg_temp.u('a002'), pg_temp.u('c001'), 'cash', 'Cofre Casa', '2026-01-01'),
  (pg_temp.u('b001'), pg_temp.u('c002'), 'checking', 'Corrente Empresa', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES
  (pg_temp.u('ca01'), 'expense', 'Aluguel 52'), (pg_temp.u('ca02'), 'income', 'Serviços 52'),
  (pg_temp.u('ca03'), 'expense', 'Serviços contratados 52');
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date)
SELECT pg_temp.u('a6' || lpad(m::text, 2, '0')), pg_temp.u('c010'), d, d + 2, d + 9
  FROM generate_series(1, 6) m CROSS JOIN LATERAL (SELECT make_date(2026, m, 1) AS d) x;

-- Contratos: vigência --------------------------------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id)
  VALUES (pg_temp.u('c001'), pg_temp.u('e003'), 'payable', 'X', pg_temp.u('ca01'))$$, '23502', NULL, 'o início da vigência é obrigatório');
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, status, starts_on, ends_on) VALUES
  (pg_temp.u('f001'), pg_temp.u('c001'), pg_temp.u('e003'), 'payable', 'Aluguel', pg_temp.u('ca01'), 'active', '2026-01-01', '2026-12-31'),
  (pg_temp.u('f003'), pg_temp.u('c001'), pg_temp.u('e003'), 'payable', 'Rascunho', pg_temp.u('ca01'), 'draft', '2026-01-01', NULL);
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, counterparty_caixa_id, status, starts_on) VALUES
  (pg_temp.u('f002'), pg_temp.u('c002'), pg_temp.u('e006'), 'receivable', 'Suporte', pg_temp.u('ca02'), pg_temp.u('c003'),
   'active', '2026-01-01');
SELECT is(pg_temp.err($$UPDATE contracts SET status = 'active' WHERE id = pg_temp.u('f003'); SELECT 1/0$$), '22012 -',
          'sem fim (indeterminado) vale');

-- Série: caixa e ajustes de reconhecimento -----------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('monthly', 10, '2026-01-10')$$,
                 '23502', NULL, 'a série tem caixa');
CREATE TEMP TABLE r_cases (col text, val text, expected text);
INSERT INTO r_cases VALUES
  ('match_window_days', '46', '23514 recurrence_rules_match_window_days_check'),
  ('match_window_days', '-1', '23514 recurrence_rules_match_window_days_check'),
  ('match_window_days', '0', 'ok'), ('match_window_days', '45', 'ok'),
  ('late_fee_percent', '20.0001', '23514 recurrence_rules_late_fee_percent_check'), ('late_fee_percent', '20', 'ok'),
  ('interest_month_percent', '10.5', '23514 recurrence_rules_interest_month_percent_check'),
  ('interest_month_percent', '0.0333', 'ok'),
  ('early_discount_percent', '50.01', '23514 recurrence_rules_early_discount_percent_check'),
  ('early_discount_percent', '-1', '23514 recurrence_rules_early_discount_percent_check'),
  ('tolerance_cents', '-1', '23514 recurrence_rules_tolerance_cents_check'), ('tolerance_cents', '500', 'ok');
SELECT is(pg_temp.err(format(
  $f$INSERT INTO recurrence_rules (caixa_id, frequency, anchor_day, starts_on, %I) VALUES (%L, 'monthly', 10, '2026-01-10', %L);
     SELECT 1/0$f$, col, pg_temp.u('c001'), val)),
  CASE expected WHEN 'ok' THEN '22012 -' ELSE expected END, col || ' = ' || val)
  FROM r_cases;

-- Obrigação do K1 no cofre da Casa (R1), com os ajustes.
INSERT INTO recurrence_rules (id, caixa_id, contract_id, frequency, anchor_day, starts_on, ends_on, match_window_days,
                              late_fee_percent, interest_month_percent, early_discount_percent, tolerance_cents, auto_settle)
VALUES (pg_temp.u('d001'), pg_temp.u('c001'), pg_temp.u('f001'), 'monthly', 10, '2026-01-10', '2026-12-10', 20, 2, 1, 5, 500, true);
CREATE FUNCTION pg_temp.occ(p_id text, p_rule text, p_n int, p_contract text, p_caixa text DEFAULT 'c001',
                            p_entity text DEFAULT 'e003') RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    $f$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                           amount_cents, origin, recurrence_rule_id, occurrence, contract_id, planned_account_id)
       VALUES (%L, %L, 'payable', %L, %L, 'Aluguel', %L, %L, 100000, 'recurrence', %L, %s, %L, %L)$f$,
    pg_temp.u(p_id), pg_temp.u(p_caixa), pg_temp.u(p_entity), pg_temp.u('ca01'),
    make_date(2026, p_n, 1), make_date(2026, p_n, 10), pg_temp.u(p_rule), p_n,
    CASE WHEN p_contract IS NOT NULL THEN pg_temp.u(p_contract) END,
    CASE WHEN p_caixa = 'c001' THEN pg_temp.u('a002') END)
$$;
SELECT is(pg_temp.err(pg_temp.occ('1101', 'd001', 1, 'f001') || '; ' || pg_temp.occ('1102', 'd001', 2, 'f001') || '; '
                      || pg_temp.occ('1103', 'd001', 3, 'f001')), 'ok',
          'ocorrências da obrigação, com o cofre como conta prevista e o contrato da série');
SELECT is(pg_temp.err(pg_temp.occ('1104', 'd001', 4, NULL)), '23514 titles_recurrence_contract_check',
          'a ocorrência carrega o contrato da série (no COMMIT)');
SELECT is(pg_temp.err(pg_temp.occ('1104', 'd001', 4, 'f001', 'c002')), '23514 titles_recurrence_caixa_check',
          'o lado original fica na caixa da série');
SELECT is(pg_temp.err(pg_temp.occ('1104', 'd001', 4, 'f001', 'c001', 'e005')), '23514 titles_contract_match_check',
          'a obrigação segue a contraparte do contrato');
SELECT is(pg_temp.err($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                            amount_cents, origin)
  VALUES (pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'X', '2026-01-01', '2026-01-10', 100,
          'contract')$$), '23514 titles_origin_check', 'a origem contract saiu');
SELECT is(pg_temp.err($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                            amount_cents, origin, contract_id, card_invoice_id, counterparty_caixa_id)
  VALUES (pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'X', '2026-01-01', '2026-01-10', 100,
          'card_invoice', pg_temp.u('f001'), pg_temp.u('a601'), pg_temp.u('c010'))$$), '23514 titles_contract_check',
          'título de contrato é de série ou avulso, nunca fatura');
SELECT is(pg_temp.err($$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date,
                                            due_date, amount_cents, contract_id)
  VALUES (pg_temp.u('1199'), pg_temp.u('c002'), 'receivable', pg_temp.u('e003'), pg_temp.u('ca02'), 'Multa rescisória',
          '2026-05-01', '2026-05-10', 50000, pg_temp.u('f001'))$$), 'ok',
  'título avulso ligado ao contrato, em qualquer direção e caixa');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = pg_temp.u('c002'), planned_account_id = NULL WHERE id = pg_temp.u('1103')$$),
          '23514 titles_recurrence_caixa_check', 'a ocorrência não muda de caixa sem a série');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = pg_temp.u('c002'), planned_account_id = NULL
                         WHERE recurrence_rule_id = pg_temp.u('d001');
                       UPDATE recurrence_rules SET caixa_id = pg_temp.u('c002') WHERE id = pg_temp.u('d001'); SELECT 1/0$$),
          '22012 -', 'a série muda de caixa com as ocorrências (desfeito)');

-- Ligar uma série que já existia ao contrato (R2): a série e as ocorrências na mesma transação.
INSERT INTO recurrence_rules (id, caixa_id, frequency, anchor_day, starts_on) VALUES
  (pg_temp.u('d002'), pg_temp.u('c001'), 'monthly', 10, '2026-01-10');
SELECT is(pg_temp.err(pg_temp.occ('1201', 'd002', 1, NULL)), 'ok', 'série comum');
SELECT is(pg_temp.err($$UPDATE recurrence_rules SET contract_id = pg_temp.u('f001') WHERE id = pg_temp.u('d002')$$),
          '23514 titles_recurrence_contract_check', 'ligar só a série deixa a ocorrência sem o contrato');
SELECT is(pg_temp.err($$UPDATE recurrence_rules SET contract_id = pg_temp.u('f001') WHERE id = pg_temp.u('d002');
                       UPDATE titles SET contract_id = pg_temp.u('f001') WHERE recurrence_rule_id = pg_temp.u('d002')$$),
          'ok', 'ligar a série e as ocorrências juntas');
SELECT is(pg_temp.err($$UPDATE recurrence_rules SET contract_id = NULL WHERE id = pg_temp.u('d002');
                       UPDATE titles SET contract_id = NULL WHERE recurrence_rule_id = pg_temp.u('d002')$$),
          'ok', 'desligar também');

-- Série de contrato espelhada (K2, ACME tem caixa): o espelho repete série, ocorrência e contrato.
INSERT INTO recurrence_rules (id, caixa_id, contract_id, frequency, interval_count, anchor_day, starts_on) VALUES
  (pg_temp.u('d003'), pg_temp.u('c002'), pg_temp.u('f002'), 'monthly', 3, 31, '2026-01-31');
SELECT is(pg_temp.err($$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date,
                                            due_date, amount_cents, origin, recurrence_rule_id, occurrence, contract_id,
                                            counterparty_caixa_id, mirror_title_id, mirror_status, planned_account_id)
  VALUES (pg_temp.u('1301'), pg_temp.u('c002'), 'receivable', pg_temp.u('e006'), pg_temp.u('ca02'), 'Suporte', '2026-01-01',
          '2026-01-31', 300000, 'recurrence', pg_temp.u('d003'), 1, pg_temp.u('f002'), pg_temp.u('c003'), pg_temp.u('1302'),
          NULL, pg_temp.u('b001')),
         (pg_temp.u('1302'), pg_temp.u('c003'), 'payable', pg_temp.u('e002'), pg_temp.u('ca03'), 'Suporte', '2026-01-01',
          '2026-01-31', 300000, 'recurrence', pg_temp.u('d003'), 1, pg_temp.u('f002'), pg_temp.u('c002'), pg_temp.u('1301'),
          'accepted', NULL)$$), 'ok', 'obrigação a receber espelhada na caixa da contraparte');

-- Cobrança esperada no cartão -----------------------------------------------------------------------------------------
INSERT INTO recurrence_rules (id, caixa_id, contract_id, frequency, anchor_day, starts_on, ends_on, tolerance_cents, auto_settle)
VALUES (pg_temp.u('d010'), pg_temp.u('c010'), pg_temp.u('f001'), 'monthly', 15, '2026-01-15', '2026-12-15', 100, true);
SELECT is(pg_temp.err('SELECT 1'), '23514 recurrence_rules_target_check', 'série no cartão exige a cobrança (no COMMIT)');
CREATE FUNCTION pg_temp.charge(p_rule text, p_payer text DEFAULT 'c001', p_category text DEFAULT 'ca01',
                               p_description text DEFAULT 'Assinatura', p_amount bigint DEFAULT 3990) RETURNS text
LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO card_recurring_charges (recurrence_rule_id, payer_caixa_id, entity_id, category_id, description,
                                                         amount_cents) VALUES (%L, %L, %L, %L, %L, %s)$f$,
                pg_temp.u(p_rule), pg_temp.u(p_payer), pg_temp.u('e005'), pg_temp.u(p_category), p_description, p_amount)
$$;
SELECT is(pg_temp.err(pg_temp.charge('d001')), '23514 card_recurring_charges_card_check', 'cobrança só em série de cartão');
SELECT is(pg_temp.err(pg_temp.charge('d010', 'c011')), '23514 card_recurring_charges_payer_kind_check', 'pagadora é general');
SELECT is(pg_temp.err(pg_temp.charge('d010', 'c001', 'ca02')), '23514 card_recurring_charges_category_kind_check',
          'categoria de despesa');
SELECT is(pg_temp.err(pg_temp.charge('d010', 'c001', 'ca01', ' ')), '23514 card_recurring_charges_description_check',
          'descrição obrigatória');
SELECT is(pg_temp.err(pg_temp.charge('d010', 'c001', 'ca01', 'X', 0)), '23514 card_recurring_charges_amount_cents_check',
          'valor > 0');
SELECT is(pg_temp.err(pg_temp.charge('d010')), 'ok', 'cobrança esperada do K1 no cartão');
SELECT is(pg_temp.err(pg_temp.occ('1401', 'd010', 1, 'f001')), '23514 titles_recurrence_caixa_check',
          'série de cartão não tem títulos');
SELECT is(pg_temp.err($$UPDATE recurrence_rules SET contract_id = pg_temp.u('f002') WHERE id = pg_temp.u('d010')$$),
          '23514 card_recurring_charges_contract_check', 'cobrança no cartão só em contrato a pagar');
SELECT is(pg_temp.err($$UPDATE card_recurring_charges SET recurrence_rule_id = pg_temp.u('d001')
                         WHERE recurrence_rule_id = pg_temp.u('d010')$$),
          '23514 card_recurring_charges_immutable_check', 'a série da cobrança não muda');

-- Valor por degraus (aditivo "dali em diante").
SELECT is(pg_temp.err($$INSERT INTO card_recurring_charge_amounts (recurrence_rule_id, from_occurrence, amount_cents)
                        VALUES (pg_temp.u('d010'), 1, 4490)$$),
          '23514 card_recurring_charge_amounts_from_occurrence_check', 'o degrau começa da 2ª ocorrência');
SELECT is(pg_temp.err($$INSERT INTO card_recurring_charge_amounts (recurrence_rule_id, from_occurrence, amount_cents)
                        VALUES (pg_temp.u('d010'), 4, 0)$$),
          '23514 card_recurring_charge_amounts_amount_cents_check', 'valor do degrau > 0');
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO card_recurring_charge_amounts (recurrence_rule_id, from_occurrence, amount_cents)
                  VALUES ('00000000-0000-7000-8000-00000052d010', 4, 4490)$$, 'a aplicação grava o reajuste a partir da 4ª');
RESET ROLE;
SELECT results_eq($$SELECT card_recurring_charge_amount(pg_temp.u('d010'), n) FROM generate_series(1, 5) n$$,
                  $$VALUES (3990::bigint), (3990), (3990), (4490), (4490)$$, 'valor esperado por ocorrência');
SELECT is(card_recurring_charge_amount(pg_temp.u('d001'), 1), NULL, 'série que não é de cartão: nulo');

-- Compras ligadas às ocorrências ------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.purchase(p_id text, p_on date, p_invoice text, p_rule text, p_n int, p_contract text,
                                 p_amount bigint DEFAULT 3990, p_card text DEFAULT 'c010') RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    $f$INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description,
                                   amount_cents, recurrence_rule_id, occurrence, contract_id)
       VALUES (%L, %L, %L, %L, %L, %L, 'NETFLIX.COM', %s, %L, %s, %L);
       INSERT INTO card_invoice_items (id, card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
       VALUES (%L, %L, %L, 1, %L, %s)$f$,
    pg_temp.u(p_id), pg_temp.u(p_card), pg_temp.u('c001'), pg_temp.u('e005'), pg_temp.u('ca01'), p_on, p_amount,
    CASE WHEN p_rule IS NOT NULL THEN pg_temp.u(p_rule) END, coalesce(p_n::text, 'NULL'),
    CASE WHEN p_contract IS NOT NULL THEN pg_temp.u(p_contract) END,
    pg_temp.u('6' || substr(p_id, 2)), pg_temp.u(p_invoice), pg_temp.u(p_id), pg_temp.u('c001'), p_amount)
$$;
-- Ocorrência 1 (15/01): a fatura que fecha em 03/02 fecha sem compra = não cobrada.
UPDATE card_invoices SET closed_at = now() WHERE id IN (pg_temp.u('a601'), pg_temp.u('a602'));
SELECT lives_ok($$SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED$$, 'faturas de jan e fev fechadas sem itens');
-- Ocorrência 2 (15/02): cobrada em 16/02 (fatura de março).
SELECT is(pg_temp.err(pg_temp.purchase('5002', '2026-02-16', 'a603', 'd010', 2, 'f001')), 'ok', 'compra ligada à ocorrência 2');
SELECT is(pg_temp.err(pg_temp.purchase('500a', '2026-02-17', 'a603', 'd010', 2, 'f001')), '23505 card_purchases_occurrence_key',
          'uma compra não estornada por ocorrência');
SELECT is(pg_temp.err(pg_temp.purchase('500b', '2026-02-17', 'a603', 'd010', 9, NULL)), '23514 card_purchases_recurrence_contract_check',
          'a compra carrega o contrato da série (no COMMIT)');
SELECT is(pg_temp.err(pg_temp.purchase('500c', '2026-02-17', 'a603', 'd010', 9, 'f001', 3990, 'c011')),
          '23503 card_purchases_recurrence_rule_id_fkey', 'a série é do mesmo cartão');
SELECT is(pg_temp.err($$INSERT INTO card_purchases (card_caixa_id, kind, payer_caixa_id, entity_id, category_id, purchased_on,
                                                    description, amount_cents, refunded_purchase_id, recurrence_rule_id, occurrence)
  VALUES (pg_temp.u('c010'), 'refund', pg_temp.u('c001'), pg_temp.u('e005'), pg_temp.u('ca01'), '2026-02-20', 'Estorno', 10,
          pg_temp.u('5002'), pg_temp.u('d010'), 2)$$), '23514 card_purchases_recurrence_check', 'só a compra se liga à ocorrência');
SELECT is(pg_temp.err(pg_temp.purchase('5003', '2026-02-18', 'a603', NULL, NULL, 'f003')), '23514 contracts_draft_titles_check',
          'rascunho não tem compras ligadas');
-- Ocorrência 3 (15/03): cobrada em 14/03, estornada por inteiro, e cobrada de novo em 20/03.
SELECT is(pg_temp.err(pg_temp.purchase('5013', '2026-03-14', 'a604', 'd010', 3, 'f001')), 'ok', 'compra da ocorrência 3');
SELECT is(pg_temp.err($$
  INSERT INTO card_purchases (id, card_caixa_id, kind, payer_caixa_id, entity_id, category_id, purchased_on, description,
                              amount_cents, refunded_purchase_id)
  VALUES (pg_temp.u('5113'), pg_temp.u('c010'), 'refund', pg_temp.u('c001'), pg_temp.u('e005'), pg_temp.u('ca01'), '2026-03-16',
          'Estorno NETFLIX', 3990, pg_temp.u('5013'));
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES (pg_temp.u('a604'), pg_temp.u('5113'), 1, pg_temp.u('c001'), -3990)$$), 'ok', 'estorno total da compra');
SELECT is(pg_temp.err(pg_temp.purchase('5023', '2026-03-20', 'a604', 'd010', 3, 'f001')), 'ok',
          'a ocorrência estornada por inteiro aceita outra compra');
-- Compra ligada só ao contrato (sem ocorrência).
SELECT is(pg_temp.err(pg_temp.purchase('5099', '2026-02-20', 'a603', NULL, NULL, 'f001', 1500)), 'ok',
          'compra ligada só ao contrato');

-- Total de ocorrências na série de cartão.
INSERT INTO recurrence_rules (id, caixa_id, frequency, anchor_day, starts_on, installments_total) VALUES
  (pg_temp.u('d011'), pg_temp.u('c010'), 'monthly', 5, '2026-01-05', 3);
SELECT is(pg_temp.err(pg_temp.charge('d011')), 'ok', 'cobrança em 3 vezes, sem contrato');
SELECT is(pg_temp.err(pg_temp.purchase('5104', '2026-02-05', 'a603', 'd011', 4, NULL)), '23514 card_purchases_occurrence_total_check',
          'ocorrência até N');
SELECT is(pg_temp.err(pg_temp.purchase('5103', '2026-02-05', 'a603', 'd011', 3, NULL)), 'ok', 'ocorrência 3 de 3');
SELECT is(pg_temp.err($$UPDATE recurrence_rules SET installments_total = 2 WHERE id = pg_temp.u('d011')$$),
          '23514 titles_occurrence_total_check', 'reduzir N abaixo de uma compra ligada');

-- Linha da fatura que criou a compra sem confirmação (auto_settle da série).
INSERT INTO attachments (id, file_name, mime_type, content) VALUES (pg_temp.u('f0a1'), 'fatura.csv', 'text/csv', '\x61');
INSERT INTO statement_imports (id, card_caixa_id, card_invoice_id, format, attachment_id, period_start, period_end) VALUES
  (pg_temp.u('5a01'), pg_temp.u('c010'), pg_temp.u('a603'), 'csv', pg_temp.u('f0a1'), '2026-02-04', '2026-03-03');
INSERT INTO statement_lines (id, statement_import_id, card_caixa_id, line_number, posted_on, amount_cents, description, dedup_hash)
VALUES (pg_temp.u('5b01'), pg_temp.u('5a01'), pg_temp.u('c010'), 1, '2026-02-16', -3990, 'NETFLIX.COM', 'h1');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(), card_invoice_item_id = pg_temp.u('6002'),
                                                   created_entry = 'purchase', auto_settled = true
                         WHERE id = pg_temp.u('5b01')$$), 'ok', 'auto_settled com a compra criada pela linha (0052)');

-- contract_payments: obrigações do K1 ---------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT kind, occurrence, status, amount_cents, settled_cents, open_cents, paid_on, days, overdue, not_charged, last_origin,
           card_invoice_id
      FROM contract_payments(pg_temp.u('f001'), '2026-01-01', '2026-05-31', '2026-03-20') WHERE kind = 'card_charge'$$,
  $$VALUES ('card_charge', 1, 'not_charged', 3990::bigint, 0::bigint, 3990::bigint, NULL::date, NULL::int, false, true,
            NULL::text, pg_temp.u('a602')),
           ('card_charge', 2, 'charged', 3990, 3990, 0, date '2026-02-16', 1, false, false, 'auto', pg_temp.u('a603')),
           ('card_charge', NULL, 'charged', 1500, 1500, 0, date '2026-02-20', 0, false, false, 'manual', pg_temp.u('a603')),
           ('card_charge', 3, 'charged', 3990, 3990, 0, date '2026-03-20', 5, false, false, 'manual', pg_temp.u('a604')),
           ('card_charge', 4, 'expected', 4490, 0, 4490, NULL::date, NULL::int, false, false, NULL::text, pg_temp.u('a605')),
           ('card_charge', 5, 'expected', 4490, 0, 4490, NULL::date, NULL::int, false, false, NULL::text, pg_temp.u('a606'))$$,
  'cartão: não cobrada (fatura fechou sem compra), cobrada (com a linha automática), estornada e cobrada de novo, '
  'compra só do contrato, esperadas com o reajuste');
SELECT results_eq(
  $$SELECT kind, occurrence, title_id, status, planned_account_id, overdue
      FROM contract_payments(pg_temp.u('f001'), '2026-01-01', '2026-05-31', '2026-03-20') WHERE kind = 'title'$$,
  $$VALUES ('title', 1, pg_temp.u('1101'), 'open', pg_temp.u('a002'), true),
           ('title', 2, pg_temp.u('1102'), 'open', pg_temp.u('a002'), true),
           ('title', 3, pg_temp.u('1103'), 'open', pg_temp.u('a002'), true),
           ('title', NULL, pg_temp.u('1199'), 'open', NULL::uuid, false)$$,
  'títulos: as ocorrências da série e o avulso ligado, com a conta prevista');
SELECT is((SELECT settlements -> 0 ->> 'card_purchase_id'
             FROM contract_payments(pg_temp.u('f001'), '2026-03-01', '2026-03-31', '2026-03-20') WHERE occurrence = 3
              AND kind = 'card_charge'), pg_temp.u('5023')::text, 'a compra que atende a ocorrência é a não estornada');
SELECT is((SELECT count(*)::int FROM contract_payments(pg_temp.u('f001'), NULL, NULL, '2026-03-20') WHERE kind = 'card_charge'
              AND occurrence IS NOT NULL), 12, 'sem p_to: as ocorrências esperadas até o fim da série (dentro de hoje + 12 meses)');
SELECT is((SELECT count(*)::int FROM contract_payments(pg_temp.u('f002'))), 1, 'K2: o lado do contrato, sem o espelho');
SET LOCAL ROLE moneyflow_app;
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-00000052f001', '2026-01-01', '2026-05-31',
                                                       '2026-03-20')), 10, 'a aplicação lê com o papel dela');
RESET ROLE;

-- Notificação e auditoria ---------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES (pg_temp.u('0a01'), 'dba52', 'dba52@example.com', 'x', 'admin');
SELECT lives_ok($$INSERT INTO notifications (user_id, kind, title, dedup_key)
                  VALUES (pg_temp.u('0a01'), 'contract_charge_missing', 'Assinatura não cobrada em fevereiro',
                          'contract_charge_missing:' || pg_temp.u('d010') || ':1')$$, 'sino aceita "não cobrada"');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'card_recurring_charges' AND record_id = pg_temp.u('d010')),
          'a cobrança entra no histórico da série');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'card_recurring_charge_amounts' AND record_id = pg_temp.u('d010')),
          'o degrau também');

SELECT * FROM finish();
ROLLBACK;
