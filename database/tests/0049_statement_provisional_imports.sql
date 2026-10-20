-- Testes de 0049_statement_provisional_imports: lote provisório, a troca pelo consolidado (spec 031), a dedup só entre
-- lotes não provisórios, os desfechos das linhas, a sugestão da IA, o fechamento de mês e a finalidade supersede_pairs.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- 'ok' ou 'SQLSTATE constraint' do erro (a mudança volta no erro).
CREATE FUNCTION pg_temp.err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
-- O mesmo, com as checagens do COMMIT logo depois do comando.
CREATE FUNCTION pg_temp.err_commit(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura -------------------------------------------------------------------------------------------------------------
SELECT has_column('statement_imports', c) FROM unnest(ARRAY['provisional', 'superseded_by_import_id', 'superseded_at']) c;
SELECT col_type_is('statement_imports', 'provisional', 'boolean');
SELECT col_not_null('statement_imports', 'provisional');
SELECT col_default_is('statement_imports', 'provisional', 'false');
SELECT fk_ok('statement_imports', 'superseded_by_import_id', 'statement_imports', 'id');
SELECT has_column('statement_lines', c)
  FROM unnest(ARRAY['provisional', 'superseded_by_line_id', 'supersede_outcome', 'supersede_suggested_line_id',
                    'supersede_suggestion_reason']) c;
SELECT col_not_null('statement_lines', 'provisional');
SELECT col_default_is('statement_lines', 'provisional', 'false');
SELECT fk_ok('statement_lines', 'superseded_by_line_id', 'statement_lines', 'id');
SELECT fk_ok('statement_lines', 'supersede_suggested_line_id', 'statement_lines', 'id');
SELECT has_index('statement_imports', i)
  FROM unnest(ARRAY['statement_imports_superseded_by_import_id_idx', 'statement_imports_provisional_active_idx']) i;
SELECT has_index('statement_lines', i)
  FROM unnest(ARRAY['statement_lines_superseded_by_line_id_idx', 'statement_lines_supersede_suggested_line_id_idx',
                    'statement_lines_supersede_pending_idx']) i;
SELECT ok(indexdef ~ 'UNIQUE' AND indexdef ~ 'NOT provisional', 'dedup por conta só entre linhas não provisórias')
  FROM pg_indexes WHERE indexname = 'statement_lines_account_dedup_key';
SELECT ok(indexdef !~ 'provisional', 'dedup do cartão continua sobre todas as linhas')
  FROM pg_indexes WHERE indexname = 'statement_lines_card_dedup_key';
SELECT ok(tgdeferrable AND tginitdeferred, 'sobreposição e desfechos conferidos no COMMIT')
  FROM pg_trigger WHERE tgname = 'statement_imports_supersede_commit_check';
SELECT ok(has_column_privilege('moneyflow_app', t, c, p), format('app: %s em %s.%s', p, t, c))
  FROM (VALUES ('statement_imports', 'provisional'), ('statement_imports', 'superseded_by_import_id'),
               ('statement_imports', 'superseded_at'), ('statement_lines', 'provisional'),
               ('statement_lines', 'superseded_by_line_id'), ('statement_lines', 'supersede_outcome'),
               ('statement_lines', 'supersede_suggested_line_id'), ('statement_lines', 'supersede_suggestion_reason')) v (t, c),
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;
SELECT is((SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
            WHERE attrelid = 'statement_import_balances'::regclass AND attnum > 0),
          ARRAY['statement_import_id', 'financial_account_id', 'card_caixa_id', 'period_start', 'period_end',
                'bank_balance_on', 'bank_balance_cents', 'app_balance_cents', 'difference_cents', 'lines', 'matched_lines',
                'suggested_lines', 'new_lines', 'ignored_lines', 'provisional', 'superseded'],
          'statement_import_balances: provisional e superseded no fim');
SELECT ok(pg_get_constraintdef(oid) ~ 'supersede_pairs', conname || ' aceita supersede_pairs')
  FROM pg_constraint
 WHERE conname IN ('ai_conversations_purpose_check', 'ai_usage_purpose_check', 'ai_requests_purpose_check');
SELECT is(ai_usage_is_flow(u, c), true, format('is_flow(%s, %s)', u, c))
  FROM (VALUES ('supersede_pairs', NULL), ('chat', 'supersede_pairs')) AS v (u, c);

-- Dados base ------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000490e1', 'person', 'Titular 49'),
  ('00000000-0000-7000-8000-0000000490e2', 'company', 'Fornecedor 49'),
  ('00000000-0000-7000-8000-0000000490e3', 'company', 'Banco Cartão 49');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000490c1', 'Casa 49', 'general', '00000000-0000-7000-8000-0000000490e1', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000490c2', 'Cartão 49', 'credit_card', '00000000-0000-7000-8000-0000000490e3',
   '00000000-0000-7000-8000-0000000490c1', 500000, 3, 10, '4949');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000490a1', '00000000-0000-7000-8000-0000000490c1', 'checking', 'Corrente 49', '2026-01-01', 100000),
  ('00000000-0000-7000-8000-0000000490a2', '00000000-0000-7000-8000-0000000490c1', 'savings', 'Poupança 49', '2026-01-01', 0);
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-00000049a701', 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-00000049f001', '00000000-0000-7000-8000-0000000490a1', '2026-10-05', -1000, 'adjustment', 'Tarifa'),
  ('00000000-0000-7000-8000-00000049f002', '00000000-0000-7000-8000-0000000490a1', '2026-10-06', -2000, 'adjustment', 'Padaria'),
  ('00000000-0000-7000-8000-00000049f003', '00000000-0000-7000-8000-0000000490a1', '2026-10-07', -3000, 'adjustment', 'Mercado'),
  ('00000000-0000-7000-8000-00000049f004', '00000000-0000-7000-8000-0000000490a1', '2026-10-10', -4000, 'adjustment', 'Farmácia');

