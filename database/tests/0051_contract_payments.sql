-- Testes de 0051_contract_payments (spec 033) no schema atual: o que a 0051 criou e ficou — a conta prevista dos títulos
-- (desde a 0052, da caixa do título e de qualquer tipo, sem a de passagem), a conta referenciada que muda de caixa ou
-- de tipo, created_entry transfer_settlement e auto_settled nas linhas. A conta das parcelas, os encargos do contrato
-- e contract_payments() mudaram na 0052 (tests/0052_contracts_on_series.sql).
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
CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura -------------------------------------------------------------------------------------------------------------
SELECT has_column('titles', c) FROM unnest(ARRAY['planned_account_id', 'planned_account_custom']) c;
SELECT col_not_null('titles', 'planned_account_custom');
SELECT col_default_is('titles', 'planned_account_custom', 'false');
SELECT fk_ok('titles', 'planned_account_id', 'financial_accounts', 'id');
SELECT has_index('titles', i) FROM unnest(ARRAY['titles_planned_account_id_idx', 'titles_planned_account_open_idx']) i;
SELECT ok(indexdef ~ 'status' AND indexdef ~ 'open' AND indexdef ~ 'partial', 'índice da busca só com os títulos em aberto')
  FROM pg_indexes WHERE indexname = 'titles_planned_account_open_idx';

SELECT has_column('statement_lines', 'auto_settled');
SELECT col_not_null('statement_lines', 'auto_settled');
SELECT col_default_is('statement_lines', 'auto_settled', 'false');
SELECT has_trigger('titles', 'titles_validate_planned_account');
SELECT has_trigger('financial_accounts', 'financial_accounts_validate_payment_refs');
SELECT has_trigger('statement_lines', 'statement_lines_validate_created_entry');
SELECT ok(has_column_privilege('moneyflow_app', 'titles', c, 'SELECT, INSERT, UPDATE'), 'app grava titles.' || c)
  FROM unnest(ARRAY['planned_account_id', 'planned_account_custom']) c;
SELECT ok(has_column_privilege('moneyflow_app', 'statement_lines', 'auto_settled', 'SELECT, INSERT, UPDATE'),
          'app grava statement_lines.auto_settled');

-- Dados base: Casa (C1) e Empresa (C2) ---------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000510e1', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-0000000510e2', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-0000000510e3', 'company', 'Imobiliária Locadora');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000510c1', 'Casa', 'general', '00000000-0000-7000-8000-0000000510e1', true),
  ('00000000-0000-7000-8000-0000000510c2', 'Empresa', 'general', '00000000-0000-7000-8000-0000000510e2', true);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000510ca', 'expense', 'Aluguel 51');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000510a1', '00000000-0000-7000-8000-0000000510c1', 'checking', 'Corrente Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510a2', '00000000-0000-7000-8000-0000000510c1', 'cash', 'Cofre Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510a3', '00000000-0000-7000-8000-0000000510c1', 'savings', 'Poupança Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510c2', 'checking', 'Corrente Empresa', '2026-01-01');

-- Conta prevista: da caixa do título, de qualquer tipo (0052) ----------------------------------------------------------
CREATE FUNCTION pg_temp.title(p_id text, p_planned text) RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    $f$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                           amount_cents, planned_account_id)
       VALUES (%L, '00000000-0000-7000-8000-0000000510c1', 'payable', '00000000-0000-7000-8000-0000000510e3',
               '00000000-0000-7000-8000-0000000510ca', 'Aluguel', '2026-01-01', '2026-01-10', 100000, %L)$f$,
    p_id, p_planned)
$$;
SELECT is(pg_temp.err(pg_temp.title('00000000-0000-7000-8000-000000051100', '00000000-0000-7000-8000-0000000510b1')),
          '23514 titles_planned_account_check', 'conta de outra caixa não é conta prevista');
