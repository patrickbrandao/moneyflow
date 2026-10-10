-- Testes de 0009_settlements: baixas, estorno, status do título, pernas do espelho e saldo aberto.
-- (Baixas com conta e seus movimentos são testados em 0010_movements.)
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table('settlements');
SELECT has_view('title_balances');
SELECT columns_are('settlements', ARRAY['id', 'title_id', 'settled_on', 'amount_cents', 'interest_cents', 'fine_cents',
                                        'discount_cents', 'financial_account_id', 'mirror_settlement_id', 'notes',
                                        'reversed_at', 'reversal_reason', 'created_at', 'updated_at']);
SELECT col_type_is('settlements', c, 'bigint')
  FROM unnest(ARRAY['amount_cents', 'interest_cents', 'fine_cents', 'discount_cents']) c;
SELECT col_is_null('settlements', 'financial_account_id');
SELECT fk_ok('settlements', 'title_id', 'titles', 'id');
SELECT fk_ok('settlements', 'financial_account_id', 'financial_accounts', 'id');
SELECT fk_ok('settlements', 'mirror_settlement_id', 'settlements', 'id');
SELECT has_index('settlements', i) FROM unnest(ARRAY[
  'settlements_title_id_idx', 'settlements_financial_account_id_idx', 'settlements_settled_on_idx',
  'settlements_mirror_settlement_id_key']) i;
SELECT has_trigger('settlements', t) FROM unnest(ARRAY[
  'settlements_set_updated_at', 'settlements_validate', 'settlements_refresh_title_status', 'settlements_mirror_check']) t;
SELECT has_function('title_settled_cents', ARRAY['uuid']);

-- Dados base
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-00000000e004', 'company', 'Escritório Contábil'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true),
  ('00000000-0000-7000-8000-0000000c0003', 'Contabilidade', 'general', '00000000-0000-7000-8000-00000000e004', true);
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0002', 'checking', 'Inter PJ', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca02', 'income', 'Vendas');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable',
   '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Energia 10/2026',
   '2026-10-01', '2026-10-15', 100000);

-- Baixa parcial, total, excesso -----------------------------------------------------------------
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000b0001', '2026-10-10', 40000);
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'partial', 'baixa parcial => partial');
SELECT is(title_settled_cents('00000000-0000-7000-8000-0000000b0001'), 40000::bigint, 'title_settled_cents');
SELECT is((SELECT open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0001'), 60000::bigint,
          'saldo aberto = valor − baixas ativas');

SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 60001)$$,
                 '23514', 'settlements: amount 60001 exceeds open balance 60000 of title 00000000-0000-7000-8000-0000000b0001',
                 'não baixa mais que o saldo aberto');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 0)$$,
                 '23514', NULL, 'principal > 0');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents, interest_cents) VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 100, -1)$$,
                 '23514', NULL, 'juros >= 0');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents, discount_cents) VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 100, 101)$$,
                 '23514', NULL, 'desconto não passa de principal + juros + multa');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents, reversed_at, reversal_reason)
                   VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 100, now(), 'x')$$,
                 '23514', 'settlements: a settlement cannot be created already reversed', 'baixa não nasce estornada');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents, financial_account_id)
                   VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 100, '00000000-0000-7000-8000-0000000a0002')$$,
                 '23514', 'settlements: account 00000000-0000-7000-8000-0000000a0002 does not belong to caixa 00000000-0000-7000-8000-0000000c0001 of the title',
                 'conta da baixa é da caixa do título');

INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, fine_cents, discount_cents) VALUES
  ('00000000-0000-7000-8000-0000000d0002', '00000000-0000-7000-8000-0000000b0001', '2026-10-20', 60000, 300, 2000, 100);
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'paid', 'baixas somam o valor => paid');
SELECT is((SELECT open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0001'), 0::bigint,
          'juros, multa e desconto não mudam o saldo aberto');

-- Status manual e valor --------------------------------------------------------------------------
SELECT throws_ok($$UPDATE titles SET status = 'open' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', 'titles: status open does not match settlements (expected paid)', 'status não contradiz as baixas');
SELECT throws_ok($$UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', 'titles: title 00000000-0000-7000-8000-0000000b0001 has active settlements and cannot be canceled',
                 'título com baixa ativa não é cancelado');
SELECT throws_ok($$UPDATE titles SET amount_cents = 99999 WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', 'titles: amount 99999 is below settled 100000', 'valor não fica abaixo do baixado');
UPDATE titles SET amount_cents = 120000 WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'partial', 'aumentar o valor reabre como partial');
UPDATE titles SET amount_cents = 100000 WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'paid', 'e voltar fecha de novo');
SELECT throws_ok($$UPDATE titles SET caixa_id = '00000000-0000-7000-8000-0000000c0002' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', 'titles: title 00000000-0000-7000-8000-0000000b0001 has settlements and cannot change caixa',
                 'título com baixas não muda de caixa');
SELECT throws_ok($$DELETE FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23503', NULL, 'título com baixas não pode ser excluído');

-- Imutabilidade e estorno -------------------------------------------------------------------------
SELECT throws_ok($$UPDATE settlements SET amount_cents = 50000 WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', NULL, 'valores da baixa são imutáveis');
SELECT throws_ok($$UPDATE settlements SET settled_on = '2026-10-21' WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', NULL, 'data da baixa é imutável');
SELECT throws_ok($$UPDATE settlements SET reversed_at = now() WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', NULL, 'estorno exige motivo');
SELECT throws_ok($$UPDATE settlements SET reversed_at = now(), reversal_reason = ' ' WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', NULL, 'motivo do estorno não vazio');
UPDATE settlements SET reversed_at = now(), reversal_reason = 'pagamento devolvido' WHERE id = '00000000-0000-7000-8000-0000000d0002';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'partial', 'estorno => volta a partial');
SELECT is((SELECT open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0001'), 60000::bigint,
          'baixa estornada não conta');
SELECT throws_ok($$UPDATE settlements SET reversed_at = NULL, reversal_reason = NULL WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', 'settlements: reversal of settlement 00000000-0000-7000-8000-0000000d0002 cannot be undone or changed',
                 'estorno é irreversível');
SELECT throws_ok($$UPDATE settlements SET financial_account_id = '00000000-0000-7000-8000-0000000a0002' WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23514', NULL, 'baixa estornada não recebe conta');
UPDATE settlements SET reversed_at = now(), reversal_reason = 'lançado em duplicidade' WHERE id = '00000000-0000-7000-8000-0000000d0001';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'open', 'sem baixas ativas => open');

-- Cancelamento
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT pass('título só com baixas estornadas pode ser cancelado');
SELECT is((SELECT open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0001'), 0::bigint,
          'cancelado não tem saldo aberto');
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES ('00000000-0000-7000-8000-0000000b0001', '2026-10-11', 100)$$,
                 '23514', 'settlements: title 00000000-0000-7000-8000-0000000b0001 is canceled', 'título cancelado não recebe baixa');
UPDATE titles SET amount_cents = 110000 WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'canceled', 'editar cancelado mantém canceled');

-- Exclusão de baixa (sem movimento) atualiza o status
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000c0001', 'payable',
   '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Energia 11/2026',
   '2026-11-01', '2026-11-15', 5000);
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000d0003', '00000000-0000-7000-8000-0000000b0002', '2026-11-10', 5000);
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0002'), 'paid', 'baixa total');
DELETE FROM settlements WHERE id = '00000000-0000-7000-8000-0000000d0003';
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0002'), 'open', 'excluir a baixa reabre o título');

-- Baixa única com duas pernas (espelho) ----------------------------------------------------------
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id) VALUES
  ('00000000-0000-7000-8000-0000000b0101', '00000000-0000-7000-8000-0000000c0003', 'receivable',
   '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'Honorários 10/2026',
   '2026-10-01', '2026-10-20', 90000, '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0102');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  ('00000000-0000-7000-8000-0000000b0102', '00000000-0000-7000-8000-0000000c0002', 'payable',
   '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Honorários 10/2026',
   '2026-10-01', '2026-10-20', 90000, '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0101', 'accepted');
SELECT lives_ok($$SELECT pg_temp.commit_check()$$, 'par espelhado');

SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
    ('00000000-0000-7000-8000-0000000d0101', '00000000-0000-7000-8000-0000000b0101', '2026-10-20', 30000, '00000000-0000-7000-8000-0000000d0102'),
    ('00000000-0000-7000-8000-0000000d0102', '00000000-0000-7000-8000-0000000b0102', '2026-10-20', 30000, '00000000-0000-7000-8000-0000000d0101');
  SELECT pg_temp.commit_check();
$$, 'duas pernas ligadas, ambas "conta a definir"');
SELECT results_eq($$SELECT status FROM titles WHERE id IN ('00000000-0000-7000-8000-0000000b0101', '00000000-0000-7000-8000-0000000b0102')$$,
                  ARRAY['partial', 'partial'], 'os dois lados ficam partial');

SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
    ('00000000-0000-7000-8000-0000000d0201', '00000000-0000-7000-8000-0000000b0101', '2026-10-21', 10000, '00000000-0000-7000-8000-0000000d0202'),
    ('00000000-0000-7000-8000-0000000d0202', '00000000-0000-7000-8000-0000000b0102', '2026-10-21', 10001, '00000000-0000-7000-8000-0000000d0201');
  SELECT pg_temp.commit_check();
$$, '%must have the same date, amounts and reversal state%', 'pernas com valores diferentes');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
    ('00000000-0000-7000-8000-0000000d0201', '00000000-0000-7000-8000-0000000b0101', '2026-10-21', 10000, '00000000-0000-7000-8000-0000000d0202');
  INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES
    ('00000000-0000-7000-8000-0000000d0202', '00000000-0000-7000-8000-0000000b0102', '2026-10-21', 10000);
  SELECT pg_temp.commit_check();
$$, '%is not reciprocal%', 'ligação das pernas é recíproca');
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
    ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000c0002', 'payable',
     '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Avulso', '2026-10-01', '2026-10-20', 90000);
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
    ('00000000-0000-7000-8000-0000000d0201', '00000000-0000-7000-8000-0000000b0101', '2026-10-21', 10000, '00000000-0000-7000-8000-0000000d0202'),
    ('00000000-0000-7000-8000-0000000d0202', '00000000-0000-7000-8000-0000000b0003', '2026-10-21', 10000, '00000000-0000-7000-8000-0000000d0201');
  SELECT pg_temp.commit_check();
