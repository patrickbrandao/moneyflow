-- Testes de 0010_movements: movimentos, baixas com conta, transferências e saldos.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table('movements');
SELECT has_table('transfers');
SELECT has_view('financial_account_balances');
SELECT columns_are('movements', ARRAY['id', 'financial_account_id', 'occurred_on', 'amount_cents', 'kind', 'settlement_id',
                                      'transfer_id', 'description', 'entity_id', 'category_id', 'notes',
                                      'created_at', 'updated_at']);
SELECT columns_are('transfers', ARRAY['id', 'from_account_id', 'to_account_id', 'amount_cents', 'transferred_on',
                                      'description', 'settlement_id', 'notes', 'created_at', 'updated_at']);
SELECT col_type_is('movements', 'amount_cents', 'bigint');
SELECT col_type_is('transfers', 'amount_cents', 'bigint');
SELECT fk_ok('movements', 'financial_account_id', 'financial_accounts', 'id');
SELECT fk_ok('movements', 'settlement_id', 'settlements', 'id');
SELECT fk_ok('movements', 'transfer_id', 'transfers', 'id');
SELECT fk_ok('movements', 'entity_id', 'entities', 'id');
SELECT fk_ok('movements', 'category_id', 'categories', 'id');
SELECT fk_ok('transfers', 'from_account_id', 'financial_accounts', 'id');
SELECT fk_ok('transfers', 'to_account_id', 'financial_accounts', 'id');
SELECT fk_ok('transfers', 'settlement_id', 'settlements', 'id');
SELECT has_index('movements', i) FROM unnest(ARRAY[
  'movements_financial_account_id_occurred_on_idx', 'movements_settlement_id_idx', 'movements_transfer_id_idx',
  'movements_entity_id_idx', 'movements_category_id_idx']) i;
SELECT has_index('transfers', i) FROM unnest(ARRAY['transfers_from_account_id_idx', 'transfers_to_account_id_idx']) i;
SELECT has_trigger('movements', t) FROM unnest(ARRAY['movements_set_updated_at', 'movements_validate', 'movements_integrity_check']) t;
SELECT has_trigger('transfers', t) FROM unnest(ARRAY['transfers_set_updated_at', 'transfers_integrity_check']) t;
SELECT has_trigger('settlements', 'settlements_movements_check');
SELECT has_trigger('financial_accounts', 'financial_accounts_validate_history');
SELECT has_function('financial_account_balance_at', ARRAY['uuid', 'date']);
SELECT has_function('settlement_assert_movements', ARRAY['uuid']);
SELECT has_function('transfer_assert_movements', ARRAY['uuid']);

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
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú PF', '2026-01-01', 500000),
  ('00000000-0000-7000-8000-0000000a0011', '00000000-0000-7000-8000-0000000c0001', 'cash', 'Cofre casa', '2026-01-01', 10000),
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0002', 'checking', 'Inter PJ', '2026-01-01', 0),
  ('00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-0000000c0003', 'checking', 'Itaú CC', '2026-01-01', 0);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca02', 'income', 'Vendas');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable',
   '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Energia 10/2026',
   '2026-10-01', '2026-10-15', 100000),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000c0001', 'receivable',
   '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'Aluguel recebido',
   '2026-10-01', '2026-10-05', 300000);

-- Ajustes e regras imediatas -----------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description, category_id)
                  VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', -500, 'adjustment', 'Contagem do cofre',
                          '00000000-0000-7000-8000-00000000ca01')$$, 'ajuste de saída com categoria de despesa');
SELECT lives_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description)
                  VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-02', 200, 'adjustment', 'Sobra')$$, 'ajuste sem categoria');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, category_id)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', 500, 'adjustment', '00000000-0000-7000-8000-00000000ca01')$$,
                 '23514', 'movements: incoming movement requires income category, got expense', 'entrada exige categoria de receita');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', 0, 'adjustment')$$, '23514', NULL, 'valor ≠ 0');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', 1, 'income')$$, '23514', NULL, 'kind só settlement|transfer|adjustment');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', 1, 'settlement')$$, '23514', NULL, 'movimento de baixa exige a baixa');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-01', 1, 'transfer')$$, '23514', NULL, 'movimento de transferência exige a transferência');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', '2025-12-31', 1, 'adjustment')$$,
                 '23514', 'movements: date 2025-12-31 is before the opening date 2026-01-01 of account 00000000-0000-7000-8000-0000000a0011',
                 'movimento não antecede a abertura da conta');
SELECT throws_ok($$UPDATE financial_accounts SET opening_date = '2026-10-02' WHERE id = '00000000-0000-7000-8000-0000000a0011'$$,
                 '23514', NULL, 'abertura não passa de um movimento');
