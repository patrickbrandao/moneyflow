-- Testes de 0051_contract_payments (spec 033): conta das parcelas e de passagem no contrato, encargos, janela e
-- auto_settle; conta prevista nos títulos; contas referenciadas que mudam de caixa ou de tipo; created_entry
-- transfer_settlement e auto_settled nas linhas; a leitura contract_payments().
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
SELECT has_column('contracts', c)
  FROM unnest(ARRAY['payment_account_id', 'transit_account_id', 'late_fee_percent', 'interest_month_percent',
                    'early_discount_percent', 'tolerance_cents', 'match_window_days', 'auto_settle']) c;
SELECT col_type_is('contracts', c, 'numeric(6,4)')
  FROM unnest(ARRAY['late_fee_percent', 'interest_month_percent', 'early_discount_percent']) c;
SELECT col_is_null('contracts', c)
  FROM unnest(ARRAY['payment_account_id', 'transit_account_id', 'late_fee_percent', 'interest_month_percent',
                    'early_discount_percent']) c;
SELECT col_not_null('contracts', c) FROM unnest(ARRAY['tolerance_cents', 'match_window_days', 'auto_settle']) c;
SELECT col_default_is('contracts', 'tolerance_cents', '0');
SELECT col_default_is('contracts', 'match_window_days', '15');
SELECT col_default_is('contracts', 'auto_settle', 'false');
SELECT fk_ok('contracts', 'payment_account_id', 'financial_accounts', 'id');
SELECT fk_ok('contracts', 'transit_account_id', 'financial_accounts', 'id');
SELECT has_index('contracts', i) FROM unnest(ARRAY['contracts_payment_account_id_idx', 'contracts_transit_account_id_idx']) i;

SELECT has_column('titles', c) FROM unnest(ARRAY['planned_account_id', 'planned_transit_account_id', 'planned_account_custom']) c;
SELECT col_not_null('titles', 'planned_account_custom');
SELECT col_default_is('titles', 'planned_account_custom', 'false');
SELECT fk_ok('titles', 'planned_account_id', 'financial_accounts', 'id');
SELECT fk_ok('titles', 'planned_transit_account_id', 'financial_accounts', 'id');
SELECT has_index('titles', i) FROM unnest(ARRAY['titles_planned_account_id_idx', 'titles_planned_account_open_idx',
                                                'titles_planned_transit_account_id_idx']) i;
SELECT ok(indexdef ~ 'status' AND indexdef ~ 'open' AND indexdef ~ 'partial', 'índice da busca só com os títulos em aberto')
  FROM pg_indexes WHERE indexname = 'titles_planned_account_open_idx';

SELECT has_column('statement_lines', 'auto_settled');
SELECT col_not_null('statement_lines', 'auto_settled');
SELECT col_default_is('statement_lines', 'auto_settled', 'false');
SELECT has_trigger('contracts', 'contracts_validate_accounts');
SELECT has_trigger('titles', 'titles_validate_planned_account');
SELECT has_trigger('financial_accounts', 'financial_accounts_validate_payment_refs');
SELECT has_trigger('statement_lines', 'statement_lines_validate_created_entry');

SELECT has_function('contract_payments', ARRAY['uuid', 'uuid', 'date']);
SELECT ok(has_function_privilege('moneyflow_app', 'contract_payments(uuid, uuid, date)', 'EXECUTE'),
          'a aplicação lê contract_payments');
SELECT ok(has_function_privilege('moneyflow_app', 'payment_accounts_assert(uuid, uuid, uuid, text, text, text)', 'EXECUTE'),
          'o auxiliar dos triggers roda como a aplicação');
SELECT ok(has_column_privilege('moneyflow_app', 'contracts', c, 'SELECT, INSERT, UPDATE'), 'app grava contracts.' || c)
  FROM unnest(ARRAY['payment_account_id', 'transit_account_id', 'auto_settle']) c;
SELECT ok(has_column_privilege('moneyflow_app', 'titles', c, 'SELECT, INSERT, UPDATE'), 'app grava titles.' || c)
  FROM unnest(ARRAY['planned_account_id', 'planned_transit_account_id', 'planned_account_custom']) c;