-- P1 (ac01): provisório da corrente, 1–15/10. K (ac02): consolidado da corrente, outubro. N2 (ac03): poupança, outubro.
-- CARD (ac04) e CARD2 (ac07): faturas do cartão. PA2 (ac05): provisório da poupança, 1–10/10. M (ac06): poupança, setembro.
INSERT INTO statement_imports (id, financial_account_id, card_caixa_id, format, attachment_id, period_start, period_end, provisional) VALUES
  ('00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1', NULL, 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-10-01', '2026-10-15', true),
  ('00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1', NULL, 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-10-01', '2026-10-31', false),
  ('00000000-0000-7000-8000-00000049ac03', '00000000-0000-7000-8000-0000000490a2', NULL, 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-10-01', '2026-10-31', false),
  ('00000000-0000-7000-8000-00000049ac04', NULL, '00000000-0000-7000-8000-0000000490c2', 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-09-04', '2026-10-03', false),
  ('00000000-0000-7000-8000-00000049ac05', '00000000-0000-7000-8000-0000000490a2', NULL, 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-10-01', '2026-10-10', true),
  ('00000000-0000-7000-8000-00000049ac06', '00000000-0000-7000-8000-0000000490a2', NULL, 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-09-01', '2026-09-30', false),
  ('00000000-0000-7000-8000-00000049ac07', NULL, '00000000-0000-7000-8000-0000000490c2', 'ofx',
   '00000000-0000-7000-8000-00000049a701', '2026-10-04', '2026-11-03', false);

-- Linhas do provisório: a aplicação não informa provisional (aqui, false de propósito: o banco copia o do lote).
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at, created_entry, provisional) VALUES
  ('00000000-0000-7000-8000-00000049ad01', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   1, '2026-10-05', -1000, 'TARIFA', 'h1', 'matched', '00000000-0000-7000-8000-00000049f001', now(), 'adjustment', false),
  ('00000000-0000-7000-8000-00000049ad02', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   2, '2026-10-06', -2000, 'PADARIA', 'h2', 'matched', '00000000-0000-7000-8000-00000049f002', now(), NULL, false),
  ('00000000-0000-7000-8000-00000049ad03', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   3, '2026-10-07', -3000, 'MERCADO', 'h3', 'matched', '00000000-0000-7000-8000-00000049f003', now(), 'adjustment', false),
  ('00000000-0000-7000-8000-00000049ad06', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   6, '2026-10-10', -4000, 'FARMACIA', 'h6', 'matched', '00000000-0000-7000-8000-00000049f004', now(), NULL, false);
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status) VALUES
  ('00000000-0000-7000-8000-00000049ad04', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   4, '2026-10-08', -500, 'CAFE', 'h4', 'new'),
  ('00000000-0000-7000-8000-00000049ad05', '00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1',
   5, '2026-10-09', -700, 'ESTORNO?', 'h5', 'ignored');

SELECT is((SELECT bool_and(provisional) FROM statement_lines WHERE statement_import_id = '00000000-0000-7000-8000-00000049ac01'),
          true, 'linha de lote provisório nasce provisória (cópia do lote, mesmo informando false)');

-- Consolidado: as mesmas transações (h1, h4) convivem com as do provisório.
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                               dedup_hash, provisional) VALUES
    ('00000000-0000-7000-8000-00000049ad11', '00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1',
     1, '2026-10-05', -1000, 'TARIFA BANCARIA', 'h1', true),
    ('00000000-0000-7000-8000-00000049ad12', '00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1',
     2, '2026-10-08', -2000, 'PADARIA CENTRAL', 'hk2', true),
    ('00000000-0000-7000-8000-00000049ad14', '00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1',
     4, '2026-10-08', -500, 'CAFE', 'h4', true),
    ('00000000-0000-7000-8000-00000049ad16', '00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1',
     6, '2026-10-20', -9999, 'ALUGUEL', 'hk6', true)
$$), 'ok', 'consolidado entra com os mesmos hashes do provisório');
SELECT is((SELECT bool_or(provisional) FROM statement_lines WHERE statement_import_id = '00000000-0000-7000-8000-00000049ac02'),
          false, 'linha de lote não provisório nasce não provisória');
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
  VALUES ('00000000-0000-7000-8000-00000049ac03', '00000000-0000-7000-8000-0000000490a2', 9, '2026-10-05', -1000, 'X', 'hn2')
$$), 'ok', 'outro hash, outro lote');
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
  VALUES ('00000000-0000-7000-8000-00000049ac02', '00000000-0000-7000-8000-0000000490a1', 9, '2026-10-05', -1000, 'TARIFA', 'h1')