SELECT lives_ok($$UPDATE financial_accounts SET opening_date = '2026-10-01' WHERE id = '00000000-0000-7000-8000-0000000a0011'$$,
                'abertura até o primeiro movimento');
SELECT throws_ok($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000c0002' WHERE id = '00000000-0000-7000-8000-0000000a0011'$$,
                 '23514', 'financial_accounts: account 00000000-0000-7000-8000-0000000a0011 has history and cannot change caixa',
                 'conta com movimentos não muda de caixa');

-- Baixa com conta: um movimento coerente ------------------------------------------------------------
SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, fine_cents, discount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000b0001', '2026-10-16', 100000, 300, 2000, 100,
          '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-16', -102200, 'settlement', '00000000-0000-7000-8000-0000000d0001');
  SELECT pg_temp.commit_check();
$$, 'pagar: saída = −(principal + juros + multa − desconto)');
SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0002', '00000000-0000-7000-8000-0000000b0002', '2026-10-05', 100000,
          '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-05', 100000, 'settlement', '00000000-0000-7000-8000-0000000d0002');
  SELECT pg_temp.commit_check();
$$, 'receber: entrada positiva');

SELECT throws_like($$
  INSERT INTO settlements (title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000b0002', '2026-10-06', 1000, '00000000-0000-7000-8000-0000000a0001');
  SELECT pg_temp.commit_check();
$$, '%requires 1 movement(s) of 1000 cents%found 0%', 'baixa com conta sem movimento');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0009', '00000000-0000-7000-8000-0000000b0002', '2026-10-06', 1000, '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-06', -1000, 'settlement', '00000000-0000-7000-8000-0000000d0009');
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'sinal errado (receber é entrada)');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0009', '00000000-0000-7000-8000-0000000b0002', '2026-10-06', 1000, '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0011', '2026-10-06', 1000, 'settlement', '00000000-0000-7000-8000-0000000d0009');
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'movimento em outra conta');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0009', '00000000-0000-7000-8000-0000000b0002', '2026-10-06', 1000, '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-07', 1000, 'settlement', '00000000-0000-7000-8000-0000000d0009');
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'movimento em data diferente da baixa');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0009', '00000000-0000-7000-8000-0000000b0002', '2026-10-06', 1000, '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-06', 1000, 'settlement', '00000000-0000-7000-8000-0000000d0009'),
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-06', 1000, 'settlement', '00000000-0000-7000-8000-0000000d0009');
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'dois movimentos para a mesma baixa');
SELECT throws_like($$
  DELETE FROM movements WHERE settlement_id = '00000000-0000-7000-8000-0000000d0002';
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'excluir o movimento de uma baixa ativa');
SELECT throws_like($$
  UPDATE movements SET amount_cents = 99999 WHERE settlement_id = '00000000-0000-7000-8000-0000000d0002';
  SELECT pg_temp.commit_check();
$$, '%settlement%requires%', 'alterar o valor do movimento da baixa');
SELECT throws_ok($$DELETE FROM settlements WHERE id = '00000000-0000-7000-8000-0000000d0002'$$,
                 '23503', NULL, 'baixa com movimento não é excluída (estorne)');

-- Estorno com contrapartida ------------------------------------------------------------------------
SELECT throws_like($$
  UPDATE settlements SET reversed_at = now(), reversal_reason = 'devolvido' WHERE id = '00000000-0000-7000-8000-0000000d0002';
  SELECT pg_temp.commit_check();
$$, '%requires 2 movement(s)%', 'estorno exige o movimento de contrapartida');
SELECT lives_ok($$
  UPDATE settlements SET reversed_at = now(), reversal_reason = 'devolvido' WHERE id = '00000000-0000-7000-8000-0000000d0002';
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id, description)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-08', -100000, 'settlement', '00000000-0000-7000-8000-0000000d0002', 'Estorno');
  SELECT pg_temp.commit_check();
$$, 'estorno com movimento oposto');
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0002'), 'open', 'título volta a open');

-- Baixa "conta a definir" e definição posterior -------------------------------------------------
SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents)
  VALUES ('00000000-0000-7000-8000-0000000d0003', '00000000-0000-7000-8000-0000000b0002', '2026-10-09', 50000);
  SELECT pg_temp.commit_check();