$$, '%are not on a mirrored title pair%', 'pernas ficam nos dois títulos do par');
SELECT throws_like($$
  UPDATE settlements SET reversed_at = now(), reversal_reason = 'erro' WHERE id = '00000000-0000-7000-8000-0000000d0101';
  SELECT pg_temp.commit_check();
$$, '%reversal state%', 'estornar só uma perna');
SELECT lives_ok($$
  UPDATE settlements SET reversed_at = now(), reversal_reason = 'erro'
   WHERE id IN ('00000000-0000-7000-8000-0000000d0101', '00000000-0000-7000-8000-0000000d0102');
  SELECT pg_temp.commit_check();
$$, 'estornar as duas pernas juntas');
SELECT results_eq($$SELECT status FROM titles WHERE id IN ('00000000-0000-7000-8000-0000000b0101', '00000000-0000-7000-8000-0000000b0102')$$,
                  ARRAY['open', 'open'], 'os dois lados voltam a open');

-- Privilégios
SELECT table_privs_are('settlements', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
SELECT ok(has_table_privilege('moneyflow_app', 'title_balances', 'SELECT'), 'app lê title_balances');
SELECT function_privs_are('title_settled_cents', ARRAY['uuid'], 'moneyflow_app', ARRAY['EXECUTE']);
SELECT ok(NOT has_function_privilege('public', 'title_settled_cents(uuid)', 'EXECUTE'), 'PUBLIC não executa');

SELECT * FROM finish();
ROLLBACK;