$$), '23505 statement_lines_account_dedup_key', 'dois lotes não provisórios não repetem o hash');

INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash) VALUES
  ('00000000-0000-7000-8000-00000049ad21', '00000000-0000-7000-8000-00000049ac03', '00000000-0000-7000-8000-0000000490a2',
   1, '2026-10-06', -2000, 'TRANSF', 'hn1'),
  ('00000000-0000-7000-8000-00000049ad31', '00000000-0000-7000-8000-00000049ac05', '00000000-0000-7000-8000-0000000490a2',
   1, '2026-10-03', -150, 'TARIFA', 'hp1'),
  ('00000000-0000-7000-8000-00000049ad41', '00000000-0000-7000-8000-00000049ac06', '00000000-0000-7000-8000-0000000490a2',
   1, '2026-09-10', -100, 'A', 'hm1'),
  ('00000000-0000-7000-8000-00000049ad42', '00000000-0000-7000-8000-00000049ac06', '00000000-0000-7000-8000-0000000490a2',
   2, '2026-09-11', -200, 'B', 'hm2');
SELECT lives_ok('SELECT pg_temp.commit_check()', 'provisórios de contas diferentes convivem no COMMIT');

-- Provisório: só conta -----------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$
  INSERT INTO statement_imports (card_caixa_id, format, attachment_id, period_start, period_end, provisional)
  VALUES ('00000000-0000-7000-8000-0000000490c2', 'ofx', '00000000-0000-7000-8000-00000049a701', '2026-11-04', '2026-12-03', true)
$$), '23514 statement_imports_provisional_check', 'fatura de cartão não é provisória (INSERT)');
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac04'$$),
          '23514 statement_imports_provisional_check', 'fatura de cartão não vira provisória');
SELECT is(pg_temp.err($$UPDATE statement_lines SET provisional = false WHERE id = '00000000-0000-7000-8000-00000049ad01'$$),
          '23514 statement_lines_provisional_check', 'a marca da linha acompanha o lote');

-- Sobreposição no COMMIT ---------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err_commit($$
  INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end, provisional)
  VALUES ('00000000-0000-7000-8000-0000000490a1', 'ofx', '00000000-0000-7000-8000-00000049a701', '2026-10-10', '2026-10-20', true)