$$, 'baixa sem conta não tem movimento');
SELECT throws_like($$
  UPDATE settlements SET financial_account_id = '00000000-0000-7000-8000-0000000a0001' WHERE id = '00000000-0000-7000-8000-0000000d0003';
  SELECT pg_temp.commit_check();
$$, '%requires 1 movement(s)%', 'definir a conta exige o movimento');
SELECT lives_ok($$
  UPDATE settlements SET financial_account_id = '00000000-0000-7000-8000-0000000a0001' WHERE id = '00000000-0000-7000-8000-0000000d0003';
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-09', 50000, 'settlement', '00000000-0000-7000-8000-0000000d0003');
  SELECT pg_temp.commit_check();
$$, 'definir a conta com o movimento');
SELECT throws_ok($$UPDATE settlements SET financial_account_id = '00000000-0000-7000-8000-0000000a0011' WHERE id = '00000000-0000-7000-8000-0000000d0003'$$,
                 '23514', NULL, 'conta definida não muda');

-- Transferências -------------------------------------------------------------------------------------
SELECT lives_ok($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, description)
  VALUES ('00000000-0000-7000-8000-0000000f0001', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011',
          20000, '2026-10-10', 'Saque');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', -20000, 'transfer', '00000000-0000-7000-8000-0000000f0001'),
    ('00000000-0000-7000-8000-0000000a0011', '2026-10-10', 20000, 'transfer', '00000000-0000-7000-8000-0000000f0001');
  SELECT pg_temp.commit_check();
$$, 'transferência com dois movimentos que somam zero');
SELECT throws_like($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on)
  VALUES ('00000000-0000-7000-8000-0000000f0009', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 100, '2026-10-10');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', -100, 'transfer', '00000000-0000-7000-8000-0000000f0009');
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'transferência com um movimento só');
SELECT throws_like($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on)
  VALUES ('00000000-0000-7000-8000-0000000f0009', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 100, '2026-10-10');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', -100, 'transfer', '00000000-0000-7000-8000-0000000f0009'),
    ('00000000-0000-7000-8000-0000000a0011', '2026-10-10', 99, 'transfer', '00000000-0000-7000-8000-0000000f0009');
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'movimentos que não somam zero');
SELECT throws_like($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on)
  VALUES ('00000000-0000-7000-8000-0000000f0009', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 100, '2026-10-10');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0011', '2026-10-10', -100, 'transfer', '00000000-0000-7000-8000-0000000f0009'),
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', 100, 'transfer', '00000000-0000-7000-8000-0000000f0009');
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'sentido invertido');
SELECT throws_like($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on)
  VALUES ('00000000-0000-7000-8000-0000000f0009', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 100, '2026-10-10');
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'transferência sem movimentos');
SELECT throws_like($$
  UPDATE transfers SET amount_cents = 30000 WHERE id = '00000000-0000-7000-8000-0000000f0001';
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'alterar o valor sem alterar os movimentos');
SELECT throws_ok($$INSERT INTO transfers (from_account_id, to_account_id, amount_cents, transferred_on)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0001', 100, '2026-10-10')$$,
                 '23514', NULL, 'origem e destino distintos');
SELECT throws_ok($$INSERT INTO transfers (from_account_id, to_account_id, amount_cents, transferred_on)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 0, '2026-10-10')$$,
                 '23514', NULL, 'valor > 0');
SELECT lives_ok($$
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on)
  VALUES ('00000000-0000-7000-8000-0000000f0008', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0011', 100, '2026-10-10');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', -100, 'transfer', '00000000-0000-7000-8000-0000000f0008'),
    ('00000000-0000-7000-8000-0000000a0011', '2026-10-10', 100, 'transfer', '00000000-0000-7000-8000-0000000f0008');
  SELECT pg_temp.commit_check();
  DELETE FROM transfers WHERE id = '00000000-0000-7000-8000-0000000f0008';
  SELECT pg_temp.commit_check();
$$, 'excluir a transferência leva os dois movimentos');
SELECT is((SELECT count(*)::int FROM movements WHERE transfer_id = '00000000-0000-7000-8000-0000000f0008'), 0, 'sem movimentos órfãos');
SELECT throws_like($$
  DELETE FROM movements WHERE transfer_id = '00000000-0000-7000-8000-0000000f0001' AND amount_cents > 0;
  SELECT pg_temp.commit_check();
$$, '%requires exactly two movements%', 'excluir uma perna da transferência');

-- Pagar título da caixa B com conta da caixa A ------------------------------------------------------
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000c0002', 'payable',
   '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Honorários',
   '2026-10-01', '2026-10-20', 90000);
SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, fine_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0010', '00000000-0000-7000-8000-0000000b0003', '2026-10-21', 90000, 1800,
          '00000000-0000-7000-8000-0000000a0002');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0002', '2026-10-21', -91800, 'settlement', '00000000-0000-7000-8000-0000000d0010');
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000f0002', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0002',
          91800, '2026-10-21', '00000000-0000-7000-8000-0000000d0010');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-10-21', -91800, 'transfer', '00000000-0000-7000-8000-0000000f0002'),
    ('00000000-0000-7000-8000-0000000a0002', '2026-10-21', 91800, 'transfer', '00000000-0000-7000-8000-0000000f0002');
  SELECT pg_temp.commit_check();