SELECT ok(has_column_privilege('moneyflow_app', 'statement_lines', 'auto_settled', 'SELECT, INSERT, UPDATE'),
          'app grava statement_lines.auto_settled');

-- Dados base: Casa (C1) paga o aluguel ao Locador; a Empresa (C2) pode pagar por ela -------------------------------
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
  ('00000000-0000-7000-8000-0000000510a2', '00000000-0000-7000-8000-0000000510c1', 'cash', 'Passagem Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510a3', '00000000-0000-7000-8000-0000000510c1', 'savings', 'Poupança Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510c2', 'checking', 'Corrente Empresa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000510b2', '00000000-0000-7000-8000-0000000510c2', 'cash', 'Caixinha Empresa', '2026-01-01');

-- Contrato: limites -------------------------------------------------------------------------------------------------
CREATE TEMP TABLE k_cases (col text, val text, expected text);
INSERT INTO k_cases VALUES
  ('late_fee_percent', '20.0001', '23514 contracts_late_fee_percent_check'),
  ('late_fee_percent', '-1', '23514 contracts_late_fee_percent_check'),
  ('late_fee_percent', '20', 'ok'),
  ('interest_month_percent', '10.5', '23514 contracts_interest_month_percent_check'),
  ('interest_month_percent', '0.0333', 'ok'),
  ('early_discount_percent', '50.01', '23514 contracts_early_discount_percent_check'),
  ('early_discount_percent', '0', 'ok'),
  ('tolerance_cents', '-1', '23514 contracts_tolerance_cents_check'),
  ('tolerance_cents', '0', 'ok'),
  ('match_window_days', '46', '23514 contracts_match_window_days_check'),
  ('match_window_days', '-1', '23514 contracts_match_window_days_check'),
  ('match_window_days', '45', 'ok'),
  ('match_window_days', '0', 'ok');
SELECT is(pg_temp.err(format(
  $f$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, %I)
     VALUES ('00000000-0000-7000-8000-0000000510c1', '00000000-0000-7000-8000-0000000510e3', 'payable', 'X',
             '00000000-0000-7000-8000-0000000510ca', %L)$f$, col, val)), expected, col || ' = ' || val)
  FROM k_cases;

-- Contrato: conta das parcelas e de passagem ----------------------------------------------------------------------
CREATE FUNCTION pg_temp.k_accounts(p_payment text, p_transit text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.err(format(
    $f$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, payment_account_id, transit_account_id)
       VALUES ('00000000-0000-7000-8000-0000000510c1', '00000000-0000-7000-8000-0000000510e3', 'payable', 'X',
               '00000000-0000-7000-8000-0000000510ca', %L, %L)$f$, p_payment, p_transit))
$$;
SELECT is(pg_temp.k_accounts(NULL, NULL), 'ok', 'sem conta das parcelas');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510a1', NULL), 'ok', 'corrente da própria caixa, sem passagem');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510a3', NULL), 'ok', 'poupança da própria caixa');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510a2', NULL), '23514 contracts_payment_account_check',
          'cofre não é conta das parcelas');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b2', '00000000-0000-7000-8000-0000000510a2'),
          '23514 contracts_payment_account_check', 'cofre de outra caixa também não');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510a1', '00000000-0000-7000-8000-0000000510a2'),
          '23514 contracts_transit_account_check', 'conta da própria caixa não tem passagem');
SELECT is(pg_temp.k_accounts(NULL, '00000000-0000-7000-8000-0000000510a2'),
          '23514 contracts_transit_account_check', 'passagem sem conta das parcelas');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b1', NULL),
          '23514 contracts_transit_account_check', 'conta de outra caixa exige a passagem');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510b2'),
          '23514 contracts_transit_account_check', 'a passagem é da caixa do contrato');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a2'),
          'ok', 'conta de outra caixa com a passagem (um cofre) da caixa do contrato');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a1'),
          'ok', 'a passagem pode ser uma corrente');
SELECT is(pg_temp.k_accounts('00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0005100000ff'),
          '23503 contracts_transit_account_id_fkey', 'passagem inexistente: a FK recusa');