$$), '23514 statement_imports_provisional_overlap_check', 'dois provisórios ativos da conta não se sobrepõem');
SELECT is(pg_temp.err_commit($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac02'$$),
          '23514 statement_imports_provisional_overlap_check', 'marcar um lote sobreposto a um provisório ativo');
SELECT is(pg_temp.err_commit($$UPDATE statement_imports SET period_end = '2026-10-20' WHERE id = '00000000-0000-7000-8000-00000049ac05'$$),
          'ok', 'provisório sem outro provisório na conta muda o período');

-- Marcar e desmarcar --------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err_commit($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac06'$$),
          'ok', 'marcar como provisório');
SELECT is((SELECT array_agg(provisional ORDER BY line_number) FROM statement_lines
            WHERE statement_import_id = '00000000-0000-7000-8000-00000049ac06'), ARRAY[true, true], 'as linhas viram provisórias');
SELECT is(pg_temp.err_commit($$UPDATE statement_imports SET provisional = false WHERE id = '00000000-0000-7000-8000-00000049ac06'$$),
          'ok', 'desmarcar');
SELECT is((SELECT array_agg(provisional ORDER BY line_number) FROM statement_lines
            WHERE statement_import_id = '00000000-0000-7000-8000-00000049ac06'), ARRAY[false, false], 'as linhas voltam');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'statement_imports' AND action = 'update'
              AND record_id = '00000000-0000-7000-8000-00000049ac06' AND 'provisional' = ANY (changed_columns)),
          2, 'a marca e a desmarca ficam na auditoria do lote');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'statement_lines' AND action = 'update'
              AND record_id IN ('00000000-0000-7000-8000-00000049ad41', '00000000-0000-7000-8000-00000049ad42')),
          0, 'a cópia da marca nas linhas não gera auditoria');
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = false WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23505 statement_lines_account_dedup_key', 'desmarcar um provisório que repete linhas do consolidado');

-- Substituição recusada -----------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac07',
                         superseded_at = now() WHERE id = '00000000-0000-7000-8000-00000049ac04'$$),
          '23514 statement_imports_superseded_check', 'fatura de cartão não é substituída');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac03',
                         superseded_at = now() WHERE id = '00000000-0000-7000-8000-00000049ac06'$$),
          '23514 statement_imports_superseded_check', 'lote não provisório não é substituído');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = id, superseded_at = now()
                         WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_check', 'um lote não substitui a si mesmo');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_at = now() WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_check', 'superseded_at só junto com o substituto');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac03',
                         superseded_at = now() WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_by_check', 'o substituto é da mesma conta');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'dropped'
                         WHERE id = '00000000-0000-7000-8000-00000049ad05'$$),
          '23514 statement_lines_supersede_import_check', 'desfecho só em lote substituído');

-- A troca de P1 por K -------------------------------------------------------------------------------------------------------
UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac02', superseded_at = now()
 WHERE id = '00000000-0000-7000-8000-00000049ac01';
SELECT is(pg_temp.err('SET CONSTRAINTS ALL IMMEDIATE'), '23514 statement_imports_superseded_lines_check',
          'no COMMIT, toda linha do substituído tem desfecho');

SELECT is(pg_temp.err($$UPDATE statement_lines SET entity_id = '00000000-0000-7000-8000-0000000490e2'
                         WHERE id = '00000000-0000-7000-8000-00000049ad04'$$),
          '23514 statement_lines_superseded_immutable_check', 'linha do substituído não muda a classificação');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'ignored' WHERE id = '00000000-0000-7000-8000-00000049ad04'$$),
          '23514 statement_lines_superseded_immutable_check', 'linha do substituído não muda o estado fora do desfecho');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred',
                         superseded_by_line_id = '00000000-0000-7000-8000-00000049ad16' WHERE id = '00000000-0000-7000-8000-00000049ad05'$$),
          '23514 statement_lines_supersede_transition_check', 'ignorada não é transferida');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'dropped', movement_id = NULL,
                         matched_at = NULL, created_entry = NULL WHERE id = '00000000-0000-7000-8000-00000049ad01'$$),
          '23514 statement_lines_supersede_transition_check', 'conciliada não é descartada');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'kept', movement_id = NULL,
                         matched_at = NULL WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_transition_check', 'kept só sai de pending');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_outcome = 'pending', movement_id = NULL, matched_at = NULL,
                         status = 'new' WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_transition_check', 'pending continua conciliada como estava');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred', movement_id = NULL,
                         matched_at = NULL, created_entry = NULL WHERE id = '00000000-0000-7000-8000-00000049ad01'$$),
          '23514 statement_lines_supersede_outcome_check', 'transferred exige a linha do consolidado');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred', movement_id = NULL,
                         matched_at = NULL, created_entry = NULL, superseded_by_line_id = '00000000-0000-7000-8000-00000049ad21'
                         WHERE id = '00000000-0000-7000-8000-00000049ad01'$$),
          '23514 statement_lines_superseded_by_line_check', 'a linha que fica no lugar é do lote substituto');