SELECT lives_ok(pg_temp.title('00000000-0000-7000-8000-000000051101', '00000000-0000-7000-8000-0000000510a1'), 'corrente da caixa');
SELECT lives_ok(pg_temp.title('00000000-0000-7000-8000-000000051102', '00000000-0000-7000-8000-0000000510a2'), 'cofre da caixa (0052)');
SELECT lives_ok(pg_temp.title('00000000-0000-7000-8000-000000051103', '00000000-0000-7000-8000-0000000510a3'), 'poupança da caixa');
SELECT lives_ok(pg_temp.title('00000000-0000-7000-8000-000000051104', NULL), 'sem conta prevista');
SELECT is(pg_temp.err(pg_temp.title('00000000-0000-7000-8000-000000051105', '00000000-0000-7000-8000-0005100000ff')),
          '23503 titles_planned_account_id_fkey', 'conta inexistente: a FK recusa');

SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$UPDATE titles SET planned_account_id = '00000000-0000-7000-8000-0000000510a3', planned_account_custom = true
                   WHERE id = '00000000-0000-7000-8000-000000051104'$$, 'a aplicação troca a conta prevista');
SELECT throws_ok($$UPDATE titles SET planned_account_id = '00000000-0000-7000-8000-0000000510b1'
                    WHERE id = '00000000-0000-7000-8000-000000051104'$$, '23514', NULL,
                  'a aplicação recebe o erro da conta de outra caixa');
RESET ROLE;

SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-000000051101'$$),
          '23514 titles_planned_account_check', 'título que muda de caixa revalida a conta prevista');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = '00000000-0000-7000-8000-0000000510c2',
                                          planned_account_id = '00000000-0000-7000-8000-0000000510b1'
                         WHERE id = '00000000-0000-7000-8000-000000051101'; SELECT 1/0$$),
          '22012 ', 'muda de caixa trocando a prevista junto');

-- Conta referenciada não muda de caixa; o tipo é livre --------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-0000000510a2'$$),
          '23514 titles_planned_account_check', 'conta prevista não muda de caixa');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET kind = 'cash' WHERE id = '00000000-0000-7000-8000-0000000510a3';
                       SELECT 1/0$$), '22012 ', 'conta prevista pode virar cofre (0052)');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET name = 'Outro nome', archived_at = now()
                         WHERE id = '00000000-0000-7000-8000-0000000510a1'; SELECT 1/0$$), '22012 ',
          'renomear e arquivar continuam livres');
SELECT is(pg_temp.err($$DELETE FROM financial_accounts WHERE id = '00000000-0000-7000-8000-0000000510a3'$$),
          '23503 titles_planned_account_id_fkey', 'conta prevista não é excluída (RESTRICT)');

-- Linhas: transfer_settlement e auto_settled ------------------------------------------------------------------------
-- Baixa do título 51101 com a transferência da Empresa para a corrente da Casa (o histórico da 033).
INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, fine_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000512a1', '00000000-0000-7000-8000-000000051101', '2026-01-15', 100000, 166, 2000,
   '00000000-0000-7000-8000-0000000510a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000510a1', '2026-01-15', -102166, 'settlement', '00000000-0000-7000-8000-0000000512a1');
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000513a1', '00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a1',
   102166, '2026-01-15', '00000000-0000-7000-8000-0000000512a1');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  ('00000000-0000-7000-8000-0000000514b1', '00000000-0000-7000-8000-0000000510b1', '2026-01-15', -102166, 'transfer',
   '00000000-0000-7000-8000-0000000513a1'),
  ('00000000-0000-7000-8000-0000000514a2', '00000000-0000-7000-8000-0000000510a1', '2026-01-15', 102166, 'transfer',
   '00000000-0000-7000-8000-0000000513a1');