-- Os rascunhos aceitos acima saem (ficariam presos às contas).
DELETE FROM contracts;

-- K: aluguel da Casa pago pela conta da Empresa, com a passagem no cofre da Casa.
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, payment_account_id, transit_account_id,
                       late_fee_percent, interest_month_percent, early_discount_percent)
VALUES ('00000000-0000-7000-8000-0000000510f1', '00000000-0000-7000-8000-0000000510c1', '00000000-0000-7000-8000-0000000510e3',
        'payable', 'Aluguel', '00000000-0000-7000-8000-0000000510ca', '00000000-0000-7000-8000-0000000510b1',
        '00000000-0000-7000-8000-0000000510a2', 2, 1, 5);
SELECT is((SELECT tolerance_cents || '/' || match_window_days || '/' || auto_settle FROM contracts
            WHERE id = '00000000-0000-7000-8000-0000000510f1'), '0/15/false', 'padrões: tolerância 0, janela 15, sem auto');
SELECT is(pg_temp.err($$UPDATE contracts SET transit_account_id = NULL WHERE id = '00000000-0000-7000-8000-0000000510f1'$$),
          '23514 contracts_transit_account_check', 'tirar a passagem com a conta de outra caixa');
SELECT is(pg_temp.err($$UPDATE contracts SET payment_account_id = '00000000-0000-7000-8000-0000000510a1'
                         WHERE id = '00000000-0000-7000-8000-0000000510f1'$$),
          '23514 contracts_transit_account_check', 'trocar para a conta da caixa sem tirar a passagem');
SELECT is(pg_temp.err($$UPDATE contracts SET payment_account_id = '00000000-0000-7000-8000-0000000510a1', transit_account_id = NULL
                         WHERE id = '00000000-0000-7000-8000-0000000510f1'; SELECT 1/0$$),
          '22012 ', 'trocar para a conta da caixa tirando a passagem (o 1/0 desfaz)');

-- Rascunho que muda de caixa: a conta das parcelas passa a ser de outra caixa e exige a passagem.
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, payment_account_id)
VALUES ('00000000-0000-7000-8000-0000000510f2', '00000000-0000-7000-8000-0000000510c1', '00000000-0000-7000-8000-0000000510e3',
        'payable', 'Rascunho', '00000000-0000-7000-8000-0000000510ca', '00000000-0000-7000-8000-0000000510a1');
SELECT is(pg_temp.err($$UPDATE contracts SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-0000000510f2'$$),
          '23514 contracts_transit_account_check', 'contrato que muda de caixa revalida a conta das parcelas');
SELECT is(pg_temp.err($$UPDATE contracts SET caixa_id = '00000000-0000-7000-8000-0000000510c2',
                                             transit_account_id = '00000000-0000-7000-8000-0000000510b2'
                         WHERE id = '00000000-0000-7000-8000-0000000510f2'; SELECT 1/0$$),
          '22012 ', 'muda de caixa com a passagem da nova caixa');

-- Parcelas: conta prevista ----------------------------------------------------------------------------------------
UPDATE contracts SET status = 'active' WHERE id = '00000000-0000-7000-8000-0000000510f1';
INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
VALUES ('00000000-0000-7000-8000-0000000510d1', '00000000-0000-7000-8000-0000000510f1', 1, '2026-01-01', 12, 'monthly',
        1200000, 10),
       ('00000000-0000-7000-8000-0000000510d2', '00000000-0000-7000-8000-0000000510f1', 2, '2027-01-01', 12, 'monthly',
        1200000, 10);

CREATE FUNCTION pg_temp.parcel(p_n int, p_planned text, p_transit text, p_status text DEFAULT 'open') RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    $f$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                           amount_cents, status, origin, contract_id, contract_cycle_id, contract_installment,
                           planned_account_id, planned_transit_account_id)
       VALUES (%L, '00000000-0000-7000-8000-0000000510c1', 'payable', '00000000-0000-7000-8000-0000000510e3',
               '00000000-0000-7000-8000-0000000510ca', %L, %L, %L, 100000, %L, 'contract',
               '00000000-0000-7000-8000-0000000510f1', '00000000-0000-7000-8000-0000000510d1', %s, %L, %L)$f$,
    ('00000000-0000-7000-8000-0000000511' || lpad(p_n::text, 2, '0'))::uuid, 'Aluguel ' || p_n || '/12',
    (date '2026-01-01' + make_interval(months => p_n - 1))::date,
    (date '2026-01-10' + make_interval(months => p_n - 1))::date, p_status, p_n, p_planned, p_transit)
