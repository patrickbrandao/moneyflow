-- Testes de 0059_period_closing_lock (tarefa 145): a trava consultiva por caixa entre quem escreve num período (compartilhada)
-- e quem fecha o mês (exclusiva). O pgTAP roda numa sessão só: aqui se confere que cada caminho toma a trava certa e que
-- as regras de mês fechado continuam; a espera entre duas sessões foi conferida à mão (tasks/145).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000059' || p)::uuid $$;
-- Modos da trava do fechamento da caixa que esta sessão tem.
CREATE FUNCTION pg_temp.lock_modes(p_caixa uuid) RETURNS text[]
LANGUAGE sql AS $$
  SELECT coalesce(array_agg(DISTINCT l.mode ORDER BY l.mode), '{}')
    FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.objsubid = 1 AND l.granted
     AND l.classid::bigint = ((period_lock_key(p_caixa) >> 32) & 4294967295)
     AND l.objid::bigint = (period_lock_key(p_caixa) & 4294967295)
$$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('period_lock_key', ARRAY['uuid']);
SELECT has_function('period_lock_shared', ARRAY['uuid']);
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'period_assert_open(uuid, date, text)'::regprocedure), 'v',
          'period_assert_open é VOLATILE (a leitura vem numa instrução depois da trava)');
SELECT has_trigger('period_closings', 'period_closings_lock');
SELECT has_trigger('statement_lines', 'statement_lines_period_lock');
SELECT has_trigger('statement_imports', 'statement_imports_period_lock');
SELECT ok('period_closings_lock' < 'period_closings_provisional_check', 'a trava do fechamento vem antes da checagem do provisório');
SELECT ok('statement_lines_period_lock' < 'statement_lines_supersede_validate', 'a trava da linha vem antes da checagem dela');
SELECT ok('statement_imports_period_lock' < 'statement_imports_supersede_validate', 'a trava do lote vem antes da checagem dele');
SELECT is(period_lock_key(pg_temp.u('c001')), hashtextextended('period_closing:' || pg_temp.u('c001')::text, 0), 'chave por caixa');

-- Dados base: uma caixa por caminho (as travas valem até o fim da transação do teste) -------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'P1'), (pg_temp.u('e002'), 'person', 'P2'), (pg_temp.u('e003'), 'person', 'P3'),
  (pg_temp.u('e004'), 'person', 'P4'), (pg_temp.u('e005'), 'person', 'P5'), (pg_temp.u('e006'), 'person', 'P6'),
  (pg_temp.u('e009'), 'company', 'Fornecedor');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary)
SELECT pg_temp.u('c00' || n), 'Caixa ' || n, 'general', pg_temp.u('e00' || n), true FROM generate_series(1, 6) n;
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date)
SELECT pg_temp.u('a00' || n), pg_temp.u('c00' || n), 'checking', 'Conta ' || n, '2026-01-01' FROM generate_series(1, 6) n;
INSERT INTO categories (id, kind, name) VALUES (pg_temp.u('ca01'), 'expense', 'Despesa 59');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  (pg_temp.u('ff01'), 'extrato.ofx', 'application/x-ofx', '\x4f4658');
SELECT pg_temp.commit_check();
SELECT is(pg_temp.lock_modes(pg_temp.u('c00' || n)), '{}'::text[], 'caixa ' || n || ': sem trava antes')
  FROM generate_series(1, 6) n;

-- Quem escreve: trava compartilhada -------------------------------------------------------------------------------------------
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description)
VALUES (pg_temp.u('a001'), '2026-10-15', -100, 'adjustment', 'Tarifa');
SELECT is(pg_temp.lock_modes(pg_temp.u('c001')), ARRAY['ShareLock'], 'movimento: trava compartilhada da caixa');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
VALUES (pg_temp.u('b002'), pg_temp.u('c002'), 'payable', pg_temp.u('e009'), pg_temp.u('ca01'), 'Conta', '2026-10-01', '2026-10-10', 500);
SELECT is(pg_temp.lock_modes(pg_temp.u('c002')), ARRAY['ShareLock'], 'título: trava compartilhada da caixa');
UPDATE financial_accounts SET opening_balance_cents = 10 WHERE id = pg_temp.u('a006');
SELECT is(pg_temp.lock_modes(pg_temp.u('c006')), ARRAY['ShareLock'], 'saldo inicial da conta: trava compartilhada da caixa');

-- Quem fecha: trava exclusiva -----------------------------------------------------------------------------------------------
INSERT INTO period_closings (caixa_id, month) VALUES (pg_temp.u('c003'), '2026-09-01');
SELECT is(pg_temp.lock_modes(pg_temp.u('c003')), ARRAY['ExclusiveLock'], 'fechamento: trava exclusiva da caixa');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description)
                   VALUES (pg_temp.u('a003'), '2026-09-15', -100, 'adjustment', 'Tarifa')$$,
                 '23514', NULL, 'mês fechado continua recusando o movimento (a mesma transação não espera a própria trava)');
SELECT lives_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description)
                  VALUES (pg_temp.u('a003'), '2026-10-15', -100, 'adjustment', 'Tarifa')$$, 'mês aberto continua livre');
SELECT is(pg_temp.lock_modes(pg_temp.u('c003')), ARRAY['ExclusiveLock', 'ShareLock'],
          'quem fechou e escreve na mesma transação tem as duas');

-- Lote provisório: a linha do provisório ativo trava; a do lote comum, não --------------------------------------------------------
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, provisional) VALUES
  (pg_temp.u('ab04'), pg_temp.u('a004'), 'ofx', pg_temp.u('ff01'), '2026-10-01', '2026-10-10', true),
  (pg_temp.u('ab05'), pg_temp.u('a005'), 'ofx', pg_temp.u('ff01'), '2026-10-01', '2026-10-10', false);
SELECT is(pg_temp.lock_modes(pg_temp.u('c004')) || pg_temp.lock_modes(pg_temp.u('c005')), '{}'::text[], 'criar o lote não trava');
INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description, dedup_hash)
VALUES (pg_temp.u('ab04'), pg_temp.u('a004'), 1, '2026-10-05', -100, 'X', 'h1'),
       (pg_temp.u('ab05'), pg_temp.u('a005'), 1, '2026-10-05', -100, 'X', 'h1');
SELECT is(pg_temp.lock_modes(pg_temp.u('c004')), ARRAY['ShareLock'], 'linha de provisório ativo: trava compartilhada');
SELECT is(pg_temp.lock_modes(pg_temp.u('c005')), '{}'::text[], 'linha de lote comum: sem trava');
UPDATE statement_imports SET notes = 'nota' WHERE id = pg_temp.u('ab05');
SELECT is(pg_temp.lock_modes(pg_temp.u('c005')), '{}'::text[], 'editar o lote comum: sem trava');
UPDATE statement_imports SET provisional = true WHERE id = pg_temp.u('ab05');
SELECT is(pg_temp.lock_modes(pg_temp.u('c005')), ARRAY['ShareLock'], 'virar provisório: trava compartilhada');

-- As regras do fechamento continuam -------------------------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO period_closings (caixa_id, month) VALUES (pg_temp.u('c004'), '2026-10-01')$$,
                 '23514', NULL, 'mês com linha de provisório ativo não fecha');
SELECT pg_temp.commit_check();

SELECT * FROM finish();
ROLLBACK;
