-- Testes de 0057_balance_queries (tarefas 092, 093, 130 e 131): índice de cobertura dos movimentos, saldo do lote
-- calculado uma vez com a divergência do intervalo, title_balances pelo status, saldo de hoje da conta, previsto da conta
-- no calendário e a projeção com o filtro indexável.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT ok(indexdef ~ '\(financial_account_id, occurred_on\) INCLUDE \(amount_cents\)', 'movimentos: índice por conta e data cobre o valor')
  FROM pg_indexes WHERE indexname = 'movements_financial_account_id_occurred_on_idx';
SELECT has_function('account_daily_balances', ARRAY['uuid', 'date', 'date', 'date']);
SELECT hasnt_function('account_daily_balances', ARRAY['uuid', 'date', 'date']);
SELECT ok(has_function_privilege('moneyflow_app', 'account_daily_balances(uuid, date, date, date)', 'EXECUTE'),
          'app executa account_daily_balances');
SELECT ok(NOT has_function_privilege('public', 'account_daily_balances(uuid, date, date, date)', 'EXECUTE'),
          'PUBLIC não executa account_daily_balances');
SELECT is((SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
            WHERE attrelid = 'financial_account_balances'::regclass AND attnum > 0),
          ARRAY['financial_account_id', 'caixa_id', 'opening_date', 'opening_balance_cents', 'movements_cents',
                'balance_cents', 'archived_at', 'balance_today_cents'],
          'financial_account_balances: balance_today_cents no fim');
SELECT is((SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
            WHERE attrelid = 'statement_import_balances'::regclass AND attnum > 0),
          ARRAY['statement_import_id', 'financial_account_id', 'card_caixa_id', 'period_start', 'period_end',
                'bank_balance_on', 'bank_balance_cents', 'app_balance_cents', 'difference_cents', 'lines', 'matched_lines',
                'suggested_lines', 'new_lines', 'ignored_lines', 'provisional', 'superseded', 'interval_difference_cents'],
          'statement_import_balances: interval_difference_cents no fim');
SELECT ok(has_table_privilege('moneyflow_app', v, 'SELECT'), 'app lê ' || v)
  FROM unnest(ARRAY['financial_account_balances', 'statement_import_balances', 'title_balances']) v;
SELECT is((SELECT reloptions FROM pg_class WHERE oid = v::regclass), ARRAY['security_invoker=true'], v || ': security_invoker')
  FROM unnest(ARRAY['financial_account_balances', 'statement_import_balances', 'title_balances']) v;

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA'),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0001', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-09-01', 100000),
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0001', 'cash', 'Cofre', '2026-09-01', 0),
  ('00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-0000000c0001', 'savings', 'Poupança', '2026-10-03', 5000);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca10', 'income', 'Aluguel');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'extrato.ofx', 'application/x-ofx', '\x4f4658');