$$;

SELECT is(pg_temp.err(pg_temp.parcel(1, '00000000-0000-7000-8000-0000000510b1', NULL)),
          '23514 titles_planned_transit_account_check', 'prevista de outra caixa exige a passagem');
SELECT is(pg_temp.err(pg_temp.parcel(1, '00000000-0000-7000-8000-0000000510a2', NULL)),
          '23514 titles_planned_account_check', 'cofre não é conta prevista');
SELECT is(pg_temp.err(pg_temp.parcel(1, '00000000-0000-7000-8000-0000000510a1', '00000000-0000-7000-8000-0000000510a2')),
          '23514 titles_planned_transit_account_check', 'prevista da própria caixa não tem passagem');
SELECT is(pg_temp.err(pg_temp.parcel(1, NULL, '00000000-0000-7000-8000-0000000510a2')),
          '23514 titles_planned_transit_account_check', 'passagem sem conta prevista');
SELECT is(pg_temp.err(pg_temp.parcel(1, '00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510b2')),
          '23514 titles_planned_transit_account_check', 'a passagem é da caixa do título');

SELECT lives_ok(pg_temp.parcel(1, '00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a2'),
                'parcela 1: prevista na Empresa, passagem no cofre da Casa');
SELECT lives_ok(pg_temp.parcel(2, '00000000-0000-7000-8000-0000000510a1', NULL), 'parcela 2: prevista na corrente da Casa');
SELECT lives_ok(pg_temp.parcel(3, '00000000-0000-7000-8000-0000000510a1', NULL), 'parcela 3');
SELECT lives_ok(pg_temp.parcel(4, NULL, NULL), 'parcela 4: sem conta prevista');
SELECT lives_ok(pg_temp.parcel(5, '00000000-0000-7000-8000-0000000510a1', NULL, 'canceled'), 'parcela 5: cancelada');
SELECT is((SELECT planned_account_custom FROM titles WHERE id = '00000000-0000-7000-8000-000000051101'), false,
          'a parcela segue o contrato por padrão');

-- A aplicação troca a conta de uma parcela (o trigger roda como ela).
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$UPDATE titles SET planned_account_id = '00000000-0000-7000-8000-0000000510a3', planned_account_custom = true
                   WHERE id = '00000000-0000-7000-8000-000000051104'$$, 'a aplicação troca a conta prevista da parcela');
SELECT throws_ok($$UPDATE titles SET planned_account_id = '00000000-0000-7000-8000-0000000510b1'
                    WHERE id = '00000000-0000-7000-8000-000000051104'$$, '23514', NULL,
                  'a aplicação recebe o erro da passagem');
RESET ROLE;

-- Título manual que muda de caixa revalida a conta prevista.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    planned_account_id)
VALUES ('00000000-0000-7000-8000-0000000511a1', '00000000-0000-7000-8000-0000000510c1', 'payable',
        '00000000-0000-7000-8000-0000000510e3', '00000000-0000-7000-8000-0000000510ca', 'Avulso', '2026-05-01', '2026-05-10',
        5000, '00000000-0000-7000-8000-0000000510a1');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-0000000511a1'$$),
          '23514 titles_planned_transit_account_check', 'título que muda de caixa: a prevista ficou de outra caixa');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = '00000000-0000-7000-8000-0000000510c2',
                                          planned_account_id = '00000000-0000-7000-8000-0000000510b1'
                         WHERE id = '00000000-0000-7000-8000-0000000511a1'; SELECT 1/0$$),
          '22012 ', 'muda de caixa trocando a prevista junto');