$$, 'transferência A → B e baixa em B com a conta de B');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0002', '2026-10-21'), 0::bigint,
          'conta de B: entra a transferência e sai o pagamento');

INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0004', '00000000-0000-7000-8000-0000000c0002', 'payable',
   '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Honorários 2',
   '2026-11-01', '2026-11-20', 1000);
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0011', '00000000-0000-7000-8000-0000000b0004', '2026-11-20', 1000,
          '00000000-0000-7000-8000-0000000a0002');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0002', '2026-11-20', -1000, 'settlement', '00000000-0000-7000-8000-0000000d0011');
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000f0003', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0002',
          999, '2026-11-20', '00000000-0000-7000-8000-0000000d0011');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0001', '2026-11-20', -999, 'transfer', '00000000-0000-7000-8000-0000000f0003'),
    ('00000000-0000-7000-8000-0000000a0002', '2026-11-20', 999, 'transfer', '00000000-0000-7000-8000-0000000f0003');
  SELECT pg_temp.commit_check();
$$, '%does not fund settlement%', 'transferência da baixa tem o valor em dinheiro da baixa');
SELECT throws_like($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0011', '00000000-0000-7000-8000-0000000b0004', '2026-11-20', 1000,
          '00000000-0000-7000-8000-0000000a0002');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0002', '2026-11-20', -1000, 'settlement', '00000000-0000-7000-8000-0000000d0011');
  INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000f0003', '00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000a0001',
          1000, '2026-11-20', '00000000-0000-7000-8000-0000000d0011');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
    ('00000000-0000-7000-8000-0000000a0002', '2026-11-20', -1000, 'transfer', '00000000-0000-7000-8000-0000000f0003'),
    ('00000000-0000-7000-8000-0000000a0001', '2026-11-20', 1000, 'transfer', '00000000-0000-7000-8000-0000000f0003');
  SELECT pg_temp.commit_check();
$$, '%does not fund settlement%', 'num título a pagar a transferência chega na conta da baixa');
SELECT throws_ok($$INSERT INTO transfers (from_account_id, to_account_id, amount_cents, transferred_on, settlement_id)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0002', 91800, '2026-10-21',
                           '00000000-0000-7000-8000-0000000d0010')$$,
                 '23505', NULL, 'uma transferência por baixa');

-- Saldos ----------------------------------------------------------------------------------------------
-- Itaú PF (a0001): 500000 + 100000 (recebido 05/10) − 100000 (estorno 08/10) + 50000 (09/10)
--                 − 20000 (saque 10/10) − 102200 (energia 16/10) − 91800 (transferência 21/10)
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', '2026-10-04'), 500000::bigint, 'saldo antes dos movimentos');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', '2026-10-05'), 600000::bigint, 'saldo inclui o dia');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', '2026-10-09'), 550000::bigint, 'estorno conta no saldo');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', '2026-12-31'), 336000::bigint, 'saldo final');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', '2025-12-31'), NULL, 'antes da abertura: NULL');
SELECT is(financial_account_balance_at('00000000-0000-7000-8000-00000000ffff', '2026-12-31'), NULL, 'conta inexistente: NULL');
SELECT results_eq($$SELECT opening_balance_cents, movements_cents, balance_cents FROM financial_account_balances
                     WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0001'$$,
                  $$VALUES (500000::bigint, -164000::bigint, 336000::bigint)$$, 'view de saldo por conta');
SELECT results_eq($$SELECT balance_cents FROM financial_account_balances
                     WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0011'$$,
                  $$VALUES (29700::bigint)$$, 'cofre: 10000 − 500 + 200 + 20000');
SELECT is((SELECT sum(amount_cents) FROM movements WHERE kind = 'transfer')::bigint, 0::bigint,
          'transferências somam zero no conjunto');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['movements', 'transfers']) t;
SELECT ok(has_table_privilege('moneyflow_app', 'financial_account_balances', 'SELECT'), 'app lê financial_account_balances');
SELECT function_privs_are('financial_account_balance_at', ARRAY['uuid', 'date'], 'moneyflow_app', ARRAY['EXECUTE']);
SELECT ok(NOT has_function_privilege('public', 'financial_account_balance_at(uuid, date)', 'EXECUTE'), 'PUBLIC não executa');

SELECT * FROM finish();
ROLLBACK;