SELECT lives_ok($$
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred', movement_id = NULL, matched_at = NULL,
         created_entry = NULL, superseded_by_line_id = '00000000-0000-7000-8000-00000049ad11'
   WHERE id = '00000000-0000-7000-8000-00000049ad01';
  UPDATE statement_lines SET supersede_outcome = 'pending'
   WHERE id IN ('00000000-0000-7000-8000-00000049ad02', '00000000-0000-7000-8000-00000049ad03',
                '00000000-0000-7000-8000-00000049ad06');
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'paired',
         superseded_by_line_id = '00000000-0000-7000-8000-00000049ad14'
   WHERE id = '00000000-0000-7000-8000-00000049ad04';
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'dropped'
   WHERE id = '00000000-0000-7000-8000-00000049ad05';
  UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-00000049f001', matched_at = now(),
         created_entry = 'adjustment'
   WHERE id = '00000000-0000-7000-8000-00000049ad11';
  SELECT pg_temp.commit_check();
$$, 'a troca: lote substituído, desfechos e a conciliação transferida para o consolidado');
SELECT results_eq($$SELECT provisional, superseded FROM statement_import_balances
                     WHERE statement_import_id IN ('00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-00000049ac02')
                     ORDER BY statement_import_id$$,
                  $$VALUES (true, true), (false, false)$$, 'statement_import_balances: provisional e superseded');

-- O substituído é final ------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = false WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_immutable_check', 'substituído não deixa de ser provisório');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = NULL, superseded_at = NULL
                         WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_immutable_check', 'sem desfazer a troca');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_at = now() - interval '1 day'
                         WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_immutable_check', 'o instante da troca não muda');
SELECT is(pg_temp.err($$UPDATE statement_imports SET notes = 'conferido' WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          'ok', 'as notas do substituído continuam editáveis');
SELECT is(pg_temp.err($$DELETE FROM statement_imports WHERE id = '00000000-0000-7000-8000-00000049ac01'$$),
          '23514 statement_imports_superseded_immutable_check', 'substituído não é excluído');
SELECT is(left(pg_temp.err($$DELETE FROM statement_imports WHERE id = '00000000-0000-7000-8000-00000049ac02'$$), 5),
          '23503', 'o lote que substituiu outro não é excluído');
SELECT is(pg_temp.err($$DELETE FROM statement_lines WHERE id = '00000000-0000-7000-8000-00000049ad05'$$),
          '23514 statement_lines_superseded_immutable_check', 'linha do substituído não é excluída');
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac02'$$),
          '23514 statement_imports_provisional_supersedes_check', 'lote que substituiu outro não vira provisório');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_outcome = 'paired', superseded_by_line_id = '00000000-0000-7000-8000-00000049ad16'
                         WHERE id = '00000000-0000-7000-8000-00000049ad05'$$),
          '23514 statement_lines_supersede_transition_check', 'dropped é final');
SELECT is(pg_temp.err($$UPDATE statement_lines SET superseded_by_line_id = '00000000-0000-7000-8000-00000049ad16'
                         WHERE id = '00000000-0000-7000-8000-00000049ad04'$$),
          '23514 statement_lines_superseded_immutable_check', 'o vínculo com a linha do consolidado é final');
SELECT is(pg_temp.err($$UPDATE statement_lines SET description = 'CAFE DA MANHA' WHERE id = '00000000-0000-7000-8000-00000049ad04'$$),
          'ok', 'a descrição continua editável');
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
  VALUES ('00000000-0000-7000-8000-00000049ac01', '00000000-0000-7000-8000-0000000490a1', 20, '2026-10-11', -10, 'NOVA', 'h20')
$$), '23514 statement_imports_superseded_lines_check', 'linha nova em lote substituído só com o desfecho');