-- Conta referenciada não muda de caixa nem vira cofre (antes de ter histórico) -----------------------------------
SELECT is(pg_temp.err($$UPDATE financial_accounts SET kind = 'cash' WHERE id = '00000000-0000-7000-8000-0000000510b1'$$),
          '23514 contracts_payment_account_check', 'conta das parcelas não vira cofre');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET kind = 'cash' WHERE id = '00000000-0000-7000-8000-0000000510a3'$$),
          '23514 titles_planned_account_check', 'conta prevista não vira cofre');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000510c1'
                         WHERE id = '00000000-0000-7000-8000-0000000510b1'$$),
          '23514 contracts_payment_account_check', 'conta das parcelas não muda de caixa');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-0000000510a2'$$),
          '23514 contracts_transit_account_check', 'conta de passagem não muda de caixa');
SELECT is(pg_temp.err($$UPDATE contracts SET payment_account_id = NULL, transit_account_id = NULL
                         WHERE id = '00000000-0000-7000-8000-0000000510f1';
                       UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000510c2'
                         WHERE id = '00000000-0000-7000-8000-0000000510a2'$$),
          '23514 titles_planned_transit_account_check', 'passagem prevista de uma parcela também não muda de caixa');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET kind = 'savings' WHERE id = '00000000-0000-7000-8000-0000000510b1';
                       SELECT 1/0$$), '22012 ', 'corrente vira poupança (continua aceita)');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET name = 'Outro nome', archived_at = now()
                         WHERE id = '00000000-0000-7000-8000-0000000510b1'; SELECT 1/0$$), '22012 ',
          'renomear e arquivar continuam livres');
SELECT is(pg_temp.err($$DELETE FROM financial_accounts WHERE id = '00000000-0000-7000-8000-0000000510a3'$$),
          '23503 titles_planned_account_id_fkey', 'conta prevista não é excluída (RESTRICT)');

-- Baixas e linhas -------------------------------------------------------------------------------------------------
-- P1 (venc. 10/01) paga em 15/01 pela Empresa: baixa no cofre de passagem com multa e juros, e a transferência.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, fine_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000512a1', '00000000-0000-7000-8000-000000051101', '2026-01-15', 100000, 166, 2000,
   '00000000-0000-7000-8000-0000000510a2');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000510a2', '2026-01-15', -102166, 'settlement', '00000000-0000-7000-8000-0000000512a1');
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000513a1', '00000000-0000-7000-8000-0000000510b1', '00000000-0000-7000-8000-0000000510a2',
   102166, '2026-01-15', '00000000-0000-7000-8000-0000000512a1');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  ('00000000-0000-7000-8000-0000000514b1', '00000000-0000-7000-8000-0000000510b1', '2026-01-15', -102166, 'transfer',
   '00000000-0000-7000-8000-0000000513a1'),
  ('00000000-0000-7000-8000-0000000514a2', '00000000-0000-7000-8000-0000000510a2', '2026-01-15', 102166, 'transfer',
   '00000000-0000-7000-8000-0000000513a1');

-- P2 (venc. 10/02) paga em 08/02 na corrente da Casa com desconto, à mão.
INSERT INTO settlements (id, title_id, settled_on, amount_cents, discount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000512a2', '00000000-0000-7000-8000-000000051102', '2026-02-08', 100000, 5000,
   '00000000-0000-7000-8000-0000000510a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000510a1', '2026-02-08', -95000, 'settlement', '00000000-0000-7000-8000-0000000512a2');

-- P3 (venc. 10/03) parcial em 12/03, conciliada com uma linha que já existia (sem created_entry).
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000512a3', '00000000-0000-7000-8000-000000051103', '2026-03-12', 40000,
   '00000000-0000-7000-8000-0000000510a1');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000514a3', '00000000-0000-7000-8000-0000000510a1', '2026-03-12', -40000, 'settlement',
   '00000000-0000-7000-8000-0000000512a3');

-- P4 (venc. 10/04) com uma baixa estornada (não conta).
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000512a4', '00000000-0000-7000-8000-000000051104', '2026-03-01', 20000,
   '00000000-0000-7000-8000-0000000510a1');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000510a1', '2026-03-01', -20000, 'settlement', '00000000-0000-7000-8000-0000000512a4');