-- Uma transferência comum e um avulso na conta da Empresa.
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on) VALUES
  ('00000000-0000-7000-8000-0000000513a9', '00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a1',
   300, '2026-01-20');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  ('00000000-0000-7000-8000-0000000514b9', '00000000-0000-7000-8000-0000000510b1', '2026-01-20', -300, 'transfer',
   '00000000-0000-7000-8000-0000000513a9'),
  ('00000000-0000-7000-8000-0000000514a9', '00000000-0000-7000-8000-0000000510a1', '2026-01-20', 300, 'transfer',
   '00000000-0000-7000-8000-0000000513a9');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000514b8', '00000000-0000-7000-8000-0000000510b1', '2026-01-21', -500, 'adjustment', 'Tarifa');
SELECT lives_ok($$SELECT pg_temp.commit_check()$$, 'baixa, transferências e movimentos coerentes no COMMIT');

INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000515a7', 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1', 'ofx',
   '00000000-0000-7000-8000-0000000515a7', '2026-01-01', '2026-01-31');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash) VALUES
  ('00000000-0000-7000-8000-0000000516b1', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   1, '2026-01-15', -102166, 'PIX ALUGUEL', 'h1'),
  ('00000000-0000-7000-8000-0000000516b2', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   2, '2026-01-20', -300, 'TRANSF', 'h2'),
  ('00000000-0000-7000-8000-0000000516b3', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   3, '2026-01-21', -500, 'TARIFA', 'h3');

SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                                   movement_id = '00000000-0000-7000-8000-0000000514b9',
                                                   created_entry = 'transfer_settlement'
                         WHERE id = '00000000-0000-7000-8000-0000000516b2'$$),
          '23514 statement_lines_created_entry_links_check', 'transfer_settlement exige a transferência de uma baixa');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                                   movement_id = '00000000-0000-7000-8000-0000000514b8',
                                                   created_entry = 'transfer_settlement'
                         WHERE id = '00000000-0000-7000-8000-0000000516b3'$$),
          '23514 statement_lines_created_entry_links_check', 'transfer_settlement não aceita um avulso');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'suggested', movement_id = '00000000-0000-7000-8000-0000000514b1',
                                                   created_entry = 'transfer_settlement'
                         WHERE id = '00000000-0000-7000-8000-0000000516b1'$$),
          '23514 statement_lines_created_entry_check', 'transfer_settlement só em matched');
SELECT is(pg_temp.err($$UPDATE statement_lines SET auto_settled = true WHERE id = '00000000-0000-7000-8000-0000000516b1'$$),
          '23514 statement_lines_auto_settled_check', 'auto_settled só em matched');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                                   movement_id = '00000000-0000-7000-8000-0000000514b8',
                                                   created_entry = 'adjustment', auto_settled = true
                         WHERE id = '00000000-0000-7000-8000-0000000516b3'$$),
          '23514 statement_lines_auto_settled_check', 'auto_settled só num lançamento criado pela linha (baixa ou compra)');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                                   movement_id = '00000000-0000-7000-8000-0000000514b9', auto_settled = true
                         WHERE id = '00000000-0000-7000-8000-0000000516b2'$$),
          '23514 statement_lines_auto_settled_check', 'auto_settled exige created_entry');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                             movement_id = '00000000-0000-7000-8000-0000000514b1',
                                             created_entry = 'transfer_settlement', auto_settled = true
                   WHERE id = '00000000-0000-7000-8000-0000000516b1'$$,
                'a linha da Empresa concilia a perna da transferência da baixa, automática (histórico da 033)');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'new', matched_at = NULL, movement_id = NULL, created_entry = NULL
                         WHERE id = '00000000-0000-7000-8000-0000000516b1'$$),
          '23514 statement_lines_auto_settled_check', 'desfazer sem limpar auto_settled é recusado');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'new', matched_at = NULL, movement_id = NULL, created_entry = NULL,
                                                   auto_settled = false
                         WHERE id = '00000000-0000-7000-8000-0000000516b1'; SELECT 1/0$$), '22012 ',
          'desfazer limpando as duas marcas');

SELECT * FROM finish();
ROLLBACK;