-- Pendências e a sugestão da IA -------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggested_line_id = '00000000-0000-7000-8000-00000049ad11'
                         WHERE id = '00000000-0000-7000-8000-00000049ad12'$$),
          '23514 statement_lines_supersede_suggestion_check', 'sugestão só em linha pending');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggestion_reason = 'motivo'
                         WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_suggestion_check', 'motivo só com a linha sugerida');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggested_line_id = '00000000-0000-7000-8000-00000049ad12',
                         supersede_suggestion_reason = repeat('x', 501) WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_suggestion_check', 'motivo até 500 caracteres');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggested_line_id = '00000000-0000-7000-8000-00000049ad12'
                         WHERE id = '00000000-0000-7000-8000-00000049ad03'$$),
          '23514 statement_lines_supersede_suggestion_target_check', 'sugestão com o mesmo valor');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggested_line_id = '00000000-0000-7000-8000-00000049ad21'
                         WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_suggestion_target_check', 'sugestão do lote substituto');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_suggested_line_id = '00000000-0000-7000-8000-00000049ad12',
                         supersede_suggestion_reason = 'Mesmo valor, dois dias depois' WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          'ok', 'a IA sugere o par');
SELECT is(pg_temp.err($$UPDATE statement_lines SET matched_at = now() - interval '1 hour'
                         WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_superseded_immutable_check', 'pending não muda fora da sugestão e da saída');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_outcome = NULL WHERE id = '00000000-0000-7000-8000-00000049ad06'$$),
          '23514 statement_lines_supersede_transition_check', 'pending não volta a nulo');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'paired', movement_id = NULL,
                         matched_at = NULL, superseded_by_line_id = '00000000-0000-7000-8000-00000049ad16'
                         WHERE id = '00000000-0000-7000-8000-00000049ad06'$$),
          '23514 statement_lines_supersede_transition_check', 'pending não vira paired');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'entry_deleted', movement_id = NULL,
                         matched_at = NULL WHERE id = '00000000-0000-7000-8000-00000049ad06'$$),
          '23514 statement_lines_supersede_transition_check', 'entry_deleted só com o lançamento criado pela linha');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred', movement_id = NULL,
                         matched_at = NULL, superseded_by_line_id = '00000000-0000-7000-8000-00000049ad12'
                         WHERE id = '00000000-0000-7000-8000-00000049ad02'$$),
          '23514 statement_lines_supersede_suggestion_check', 'a sugestão sai junto com o pending');

-- Fechamento de mês: recusado com linha pending ou provisório ativo no mês.
SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000490c1', '2026-10-01')$$),
          '23514 period_closings_provisional_check', 'mês com linha pending não fecha');

SELECT lives_ok($$
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'transferred', movement_id = NULL, matched_at = NULL,
         superseded_by_line_id = '00000000-0000-7000-8000-00000049ad12', supersede_suggested_line_id = NULL,
         supersede_suggestion_reason = NULL
   WHERE id = '00000000-0000-7000-8000-00000049ad02';
  UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-00000049f002', matched_at = now()
   WHERE id = '00000000-0000-7000-8000-00000049ad12';
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'kept', movement_id = NULL, matched_at = NULL
   WHERE id = '00000000-0000-7000-8000-00000049ad06';
  UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'entry_deleted', movement_id = NULL, matched_at = NULL,
         created_entry = NULL
   WHERE id = '00000000-0000-7000-8000-00000049ad03';
  DELETE FROM movements WHERE id = '00000000-0000-7000-8000-00000049f003';
  SELECT pg_temp.commit_check();
$$, 'pending sai para transferred (casar), kept (manter) e entry_deleted (excluir o lançamento)');
SELECT is(pg_temp.err($$UPDATE statement_lines SET supersede_outcome = 'transferred',
                         superseded_by_line_id = '00000000-0000-7000-8000-00000049ad16'
                         WHERE id = '00000000-0000-7000-8000-00000049ad06'$$),
          '23514 statement_lines_supersede_transition_check', 'kept é final');
SELECT results_eq($$SELECT supersede_outcome, status FROM statement_lines
                     WHERE statement_import_id = '00000000-0000-7000-8000-00000049ac01' ORDER BY line_number$$,
                  $$VALUES ('transferred', 'superseded'), ('transferred', 'superseded'), ('entry_deleted', 'superseded'),
                           ('paired', 'superseded'), ('dropped', 'superseded'), ('kept', 'superseded')$$,
                  'desfechos finais do provisório');

SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000490c1', '2026-10-01')$$),
          '23514 period_closings_provisional_check', 'mês com provisório ativo (outra conta da caixa) não fecha');