UPDATE settlements SET reversed_at = now(), reversal_reason = 'lançada errada' WHERE id = '00000000-0000-7000-8000-0000000512a4';
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000510a1', '2026-03-02', 20000, 'settlement', '00000000-0000-7000-8000-0000000512a4');

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
SELECT lives_ok($$SELECT pg_temp.commit_check()$$, 'baixas, transferências e movimentos coerentes no COMMIT');

INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000515a7', 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1', 'ofx',
   '00000000-0000-7000-8000-0000000515a7', '2026-01-01', '2026-01-31'),
  ('00000000-0000-7000-8000-0000000515a1', '00000000-0000-7000-8000-0000000510a1', 'ofx',
   '00000000-0000-7000-8000-0000000515a7', '2026-03-01', '2026-03-31');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash) VALUES
  ('00000000-0000-7000-8000-0000000516b1', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   1, '2026-01-15', -102166, 'PIX ALUGUEL', 'h1'),
  ('00000000-0000-7000-8000-0000000516b2', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   2, '2026-01-20', -300, 'TRANSF', 'h2'),
  ('00000000-0000-7000-8000-0000000516b3', '00000000-0000-7000-8000-0000000515b1', '00000000-0000-7000-8000-0000000510b1',
   3, '2026-01-21', -500, 'TARIFA', 'h3'),
  ('00000000-0000-7000-8000-0000000516a3', '00000000-0000-7000-8000-0000000515a1', '00000000-0000-7000-8000-0000000510a1',
   1, '2026-03-12', -40000, 'ALUGUEL PARCIAL', 'h1');

-- created_entry transfer_settlement e auto_settled.
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
          '23514 statement_lines_auto_settled_check', 'auto_settled só numa baixa criada pela linha');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                                   movement_id = '00000000-0000-7000-8000-0000000514b9', auto_settled = true
                         WHERE id = '00000000-0000-7000-8000-0000000516b2'$$),
          '23514 statement_lines_auto_settled_check', 'auto_settled exige created_entry');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                             movement_id = '00000000-0000-7000-8000-0000000514b1',
                                             created_entry = 'transfer_settlement', auto_settled = true
                   WHERE id = '00000000-0000-7000-8000-0000000516b1'$$,
                'a linha da Empresa concilia a perna da transferência da baixa, automática');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', matched_at = now(),
                                             movement_id = '00000000-0000-7000-8000-0000000514a3'
                   WHERE id = '00000000-0000-7000-8000-0000000516a3'$$, 'a parcial casada com um lançamento que já existia');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'new', matched_at = NULL, movement_id = NULL, created_entry = NULL
                         WHERE id = '00000000-0000-7000-8000-0000000516b1'$$),
          '23514 statement_lines_auto_settled_check', 'desfazer sem limpar auto_settled é recusado');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'new', matched_at = NULL, movement_id = NULL, created_entry = NULL,
                                                   auto_settled = false
                         WHERE id = '00000000-0000-7000-8000-0000000516b1'; SELECT 1/0$$), '22012 ',
          'desfazer limpando as duas marcas');
SELECT is(pg_temp.err($$UPDATE statement_lines SET created_entry = 'settlement' WHERE id = '00000000-0000-7000-8000-0000000516a3';
                       SELECT 1/0$$), '22012 ', 'settlement continua aceito como antes');

-- contract_payments ---------------------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT title_id, cycle_seq, installment, installments_count, status, settled_cents, open_cents, interest_cents,
           fine_cents, discount_cents, cash_cents, settlement_count, last_settled_on, paid_on, days, overdue
      FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-03-20')$$,
  $$VALUES ('00000000-0000-7000-8000-000000051101'::uuid, 1, 1, 12, 'paid', 100000::bigint, 0::bigint, 166::bigint,
            2000::bigint, 0::bigint, 102166::bigint, 1, date '2026-01-15', date '2026-01-15', 5, false),
           ('00000000-0000-7000-8000-000000051102'::uuid, 1, 2, 12, 'paid', 100000, 0, 0, 0, 5000, 95000, 1,
            date '2026-02-08', date '2026-02-08', -2, false),
           ('00000000-0000-7000-8000-000000051103'::uuid, 1, 3, 12, 'partial', 40000, 60000, 0, 0, 0, 40000, 1,
            date '2026-03-12', NULL::date, 10, true),
           ('00000000-0000-7000-8000-000000051104'::uuid, 1, 4, 12, 'open', 0, 100000, 0, 0, 0, 0, 0,
            NULL::date, NULL::date, NULL::int, false)$$,
  'parcelas não canceladas, com as baixas ativas, a data que quitou e os dias (+ atraso, − adiantamento, aberta vencida até hoje)');

