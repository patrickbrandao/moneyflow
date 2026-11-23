-- Testes de 0064_settlement_reversal_date (tarefa 045): as pernas da baixa com o movimento de estorno e a troca da data
-- do estorno nas duas pernas, com as regras (estornada, não antes da baixa, mês fechado, linha conciliada) e a auditoria.
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
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000064' || p)::uuid $$;
CREATE FUNCTION pg_temp.reversal_date(p_settlement text) RETURNS date
LANGUAGE sql AS $$ SELECT occurred_on FROM settlement_reversal_movements(pg_temp.u(p_settlement)) WHERE settlement_id = pg_temp.u(p_settlement) $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('settlement_reversal_movements', ARRAY['uuid']);
SELECT has_function('settlement_reversal_set_date', ARRAY['uuid', 'date']);
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['settlement_reversal_movements(uuid)', 'settlement_reversal_set_date(uuid, date)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['settlement_reversal_movements(uuid)', 'settlement_reversal_set_date(uuid, date)']) f;
SELECT ok(NOT prosecdef, 'SECURITY INVOKER: ' || proname) FROM pg_proc
 WHERE proname IN ('settlement_reversal_movements', 'settlement_reversal_set_date');

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  (pg_temp.u('0a01'), 'editor64', 'editor64@example.com', 'segredo-123', 'user');
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Empresa'), (pg_temp.u('e005'), 'company', 'Energia');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true),
  (pg_temp.u('c002'), 'Empresa', 'general', pg_temp.u('e002'), true);
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  (pg_temp.u('a001'), pg_temp.u('c001'), 'checking', 'Corrente Casa', '2026-01-01'),
  (pg_temp.u('b001'), pg_temp.u('c002'), 'checking', 'Corrente Empresa', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES (pg_temp.u('ca01'), 'expense', 'Despesa 64'), (pg_temp.u('ca02'), 'income', 'Receita 64');
-- T1 avulso pago em 05/10 e estornado com data de hoje (20/11); T2/T3 par espelhado baixado em 10/10 e estornado em 21/11;
-- T4 com baixa ativa; T5 estornado com o movimento de estorno conciliado; T6 baixa sem conta, estornada.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  (pg_temp.u('7001'), pg_temp.u('c001'), 'payable', pg_temp.u('e005'), pg_temp.u('ca01'), 'T1', '2026-10-01', '2026-10-05', 1000),
  (pg_temp.u('7004'), pg_temp.u('c001'), 'payable', pg_temp.u('e005'), pg_temp.u('ca01'), 'T4', '2026-10-01', '2026-10-05', 1000),
  (pg_temp.u('7005'), pg_temp.u('c001'), 'payable', pg_temp.u('e005'), pg_temp.u('ca01'), 'T5', '2026-10-01', '2026-10-05', 1000),
  (pg_temp.u('7006'), pg_temp.u('c001'), 'payable', pg_temp.u('e005'), pg_temp.u('ca01'), 'T6', '2026-10-01', '2026-10-05', 1000);
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  (pg_temp.u('7002'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'T2', '2026-10-01', '2026-10-10', 2000,
   pg_temp.u('c002'), pg_temp.u('7003'), NULL),
  (pg_temp.u('7003'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'T2', '2026-10-01', '2026-10-10', 2000,
   pg_temp.u('c001'), pg_temp.u('7002'), 'accepted');
INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, financial_account_id, mirror_settlement_id) VALUES
  (pg_temp.u('d001'), pg_temp.u('7001'), '2026-10-05', 1000, 50, pg_temp.u('a001'), NULL),
  (pg_temp.u('d002'), pg_temp.u('7002'), '2026-10-10', 2000, 0, pg_temp.u('a001'), pg_temp.u('d003')),
  (pg_temp.u('d003'), pg_temp.u('7003'), '2026-10-10', 2000, 0, pg_temp.u('b001'), pg_temp.u('d002')),
  (pg_temp.u('d004'), pg_temp.u('7004'), '2026-10-05', 1000, 0, pg_temp.u('a001'), NULL),
  (pg_temp.u('d005'), pg_temp.u('7005'), '2026-10-05', 1000, 0, pg_temp.u('a001'), NULL),
  (pg_temp.u('d006'), pg_temp.u('7006'), '2026-10-05', 1000, 0, NULL, NULL);
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  (pg_temp.u('6001'), pg_temp.u('a001'), '2026-10-05', -1050, 'settlement', pg_temp.u('d001')),
  (pg_temp.u('6002'), pg_temp.u('a001'), '2026-10-10', -2000, 'settlement', pg_temp.u('d002')),
  (pg_temp.u('6003'), pg_temp.u('b001'), '2026-10-10', 2000, 'settlement', pg_temp.u('d003')),
  (pg_temp.u('6004'), pg_temp.u('a001'), '2026-10-05', -1000, 'settlement', pg_temp.u('d004')),
  (pg_temp.u('6005'), pg_temp.u('a001'), '2026-10-05', -1000, 'settlement', pg_temp.u('d005'));
UPDATE settlements SET reversed_at = now(), reversal_reason = 'refazer'
 WHERE id IN (pg_temp.u('d001'), pg_temp.u('d002'), pg_temp.u('d003'), pg_temp.u('d005'), pg_temp.u('d006'));
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  (pg_temp.u('6101'), pg_temp.u('a001'), '2026-11-20', 1050, 'settlement', pg_temp.u('d001')),
  (pg_temp.u('6102'), pg_temp.u('a001'), '2026-11-21', 2000, 'settlement', pg_temp.u('d002')),
  (pg_temp.u('6103'), pg_temp.u('b001'), '2026-11-21', -2000, 'settlement', pg_temp.u('d003')),
  (pg_temp.u('6105'), pg_temp.u('a001'), '2026-11-20', 1000, 'settlement', pg_temp.u('d005'));
INSERT INTO attachments (id, file_name, mime_type, content) VALUES (pg_temp.u('ff01'), 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  (pg_temp.u('ab01'), pg_temp.u('a001'), 'ofx', pg_temp.u('ff01'), '2026-11-01', '2026-11-30');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at) VALUES
  (pg_temp.u('1005'), pg_temp.u('ab01'), pg_temp.u('a001'), 1, '2026-11-20', 1000, 'ESTORNO', 'h1', 'matched', pg_temp.u('6105'), now());
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'baixas, estornos e a linha coerentes no COMMIT');

-- As pernas e o movimento de estorno -----------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT settlement_id, caixa_id, settled_on, movement_id, financial_account_id, occurred_on, amount_cents, statement_line_id
      FROM settlement_reversal_movements(pg_temp.u('d003'))$$,
  $$VALUES (pg_temp.u('d003'), pg_temp.u('c002'), '2026-10-10'::date, pg_temp.u('6103'), pg_temp.u('b001'), '2026-11-21'::date,
            -2000::bigint, NULL::uuid),
           (pg_temp.u('d002'), pg_temp.u('c001'), '2026-10-10'::date, pg_temp.u('6102'), pg_temp.u('a001'), '2026-11-21'::date,
            2000::bigint, NULL::uuid)$$,
  'as duas pernas, a pedida primeiro, com o movimento de estorno (sinal oposto ao da baixa) de cada uma');
SELECT results_eq($$SELECT movement_id, amount_cents FROM settlement_reversal_movements(pg_temp.u('d001'))$$,
                  $$VALUES (pg_temp.u('6101'), 1050::bigint)$$, 'com juros: o estorno é o valor em dinheiro oposto');
SELECT results_eq($$SELECT movement_id, statement_line_id FROM settlement_reversal_movements(pg_temp.u('d005'))$$,
                  $$VALUES (pg_temp.u('6105'), pg_temp.u('1005'))$$, 'a linha conciliada com o estorno');
SELECT results_eq($$SELECT reversed_at IS NULL, movement_id FROM settlement_reversal_movements(pg_temp.u('d004'))$$,
                  $$VALUES (true, NULL::uuid)$$, 'baixa ativa: a perna sem movimento de estorno');
SELECT results_eq($$SELECT caixa_id, movement_id FROM settlement_reversal_movements(pg_temp.u('d006'))$$,
                  $$VALUES (pg_temp.u('c001'), NULL::uuid)$$, 'baixa sem conta: a perna sem movimento');
SELECT is((SELECT count(*)::int FROM settlement_reversal_movements(pg_temp.u('ffff'))), 0, 'baixa inexistente: nenhuma linha');

-- As regras -----------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d004'), '2026-10-05')$$),
          '23514 settlements_reversal_date_check', 'baixa ativa: recusada');
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d002'), '2026-10-09')$$),
          '23514 settlements_reversal_date_check', 'antes da data da baixa: recusada');
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d005'), '2026-10-05')$$),
          '23514 settlements_reversal_reconciled_check', 'estorno conciliado com linha de extrato: recusado');
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('ffff'), '2026-10-05')$$), 'P0002 -',
          'baixa inexistente');
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d001'), NULL)$$), '22023 -', 'data nula');
SELECT is(pg_temp.err($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d006'), '2026-10-05')$$), 'ok',
          'baixa estornada sem conta: nada a mudar, sem erro');

-- Mês fechado: na data antiga (novembro) e na nova (outubro).
SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES (pg_temp.u('c001'), '2026-11-01');
                       SELECT * FROM settlement_reversal_set_date(pg_temp.u('d001'), '2026-10-05')$$),
          '23514 period_closings_locked_check', 'o mês do estorno atual fechado: recusada');
SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES (pg_temp.u('c001'), '2026-10-01');
                       SELECT * FROM settlement_reversal_set_date(pg_temp.u('d001'), '2026-10-05')$$),
          '23514 period_closings_locked_check', 'o mês da data nova fechado: recusada');
SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES (pg_temp.u('c002'), '2026-10-01');
                       SELECT * FROM settlement_reversal_set_date(pg_temp.u('d002'), '2026-10-10')$$),
          '23514 period_closings_locked_check', 'o mês fechado na caixa do espelho também recusa (nenhuma perna muda)');

-- A troca: as duas pernas, com o ator na auditoria ---------------------------------------------------------------------------
SELECT set_config('app.user_id', pg_temp.u('0a01')::text, true);
SELECT results_eq(
  $$SELECT movement_id, settlement_id, financial_account_id, old_date, new_date
      FROM settlement_reversal_set_date(pg_temp.u('d002'), '2026-10-10') ORDER BY movement_id$$,
  $$VALUES (pg_temp.u('6102'), pg_temp.u('d002'), pg_temp.u('a001'), '2026-11-21'::date, '2026-10-10'::date),
           (pg_temp.u('6103'), pg_temp.u('d003'), pg_temp.u('b001'), '2026-11-21'::date, '2026-10-10'::date)$$,
  'a data do estorno muda nas duas pernas (a do espelho inclusive) para a da baixa');
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'as checagens do COMMIT passam com o estorno na data da baixa');
SELECT results_eq($$SELECT occurred_on FROM movements WHERE id IN (pg_temp.u('6002'), pg_temp.u('6003')) ORDER BY id$$,
                  $$VALUES ('2026-10-10'::date), ('2026-10-10'::date)$$, 'os movimentos da baixa não mudam');