-- 130: saldo de hoje -------------------------------------------------------------------------------------------------------
-- Datas relativas a hoje em São Paulo: ontem, hoje e amanhã; a conta 4 abre amanhã.
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0004', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Futura',
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1, 7000),
  ('00000000-0000-7000-8000-0000000a0005', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Hoje',
   (now() AT TIME ZONE 'America/Sao_Paulo')::date - 10, 1000);
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000a0005', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 100, 'adjustment', 'ontem'),
  ('00000000-0000-7000-8000-0000000a0005', (now() AT TIME ZONE 'America/Sao_Paulo')::date, 20, 'adjustment', 'hoje'),
  ('00000000-0000-7000-8000-0000000a0005', (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1, -300, 'adjustment', 'amanhã'),
  ('00000000-0000-7000-8000-0000000a0004', (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2, 50, 'adjustment', 'depois');
SELECT results_eq($$SELECT movements_cents, balance_cents, balance_today_cents FROM financial_account_balances
                     WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0005'$$,
                  $$VALUES (-180::bigint, 820::bigint, 1120::bigint)$$,
                  'saldo de hoje sem o movimento de amanhã; balance_cents com todos');
SELECT results_eq($$SELECT balance_cents, balance_today_cents FROM financial_account_balances
                     WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0004'$$,
                  $$VALUES (7050::bigint, 0::bigint)$$,
                  'conta que abre amanhã: saldo de hoje 0 (sem o saldo inicial)');
SELECT is((SELECT balance_today_cents FROM financial_account_balances WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0005'),
          financial_account_balance_at('00000000-0000-7000-8000-0000000a0005', (now() AT TIME ZONE 'America/Sao_Paulo')::date),
          'saldo de hoje = financial_account_balance_at(conta, hoje)');
SELECT results_eq($$SELECT movements_cents, balance_cents, balance_today_cents FROM financial_account_balances
                     WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0002'$$,
                  $$VALUES (0::bigint, 0::bigint, 0::bigint)$$, 'conta sem movimentos');
DELETE FROM movements WHERE financial_account_id IN ('00000000-0000-7000-8000-0000000a0004', '00000000-0000-7000-8000-0000000a0005');
DELETE FROM financial_accounts WHERE id IN ('00000000-0000-7000-8000-0000000a0004', '00000000-0000-7000-8000-0000000a0005');

-- 093: title_balances pelo status ------------------------------------------------------------------------------------------
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    planned_account_id) VALUES
  -- conta prevista = Itaú (a1): pagar 300,00 em 15/10; receber 50,00 vencido em 05/10; pagar parcial 100,00 em 12/10.
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Aluguel a pagar', '2026-10-01', '2026-10-15', 30000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000c0001', 'receivable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca10', 'Aluguel a receber', '2026-10-01', '2026-10-05', 5000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Parcial', '2026-10-01', '2026-10-12', 10000, '00000000-0000-7000-8000-0000000a0001'),
  -- pago (com uma baixa estornada no meio), cancelado com baixa estornada, arquivado, sem conta prevista, em outra conta.
  ('00000000-0000-7000-8000-0000000b0004', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Pago', '2026-10-01', '2026-10-11', 8000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000b0005', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Cancelado', '2026-10-01', '2026-10-13', 7000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000b0006', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Arquivado', '2026-10-01', '2026-10-14', 6000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000b0007', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Sem conta', '2026-10-01', '2026-10-14', 4000, NULL),
  ('00000000-0000-7000-8000-0000000b0008', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'No cofre', '2026-10-01', '2026-10-14', 2000, '00000000-0000-7000-8000-0000000a0002');
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000d0003', '00000000-0000-7000-8000-0000000b0003', '2026-10-01', 4000),
  ('00000000-0000-7000-8000-0000000d0031', '00000000-0000-7000-8000-0000000b0003', '2026-10-02', 1500),
  ('00000000-0000-7000-8000-0000000d0004', '00000000-0000-7000-8000-0000000b0004', '2026-10-01', 3000),
  ('00000000-0000-7000-8000-0000000d0041', '00000000-0000-7000-8000-0000000b0004', '2026-10-02', 5000),
  ('00000000-0000-7000-8000-0000000d0005', '00000000-0000-7000-8000-0000000b0005', '2026-10-01', 7000);
UPDATE settlements SET reversed_at = now(), reversal_reason = 'teste'
 WHERE id IN ('00000000-0000-7000-8000-0000000d0031', '00000000-0000-7000-8000-0000000d0004', '00000000-0000-7000-8000-0000000d0005');
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000d0042', '00000000-0000-7000-8000-0000000b0004', '2026-10-03', 3000);
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0005';
UPDATE titles SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000b0006';
SELECT pg_temp.commit_check();

SELECT results_eq(
  $$SELECT title_id, status, settled_cents, open_cents FROM title_balances
     WHERE caixa_id = '00000000-0000-7000-8000-0000000c0001' ORDER BY title_id$$,
  $$SELECT t.id, t.status, coalesce(s.cents, 0)::bigint,
           (CASE WHEN t.status = 'canceled' THEN 0 ELSE t.amount_cents - coalesce(s.cents, 0) END)::bigint
      FROM titles t
      LEFT JOIN LATERAL (SELECT sum(x.amount_cents) AS cents FROM settlements x
                          WHERE x.title_id = t.id AND x.reversed_at IS NULL) s ON true
     WHERE t.caixa_id = '00000000-0000-7000-8000-0000000c0001' ORDER BY t.id$$,
  'title_balances pelo status = a soma das baixas ativas (aberto, parcial, pago, cancelado, estornos)');
SELECT results_eq($$SELECT status, settled_cents, open_cents FROM title_balances
                     WHERE title_id IN ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000b0004',
                                        '00000000-0000-7000-8000-0000000b0005') ORDER BY title_id$$,
                  $$VALUES ('partial', 4000::bigint, 6000::bigint), ('paid', 8000::bigint, 0::bigint),
                           ('canceled', 0::bigint, 0::bigint)$$,
                  'parcial soma só as ativas; pago depois do estorno; cancelado zera');
-- Mudar o valor do parcial acompanha (o status segue as baixas).
UPDATE titles SET amount_cents = 4000 WHERE id = '00000000-0000-7000-8000-0000000b0003';
SELECT results_eq($$SELECT status, settled_cents, open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0003'$$,
                  $$VALUES ('paid', 4000::bigint, 0::bigint)$$, 'valor reduzido ao baixado: pago');
UPDATE titles SET amount_cents = 10000 WHERE id = '00000000-0000-7000-8000-0000000b0003';
SELECT results_eq($$SELECT status, settled_cents, open_cents FROM title_balances WHERE title_id = '00000000-0000-7000-8000-0000000b0003'$$,
                  $$VALUES ('partial', 4000::bigint, 6000::bigint)$$, 'valor de volta: parcial');

-- 093: calendário da caixa com o filtro indexável (o mesmo resultado) -----------------------------------------------------------
SELECT results_eq(
  $$SELECT day, scheduled_cents FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0001', '2026-10-09', '2026-10-16', '2026-10-10')$$,
  $$VALUES ('2026-10-09'::date, 0::bigint), ('2026-10-10'::date, 5000::bigint), ('2026-10-11'::date, 5000::bigint),
           ('2026-10-12'::date, -1000::bigint), ('2026-10-13'::date, -1000::bigint), ('2026-10-14'::date, -7000::bigint),
           ('2026-10-15'::date, -37000::bigint), ('2026-10-16'::date, -37000::bigint)$$,
  'caixa: previsto só dos abertos e parciais (pago, cancelado e arquivado fora; vencido em hoje)');

-- 131: calendário da conta com o previsto pela conta prevista -------------------------------------------------------------------
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-09', -2000, 'adjustment', 'Tarifa'),
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-14', 1000, 'adjustment', 'Rendimento futuro');
SELECT results_eq(
  $$SELECT day, balance_cents, scheduled_cents, projected_cents
      FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-08', '2026-10-16', '2026-10-10')$$,
  $$VALUES ('2026-10-08'::date, 100000::bigint, 0::bigint, 100000::bigint),
           ('2026-10-09'::date, 98000::bigint, 0::bigint, 98000::bigint),
           ('2026-10-10'::date, 98000::bigint, 5000::bigint, 103000::bigint),
           ('2026-10-11'::date, 98000::bigint, 5000::bigint, 103000::bigint),
           ('2026-10-12'::date, 98000::bigint, -1000::bigint, 97000::bigint),
           ('2026-10-13'::date, 98000::bigint, -1000::bigint, 97000::bigint),
           ('2026-10-14'::date, 99000::bigint, -1000::bigint, 98000::bigint),
           ('2026-10-15'::date, 99000::bigint, -31000::bigint, 68000::bigint),
           ('2026-10-16'::date, 99000::bigint, -31000::bigint, 68000::bigint)$$,
  'conta: realizado + previsto dos títulos com a conta prevista (sem os da caixa sem conta nem os do cofre)');
SELECT results_eq(
  $$SELECT day, balance_cents, scheduled_cents, projected_cents
      FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-12', '2026-10-12', '2026-10-10')$$,
  $$VALUES ('2026-10-12'::date, 98000::bigint, -1000::bigint, 97000::bigint)$$,
  'conta: o previsto anterior ao período entra no primeiro dia');
SELECT results_eq(
  $$SELECT day, scheduled_cents FROM account_daily_balances('00000000-0000-7000-8000-0000000a0002', '2026-10-13', '2026-10-14', '2026-10-10')$$,
  $$VALUES ('2026-10-13'::date, 0::bigint), ('2026-10-14'::date, -2000::bigint)$$, 'cofre: o título previsto nele');
SELECT results_eq(
  $$SELECT day, balance_cents, scheduled_cents, projected_cents
      FROM account_daily_balances('00000000-0000-7000-8000-0000000a0003', '2026-10-02', '2026-10-03', '2026-10-01')$$,
  $$VALUES ('2026-10-02'::date, NULL::bigint, 0::bigint, NULL::bigint), ('2026-10-03'::date, 5000::bigint, 0::bigint, 5000::bigint)$$,
  'conta: NULL antes da abertura');
SELECT results_eq(
  $$SELECT day, balance_cents FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-09', '2026-10-09')$$,
  $$VALUES ('2026-10-09'::date, 98000::bigint)$$, 'chamada com três argumentos (hoje padrão) continua valendo');
SELECT is((SELECT count(*)::int FROM account_daily_balances('00000000-0000-7000-8000-00000000ffff', '2026-10-01', '2026-10-04', '2026-10-01')),
          0, 'conta inexistente: nenhuma linha');
SELECT throws_ok($$SELECT * FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-31', '2026-10-01')$$,
                 '22023', NULL, 'conta: período inválido');
SELECT throws_ok($$SELECT * FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-01', '2026-10-31', NULL)$$,
                 '22023', NULL, 'conta: hoje nulo');

-- 092 e 093: projeção (mesmos números, o saldo de hoje uma vez por conta) --------------------------------------------------------
SELECT results_eq(
  $$SELECT financial_account_id, horizon_days, balance_today_cents, scheduled_movements_cents, overdue_receivable_cents,
           overdue_payable_cents, receivable_cents, payable_cents, projected_cents
      FROM report_cash_projection(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-10', '{2,5,30}')$$,
  $$VALUES (NULL::uuid, 2, 103000::bigint, 0::bigint, 5000::bigint, 0::bigint, 5000::bigint, 6000::bigint, 102000::bigint),
           (NULL::uuid, 5, 103000::bigint, 1000::bigint, 5000::bigint, 0::bigint, 5000::bigint, 42000::bigint, 67000::bigint),
           (NULL::uuid, 30, 103000::bigint, 1000::bigint, 5000::bigint, 0::bigint, 5000::bigint, 42000::bigint, 67000::bigint),
           ('00000000-0000-7000-8000-0000000a0001'::uuid, 2, 98000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 98000::bigint),
           ('00000000-0000-7000-8000-0000000a0001'::uuid, 5, 98000::bigint, 1000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 99000::bigint),
           ('00000000-0000-7000-8000-0000000a0001'::uuid, 30, 98000::bigint, 1000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 99000::bigint),
           ('00000000-0000-7000-8000-0000000a0002'::uuid, 2, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint),
           ('00000000-0000-7000-8000-0000000a0002'::uuid, 5, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint),
           ('00000000-0000-7000-8000-0000000a0002'::uuid, 30, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint),
           ('00000000-0000-7000-8000-0000000a0003'::uuid, 2, 5000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 5000::bigint),
           ('00000000-0000-7000-8000-0000000a0003'::uuid, 5, 5000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 5000::bigint),
           ('00000000-0000-7000-8000-0000000a0003'::uuid, 30, 5000::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 5000::bigint)$$,
  'projeção: saldo de hoje, lançados, vencidos e previstos por horizonte (pago, cancelado e arquivado fora)');
SELECT ok(prosrc ~ 'accs AS MATERIALIZED', 'projeção: o saldo de hoje num CTE materializado por conta')
  FROM pg_proc WHERE oid = 'report_cash_projection(uuid[], date, integer[], uuid[])'::regprocedure;

-- 092: saldo do lote uma vez e a divergência do intervalo -----------------------------------------------------------------------
-- Lotes da corrente (Itaú, abertura 01/09, 1.000,00): L0 com saldo antes da abertura, L1, L2 (provisório substituído
-- pelo L3), L3, L4 com a mesma data do L3 (criado depois) e L5 sem saldo; a poupança tem um lote só; o cartão, um.
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-09-10', -5000, 'adjustment', 'Setembro'),
  ('00000000-0000-7000-8000-0000000a0001', '2026-09-20', 300, 'adjustment', 'Setembro 2');
INSERT INTO statement_imports (id, financial_account_id, card_caixa_id, format, attachment_id, period_start, period_end,
                               bank_balance_on, bank_balance_cents, created_at, provisional) VALUES
  ('00000000-0000-7000-8000-0000000ac000', '00000000-0000-7000-8000-0000000a0001', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-08-01', '2026-08-31', '2026-08-31', 90000, '2026-10-01 10:00-03', false),
  ('00000000-0000-7000-8000-0000000ac001', '00000000-0000-7000-8000-0000000a0001', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-09-01', '2026-09-15', '2026-09-15', 95000, '2026-10-01 10:01-03', false),
  ('00000000-0000-7000-8000-0000000ac003', '00000000-0000-7000-8000-0000000a0001', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-09-16', '2026-10-09', '2026-10-09', 93300, '2026-10-01 10:03-03', false),
  ('00000000-0000-7000-8000-0000000ac004', '00000000-0000-7000-8000-0000000a0001', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-10-09', '2026-10-09', '2026-10-09', 93000, '2026-10-01 10:04-03', false),
  ('00000000-0000-7000-8000-0000000ac005', '00000000-0000-7000-8000-0000000a0001', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-10-10', '2026-10-12', NULL, NULL, '2026-10-01 10:05-03', false),
  ('00000000-0000-7000-8000-0000000ac031', '00000000-0000-7000-8000-0000000a0003', NULL, 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-10-03', '2026-10-10', '2026-10-10', 5000, '2026-10-01 10:06-03', false),
  ('00000000-0000-7000-8000-0000000ac010', NULL, '00000000-0000-7000-8000-0000000c0010', 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-10-01', '2026-10-31', NULL, NULL, '2026-10-01 10:07-03', false);
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end, bank_balance_on,
                               bank_balance_cents, created_at, provisional, superseded_by_import_id, superseded_at) VALUES
  ('00000000-0000-7000-8000-0000000ac002', '00000000-0000-7000-8000-0000000a0001', 'ofx', '00000000-0000-7000-8000-0000000a7001',
   '2026-09-16', '2026-09-30', '2026-09-30', 1, '2026-10-01 10:02-03', true, '00000000-0000-7000-8000-0000000ac003', now());
SELECT pg_temp.commit_check();

-- Referência: a fórmula de antes (saldo do app por lote e a divergência do anterior, pela mesma ordem).
CREATE TEMP TABLE expected_balances AS
SELECT i.id, f.app,
       i.bank_balance_cents - f.app AS diff,
       (i.bank_balance_cents - f.app) - (
         SELECT p.bank_balance_cents - financial_account_balance_at(p.financial_account_id, p.bank_balance_on)
           FROM statement_imports p
          WHERE p.financial_account_id = i.financial_account_id AND p.bank_balance_on IS NOT NULL
            AND p.superseded_by_import_id IS NULL
            AND (p.bank_balance_on, p.created_at) < (i.bank_balance_on, i.created_at)
          ORDER BY p.bank_balance_on DESC, p.created_at DESC LIMIT 1) AS interval_diff
  FROM statement_imports i
  CROSS JOIN LATERAL (SELECT CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
                                  THEN financial_account_balance_at(i.financial_account_id, i.bank_balance_on) END AS app) f;
SELECT results_eq($$SELECT statement_import_id, app_balance_cents, difference_cents, interval_difference_cents
                      FROM statement_import_balances ORDER BY statement_import_id$$,
                  $$SELECT id, app, diff, interval_diff FROM expected_balances ORDER BY id$$,
                  'saldo, divergência e divergência do intervalo iguais à fórmula de antes');
SELECT results_eq($$SELECT statement_import_id, app_balance_cents, difference_cents, interval_difference_cents
                      FROM statement_import_balances ORDER BY statement_import_id$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000ac000'::uuid, NULL::bigint, NULL::bigint, NULL::bigint),
                           ('00000000-0000-7000-8000-0000000ac001'::uuid, 95000::bigint, 0::bigint, NULL::bigint),
                           ('00000000-0000-7000-8000-0000000ac002'::uuid, 95300::bigint, -95299::bigint, -95299::bigint),
                           ('00000000-0000-7000-8000-0000000ac003'::uuid, 93300::bigint, 0::bigint, 0::bigint),
                           ('00000000-0000-7000-8000-0000000ac004'::uuid, 93300::bigint, -300::bigint, -300::bigint),
                           ('00000000-0000-7000-8000-0000000ac005'::uuid, NULL::bigint, NULL::bigint, NULL::bigint),
                           ('00000000-0000-7000-8000-0000000ac010'::uuid, NULL::bigint, NULL::bigint, NULL::bigint),
                           ('00000000-0000-7000-8000-0000000ac031'::uuid, 5000::bigint, 0::bigint, NULL::bigint)$$,
                  'antes da abertura, primeiro lote, substituído fora do anterior, mesma data pela criação, sem saldo, cartão');

-- Uma soma de saldo por lote, lendo saldo, divergência e intervalo.
SET LOCAL track_functions = 'all';
CREATE TEMP TABLE calls_before AS
SELECT coalesce(pg_stat_get_xact_function_calls('financial_account_balance_at(uuid, date)'::regprocedure), 0) AS n;
CREATE TEMP TABLE read_all AS
SELECT app_balance_cents, difference_cents, interval_difference_cents, app_balance_cents - difference_cents AS again
  FROM statement_import_balances WHERE financial_account_id = '00000000-0000-7000-8000-0000000a0001';
SELECT is((SELECT coalesce(pg_stat_get_xact_function_calls('financial_account_balance_at(uuid, date)'::regprocedure), 0) - n
             FROM calls_before), 5::bigint,
          'uma soma de saldo por lote com saldo (L0..L4; nenhuma no L5), nenhuma a mais para a divergência e o intervalo');

-- Privilégios: a aplicação lê as visões --------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT * FROM statement_import_balances$$, 'app lê statement_import_balances');
SELECT lives_ok($$SELECT * FROM financial_account_balances$$, 'app lê financial_account_balances');
SELECT lives_ok($$SELECT * FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-01', '2026-10-31')$$,
                'app consulta account_daily_balances');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