SELECT results_eq(
  $$SELECT account_id, funding_account_id, last_origin, planned_account_id, planned_transit_account_id, planned_account_custom
      FROM contract_payments('00000000-0000-7000-8000-0000000510f1', '00000000-0000-7000-8000-0000000510d1', '2026-03-20')$$,
  $$VALUES ('00000000-0000-7000-8000-0000000510a2'::uuid, '00000000-0000-7000-8000-0000000510b1'::uuid, 'auto',
            '00000000-0000-7000-8000-0000000510b1'::uuid, '00000000-0000-7000-8000-0000000510a2'::uuid, false),
           ('00000000-0000-7000-8000-0000000510a1'::uuid, NULL::uuid, 'manual',
            '00000000-0000-7000-8000-0000000510a1'::uuid, NULL::uuid, false),
           ('00000000-0000-7000-8000-0000000510a1'::uuid, NULL::uuid, 'manual',
            '00000000-0000-7000-8000-0000000510a1'::uuid, NULL::uuid, false),
           (NULL::uuid, NULL::uuid, NULL::text, '00000000-0000-7000-8000-0000000510a3'::uuid, NULL::uuid, true)$$,
  'conta da baixa, a conta da outra caixa que pagou, a origem e a conta prevista');

SELECT is((SELECT settlements FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-03-20')
            WHERE installment = 1),
          jsonb_build_array(jsonb_build_object(
            'id', '00000000-0000-7000-8000-0000000512a1', 'settled_on', '2026-01-15', 'amount_cents', 100000,
            'interest_cents', 166, 'fine_cents', 2000, 'discount_cents', 0, 'cash_cents', 102166,
            'financial_account_id', '00000000-0000-7000-8000-0000000510a2',
            'transfer_id', '00000000-0000-7000-8000-0000000513a1',
            'funding_account_id', '00000000-0000-7000-8000-0000000510b1',
            'statement_line_id', '00000000-0000-7000-8000-0000000516b1', 'reconciled', true, 'origin', 'auto', 'days', 5)),
          'a baixa repartida, com a transferência e a linha que a criou');
SELECT is((SELECT settlements -> 0 ->> 'reconciled' || '/' || (settlements -> 0 ->> 'origin')
             FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-03-20') WHERE installment = 3),
          'true/manual', 'conciliada com um lançamento que já existia continua manual');
SELECT is((SELECT settlements FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-03-20')
            WHERE installment = 4), '[]'::jsonb, 'baixa estornada não aparece');

UPDATE statement_lines SET auto_settled = false WHERE id = '00000000-0000-7000-8000-0000000516b1';
SELECT is((SELECT last_origin FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-03-20')
            WHERE installment = 1), 'reconciliation', 'criada pela linha sem a marca automática = conciliação');

SELECT is((SELECT days FROM contract_payments('00000000-0000-7000-8000-0000000510f1', NULL, '2026-04-25')
            WHERE installment = 4), 15, 'em aberto: atraso até hoje');
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-0000000510f1',
                                                       '00000000-0000-7000-8000-0000000510d2', '2026-03-20')), 0,
          'filtro do ciclo (o segundo não tem parcelas)');
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-0000000510f2')), 0,
          'outro contrato, hoje padrão');
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-0000000510f1')), 4,
          'p_today padrão (hoje em São Paulo)');

SET LOCAL ROLE moneyflow_app;
SELECT is((SELECT count(*)::int FROM contract_payments('00000000-0000-7000-8000-0000000510f1')), 4,
          'a aplicação lê com o papel dela');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