SELECT results_eq(
  $$SELECT record_id, user_id, actor_kind, changed_columns @> ARRAY['occurred_on']
      FROM audit_log WHERE table_name = 'movements' AND action = 'update' AND record_id IN (pg_temp.u('6102'), pg_temp.u('6103'))
     ORDER BY record_id$$,
  $$VALUES (pg_temp.u('6102'), pg_temp.u('0a01'), 'human', true), (pg_temp.u('6103'), pg_temp.u('0a01'), 'human', true)$$,
  'auditoria com o ator da transação');
SELECT is((SELECT count(*)::int FROM settlement_reversal_set_date(pg_temp.u('d003'), '2026-10-10')), 0,
          'mesma data: nada muda (pela outra perna)');
SELECT results_eq($$SELECT movement_id, new_date FROM settlement_reversal_set_date(pg_temp.u('d003'), '2026-10-12')$$,
                  $$VALUES (pg_temp.u('6103'), '2026-10-12'::date), (pg_temp.u('6102'), '2026-10-12'::date)$$,
                  'pela perna do espelho: as duas mudam');

SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT * FROM settlement_reversal_set_date(pg_temp.u('d001'), '2026-11-19')$$, 'a aplicação troca a data');
SELECT is(pg_temp.reversal_date('d001'), '2026-11-19'::date, 'estorno de T1 em 19/11');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
