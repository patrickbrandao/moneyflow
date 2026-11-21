-- Testes de 0058_query_performance (tarefas 144, 146 e 147): contract_payments acha a linha conciliada de cada baixa por
-- dois ramos indexáveis (sem mudar a origem), o canvas não materializa os títulos de todas as datas e os índices novos
-- (trigram na descrição dos títulos, compras por pagadora e data, espelhos pendentes).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;
-- Plano de uma consulta em texto. Sem p_seqscan, desliga as varreduras sequenciais (as tabelas do teste são pequenas
-- e o planejador as preferiria a qualquer índice).
CREATE FUNCTION pg_temp.plan(p_sql text, p_seqscan boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r   record;
  acc text := '';
BEGIN
  IF NOT p_seqscan THEN
    SET LOCAL enable_seqscan = off;
  END IF;
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || p_sql LOOP
    acc := acc || r."QUERY PLAN" || E'\n';
  END LOOP;
  RESET enable_seqscan;
  RETURN acc;
END
$$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000058' || p)::uuid $$;

-- Estrutura (147) ---------------------------------------------------------------------------------------------------------
SELECT has_index('titles', 'titles_description_trgm_idx');
SELECT ok(indexdef ~ 'USING gin \(description (public\.)?gin_trgm_ops\)', 'títulos: trigram na descrição')
  FROM pg_indexes WHERE indexname = 'titles_description_trgm_idx';
SELECT has_index('titles', 'titles_mirror_pending_idx');
SELECT ok(indexdef ~ '\(caixa_id\) WHERE \(mirror_status = ''pending''::text\)', 'títulos: espelhos pendentes por caixa')
  FROM pg_indexes WHERE indexname = 'titles_mirror_pending_idx';
SELECT has_index('card_purchases', 'card_purchases_payer_caixa_id_purchased_on_idx');
SELECT ok(indexdef ~ '\(payer_caixa_id, purchased_on\)', 'compras: pagadora e data')
  FROM pg_indexes WHERE indexname = 'card_purchases_payer_caixa_id_purchased_on_idx';
SELECT hasnt_index('card_purchases', 'card_purchases_payer_caixa_id_idx');
SELECT ok(prosrc ~ 'title_ends AS NOT MATERIALIZED', 'canvas: title_ends não é materializado')
  FROM pg_proc WHERE oid = 'flow_graph_lines(uuid[], date, date)'::regprocedure;

-- Dados base ---------------------------------------------------------------------------------------------------------------
-- Casa (C1, Patrick) e Empresa (C2); contrato K da Casa com a Imobiliária; contas corrente da Casa (A1) e da Empresa (B1).
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Minha Empresa'),
  (pg_temp.u('e003'), 'company', 'Imobiliária'), (pg_temp.u('e004'), 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true),
  (pg_temp.u('c002'), 'Empresa', 'general', pg_temp.u('e002'), true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  (pg_temp.u('c010'), 'Nubank', 'credit_card', pg_temp.u('e004'), pg_temp.u('c001'), 500000, 3, 10, '1111');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  (pg_temp.u('a001'), pg_temp.u('c001'), 'checking', 'Corrente Casa', '2026-01-01'),
  (pg_temp.u('b001'), pg_temp.u('c002'), 'checking', 'Corrente Empresa', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES
  (pg_temp.u('ca01'), 'expense', 'Aluguel 58'), (pg_temp.u('ca02'), 'income', 'Receita 58');
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, status, starts_on) VALUES
  (pg_temp.u('f001'), pg_temp.u('c001'), pg_temp.u('e003'), 'payable', 'Aluguel', pg_temp.u('ca01'), 'active', '2026-01-01');

-- 144: as baixas do contrato e as linhas que as conciliam ------------------------------------------------------------------
-- T1 com linha automática; T2 com linha casada sem lançamento criado; T3 sem conta; T4 com a transferência da Empresa
-- (histórico transfer_settlement, a linha na perna da transferência); T5 espelhado na Empresa, com a linha na perna do
-- espelho; T6 com a linha só sugerida (não conta).
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    contract_id) VALUES
  (pg_temp.u('7001'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'T1', '2026-01-01', '2026-01-10', 1000, pg_temp.u('f001')),
  (pg_temp.u('7002'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'T2', '2026-02-01', '2026-02-10', 1000, pg_temp.u('f001')),
  (pg_temp.u('7003'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'T3', '2026-03-01', '2026-03-10', 1000, pg_temp.u('f001')),
  (pg_temp.u('7004'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'T4', '2026-04-01', '2026-04-10', 1000, pg_temp.u('f001')),
  (pg_temp.u('7006'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'T6', '2026-06-01', '2026-06-10', 1000, pg_temp.u('f001'));
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    contract_id, counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  (pg_temp.u('7005'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'T5', '2026-05-01', '2026-05-10', 1000,
   pg_temp.u('f001'), pg_temp.u('c002'), pg_temp.u('7905'), NULL),
  (pg_temp.u('7905'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'T5', '2026-05-01', '2026-05-10', 1000,
   pg_temp.u('f001'), pg_temp.u('c001'), pg_temp.u('7005'), 'accepted');
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id, mirror_settlement_id) VALUES
  (pg_temp.u('d001'), pg_temp.u('7001'), '2026-01-12', 1000, pg_temp.u('a001'), NULL),
  (pg_temp.u('d002'), pg_temp.u('7002'), '2026-02-09', 1000, pg_temp.u('a001'), NULL),
  (pg_temp.u('d003'), pg_temp.u('7003'), '2026-03-10', 1000, NULL, NULL),
  (pg_temp.u('d004'), pg_temp.u('7004'), '2026-04-10', 1000, pg_temp.u('a001'), NULL),
  (pg_temp.u('d006'), pg_temp.u('7006'), '2026-06-10', 1000, pg_temp.u('a001'), NULL),
  (pg_temp.u('d005'), pg_temp.u('7005'), '2026-05-10', 1000, NULL, pg_temp.u('d905')),
  (pg_temp.u('d905'), pg_temp.u('7905'), '2026-05-10', 1000, pg_temp.u('b001'), pg_temp.u('d005'));
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  (pg_temp.u('6001'), pg_temp.u('a001'), '2026-01-12', -1000, 'settlement', pg_temp.u('d001')),
  (pg_temp.u('6002'), pg_temp.u('a001'), '2026-02-09', -1000, 'settlement', pg_temp.u('d002')),
  (pg_temp.u('6004'), pg_temp.u('a001'), '2026-04-10', -1000, 'settlement', pg_temp.u('d004')),
  (pg_temp.u('6006'), pg_temp.u('a001'), '2026-06-10', -1000, 'settlement', pg_temp.u('d006')),
  (pg_temp.u('6905'), pg_temp.u('b001'), '2026-05-10', 1000, 'settlement', pg_temp.u('d905'));
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on, settlement_id) VALUES
  (pg_temp.u('aa04'), pg_temp.u('b001'), pg_temp.u('a001'), 1000, '2026-04-10', pg_temp.u('d004'));
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  (pg_temp.u('6014'), pg_temp.u('b001'), '2026-04-10', -1000, 'transfer', pg_temp.u('aa04')),
  (pg_temp.u('6024'), pg_temp.u('a001'), '2026-04-10', 1000, 'transfer', pg_temp.u('aa04'));
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  (pg_temp.u('ff01'), 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  (pg_temp.u('ab01'), pg_temp.u('a001'), 'ofx', pg_temp.u('ff01'), '2026-01-01', '2026-06-30'),
  (pg_temp.u('ab02'), pg_temp.u('b001'), 'ofx', pg_temp.u('ff01'), '2026-01-01', '2026-06-30');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at, created_entry, auto_settled) VALUES
  (pg_temp.u('1001'), pg_temp.u('ab01'), pg_temp.u('a001'), 1, '2026-01-12', -1000, 'ALUGUEL 1', 'h1', 'matched',
   pg_temp.u('6001'), now(), 'settlement', true),
  (pg_temp.u('1002'), pg_temp.u('ab01'), pg_temp.u('a001'), 2, '2026-02-09', -1000, 'ALUGUEL 2', 'h2', 'matched',
   pg_temp.u('6002'), now(), NULL, false),
  (pg_temp.u('1004'), pg_temp.u('ab02'), pg_temp.u('b001'), 1, '2026-04-10', -1000, 'ALUGUEL 4', 'h4', 'matched',
   pg_temp.u('6014'), now(), 'transfer_settlement', false),
  (pg_temp.u('1005'), pg_temp.u('ab02'), pg_temp.u('b001'), 2, '2026-05-10', 1000, 'ALUGUEL 5', 'h5', 'matched',
   pg_temp.u('6905'), now(), 'settlement', false),
  (pg_temp.u('1006'), pg_temp.u('ab01'), pg_temp.u('a001'), 3, '2026-06-10', -1000, 'ALUGUEL 6', 'h6', 'suggested',
   pg_temp.u('6006'), NULL, NULL, false);
SELECT lives_ok($$SELECT pg_temp.commit_check()$$, 'contrato, baixas, transferência, espelho e linhas coerentes no COMMIT');

SELECT results_eq(
  $$SELECT p.title_id, s->>'statement_line_id', s->>'origin', (s->>'reconciled')::boolean, s->>'transfer_id',
           s->>'funding_account_id', p.last_origin
      FROM contract_payments(pg_temp.u('f001'), NULL, NULL, '2026-07-01') p
      CROSS JOIN LATERAL jsonb_array_elements(p.settlements) s
     ORDER BY p.due_date$$,
  $$VALUES (pg_temp.u('7001'), pg_temp.u('1001')::text, 'auto', true, NULL::text, NULL::text, 'auto'),
           (pg_temp.u('7002'), pg_temp.u('1002')::text, 'manual', true, NULL, NULL, 'manual'),
           (pg_temp.u('7003'), NULL, 'manual', false, NULL, NULL, 'manual'),
           (pg_temp.u('7004'), pg_temp.u('1004')::text, 'reconciliation', true, pg_temp.u('aa04')::text,
            pg_temp.u('b001')::text, 'reconciliation'),
           (pg_temp.u('7005'), pg_temp.u('1005')::text, 'reconciliation', true, NULL, NULL, 'reconciliation'),
           (pg_temp.u('7006'), NULL, 'manual', false, NULL, NULL, 'manual')$$,
  'contract_payments: linha pela baixa, pela perna da transferência e pela do espelho; sugerida não conta');
SELECT is((SELECT count(*)::int FROM contract_payments(pg_temp.u('f001'))), 6, 'só o lado do contrato (sem o espelho)');

-- Duas linhas casadas com a mesma baixa (a da baixa e a da transferência): a automática vence, depois a com lançamento.
UPDATE statement_lines SET status = 'new', movement_id = NULL, matched_at = NULL, created_entry = NULL
 WHERE id = pg_temp.u('1004');
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at, created_entry, auto_settled) VALUES
  (pg_temp.u('1014'), pg_temp.u('ab01'), pg_temp.u('a001'), 4, '2026-04-10', -1000, 'ALUGUEL 4 BAIXA', 'h14', 'matched',
   pg_temp.u('6004'), now() - interval '1 hour', NULL, false),
  (pg_temp.u('1024'), pg_temp.u('ab02'), pg_temp.u('b001'), 3, '2026-04-10', -1000, 'ALUGUEL 4 TRANSF', 'h24', 'matched',
   pg_temp.u('6014'), now(), 'transfer_settlement', false);
SELECT pg_temp.commit_check();
SELECT is((SELECT s->>'statement_line_id' FROM contract_payments(pg_temp.u('f001')) p
            CROSS JOIN LATERAL jsonb_array_elements(p.settlements) s WHERE p.title_id = pg_temp.u('7004')),
          pg_temp.u('1024')::text, 'desempate: a linha com lançamento criado vence a casada antes, mesmo de outro ramo');
-- Plano com volume: 1.500 linhas conciliadas de outros lançamentos. Os dois ramos partem da baixa (movimento da baixa
-- ou do espelho; perna da transferência dela) e acham a linha pelo movimento, sem ler as linhas conciliadas do sistema.
WITH mv AS (
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description)
  SELECT pg_temp.u('a001'), '2026-01-01'::date + (g % 150), -g, 'adjustment', 'volume' FROM generate_series(1, 1500) g
  RETURNING id, occurred_on, amount_cents)
INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at)
SELECT pg_temp.u('ab01'), pg_temp.u('a001'), 100 + row_number() OVER (), occurred_on, amount_cents, 'volume', 'v' || id,
       'matched', id, now()
  FROM mv;
ANALYZE movements, statement_lines, transfers, settlements, titles;
CREATE TEMP TABLE cp_plan AS
SELECT pg_temp.plan($$SELECT * FROM contract_payments('00000000-0000-7000-8000-00000058f001')$$, true) AS p;
SELECT ok(p ~ 'movements_settlement_id_idx on movements \w+\n\s+Index Cond: \(settlement_id = ANY',
          'contract_payments: a linha pela baixa parte de movements.settlement_id') FROM cp_plan;
SELECT ok(p ~ 'movements_transfer_id_idx on movements \w+\n\s+Index Cond: \(transfer_id = ANY',
          'contract_payments: a linha pela transferência parte da transferência da baixa') FROM cp_plan;
SELECT ok(p !~ 'OR \(ANY \(transfer_id',
          'contract_payments: sem o OR com subconsulta sobre as linhas conciliadas') FROM cp_plan;
SELECT is((SELECT count(*)::int FROM contract_payments(pg_temp.u('f001'))), 6, 'com volume: o mesmo contrato');

-- 146: o canvas de um mês não traz o título antigo pago fora do período ------------------------------------------------------
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  (pg_temp.u('7099'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'Antigo', '2025-01-01', '2025-01-10', 500),
  (pg_temp.u('7098'), pg_temp.u('c001'), 'payable', pg_temp.u('e003'), pg_temp.u('ca01'), 'Aberto em abril', '2026-04-01', '2026-04-20', 700);
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES (pg_temp.u('d099'), pg_temp.u('7099'), '2025-01-10', 500);
SELECT pg_temp.commit_check();
SELECT results_eq(
  $$SELECT ref_kind, ref_id, realized_cents, forecast_cents
      FROM flow_graph_lines(ARRAY[pg_temp.u('c001')], '2026-04-01', '2026-04-30') ORDER BY ref_kind, ref_id$$,
  $$VALUES ('settlement', pg_temp.u('d004'), 1000::bigint, 0::bigint), ('title', pg_temp.u('7098'), 0::bigint, 700::bigint),
           ('transfer', pg_temp.u('aa04'), 1000::bigint, 0::bigint)$$,
  'canvas de abril: a baixa do mês, o aberto que vence nele e a transferência; o pago antigo e os de outros meses fora');
SELECT is((SELECT count(*)::int FROM flow_graph_lines(ARRAY[pg_temp.u('c001')], '2025-01-01', '2025-01-31')), 1,
          'o título antigo aparece no mês da baixa dele');

-- 147: as consultas citadas usam os índices novos --------------------------------------------------------------------------
SELECT ok(pg_temp.plan($$SELECT id FROM titles WHERE description ILIKE '%aluguel%'$$) ~ 'titles_description_trgm_idx',
          'busca na descrição dos títulos pelo trigram');
SELECT ok(pg_temp.plan($$SELECT id FROM titles WHERE description % 'aluguel'$$) ~ 'titles_description_trgm_idx',
          'similaridade na descrição dos títulos pelo trigram');
SELECT ok(pg_temp.plan($$SELECT id FROM card_purchases WHERE payer_caixa_id = '00000000-0000-7000-8000-00000058c001'
                           AND purchased_on BETWEEN '2026-10-01' AND '2026-10-31'$$)
            ~ 'card_purchases_payer_caixa_id_purchased_on_idx', 'compras da pagadora no período pelo índice composto');
SELECT ok(pg_temp.plan($$SELECT id FROM titles WHERE mirror_status = 'pending'$$) ~ 'titles_mirror_pending_idx',
          'espelhos pendentes pelo índice parcial (admin, sem caixa)');
SELECT ok(pg_temp.plan($$SELECT id FROM titles WHERE caixa_id = '00000000-0000-7000-8000-00000058c001' AND mirror_status = 'pending'$$)
            ~ 'titles_mirror_pending_idx', 'espelhos pendentes da caixa pelo índice parcial');
SELECT fk_ok('card_purchases', 'payer_caixa_id', 'caixas', 'id');

SELECT * FROM finish();
ROLLBACK;