DELETE FROM statement_imports WHERE id = '00000000-0000-7000-8000-00000049ac05';
SELECT is(pg_temp.err($$INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000490c1', '2026-10-01')$$),
          'ok', 'sem provisório ativo nem pending, o mês fecha (o substituído não impede)');

-- Provisório em mês fechado.
INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000490c1', '2026-09-01');
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac06'$$),
          '23514 statement_lines_provisional_closed_check', 'lote com linha em mês fechado não vira provisório');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, provisional) VALUES
  ('00000000-0000-7000-8000-00000049ac0a', '00000000-0000-7000-8000-0000000490a1', 'ofx', '00000000-0000-7000-8000-00000049a701',
   '2026-09-01', '2026-09-30', true);
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
  VALUES ('00000000-0000-7000-8000-00000049ac0a', '00000000-0000-7000-8000-0000000490a1', 1, '2026-09-15', -10, 'X', 'h9')
$$), '23514 statement_lines_provisional_closed_check', 'linha de provisório não entra em mês fechado');
SELECT is(pg_temp.err($$
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
  VALUES ('00000000-0000-7000-8000-00000049ac06', '00000000-0000-7000-8000-0000000490a2', 3, '2026-09-15', -10, 'X', 'hm3')
$$), 'ok', 'lote não provisório segue a regra de sempre (sem trava de período nas linhas)');

-- Parcial mais novo substitui o anterior na mesma transação; o substituto não pode estar substituído --------------------------
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, provisional) VALUES
  ('00000000-0000-7000-8000-00000049ac08', '00000000-0000-7000-8000-0000000490a1', 'ofx', '00000000-0000-7000-8000-00000049a701',
   '2026-11-01', '2026-11-10', true);
SELECT lives_ok('SELECT pg_temp.commit_check()', 'provisório de novembro');
SELECT is(pg_temp.err($$UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac01',
                         superseded_at = now() WHERE id = '00000000-0000-7000-8000-00000049ac08'$$),
          '23514 statement_imports_superseded_by_check', 'o substituto não está substituído');
SELECT lives_ok($$
  INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, provisional) VALUES
    ('00000000-0000-7000-8000-00000049ac09', '00000000-0000-7000-8000-0000000490a1', 'ofx', '00000000-0000-7000-8000-00000049a701',
     '2026-11-01', '2026-11-20', true);
  UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000049ac09', superseded_at = now()
   WHERE id = '00000000-0000-7000-8000-00000049ac08';
  SELECT pg_temp.commit_check();
$$, 'o parcial mais novo (provisório) substitui o anterior sobreposto na mesma transação');
SELECT is(pg_temp.err_commit($$UPDATE statement_imports SET provisional = false WHERE id = '00000000-0000-7000-8000-00000049ac09'$$),
          'ok', 'o provisório que substituiu outro pode ser desmarcado');
SELECT is(pg_temp.err($$UPDATE statement_imports SET provisional = true WHERE id = '00000000-0000-7000-8000-00000049ac09'$$),
          '23514 statement_imports_provisional_supersedes_check', 'e não volta a ser provisório');

-- Restauração (backup): o substituído entra pronto, com a cadeia e os desfechos.
SELECT lives_ok($$
  INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, provisional,
                                 superseded_by_import_id, superseded_at) VALUES
    ('00000000-0000-7000-8000-00000049ac0b', '00000000-0000-7000-8000-0000000490a1', 'ofx', '00000000-0000-7000-8000-00000049a701',
     '2026-10-01', '2026-10-05', true, '00000000-0000-7000-8000-00000049ac01', now());
  INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                               dedup_hash, status, supersede_outcome, superseded_by_line_id) VALUES
    ('00000000-0000-7000-8000-00000049ac0b', '00000000-0000-7000-8000-0000000490a1', 1, '2026-10-05', -1000, 'TARIFA', 'h1',
     'superseded', 'paired', '00000000-0000-7000-8000-00000049ad01'),
    ('00000000-0000-7000-8000-00000049ac0b', '00000000-0000-7000-8000-0000000490a1', 2, '2026-10-02', -5, 'IOF', 'h2b',
     'superseded', 'dropped', NULL);
  SELECT pg_temp.commit_check();
$$, 'lote já substituído entra com as linhas e os desfechos (o substituto pode já estar substituído)');

SELECT * FROM finish();
ROLLBACK;
