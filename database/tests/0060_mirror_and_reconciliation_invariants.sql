-- Testes de 0060_mirror_and_reconciliation_invariants (tarefa 148): o espelho conferido nos dois sentidos, o titular da
-- caixa travado pelos títulos, contratos e encargos ligados, a perna do espelho obrigatória na baixa e ao ligar o par, e
-- o item de fatura conciliado sem mudar de valor nem de fatura.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Roda o SQL, força as checagens do COMMIT e devolve "SQLSTATE constraint" (ou 'ok'). Em erro, desfaz. Para desfazer um
-- caso aceito, termine o SQL com "SELECT 1/0" (devolve '22012 -').
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
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000060' || p)::uuid $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_trigger('settlements', 'settlements_mirror_required_check');
SELECT ok(tgdeferrable AND tginitdeferred, 'perna do espelho conferida no COMMIT')
  FROM pg_trigger WHERE tgname = 'settlements_mirror_required_check';
SELECT has_trigger('card_invoice_items', 'card_invoice_items_validate_statement');

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  (pg_temp.u('e001'), 'person', 'Patrick'), (pg_temp.u('e002'), 'company', 'Empresa'), (pg_temp.u('e003'), 'company', 'Outra'),
  (pg_temp.u('e004'), 'company', 'Nu Pagamentos'), (pg_temp.u('e005'), 'company', 'Fornecedor'),
  (pg_temp.u('e006'), 'person', 'Sem nada'), (pg_temp.u('e007'), 'person', 'Novo titular');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  (pg_temp.u('c001'), 'Casa', 'general', pg_temp.u('e001'), true),
  (pg_temp.u('c002'), 'Empresa', 'general', pg_temp.u('e002'), true),
  (pg_temp.u('c003'), 'Outra', 'general', pg_temp.u('e003'), true),
  (pg_temp.u('c005'), 'Vazia', 'general', pg_temp.u('e006'), true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  (pg_temp.u('c010'), 'Nubank', 'credit_card', pg_temp.u('e004'), pg_temp.u('c001'), 500000, 3, 10, '1111');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  (pg_temp.u('a001'), pg_temp.u('c001'), 'checking', 'Corrente Casa', '2026-01-01'),
  (pg_temp.u('b001'), pg_temp.u('c002'), 'checking', 'Corrente Empresa', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES
  (pg_temp.u('ca01'), 'expense', 'Despesa 60'), (pg_temp.u('ca02'), 'income', 'Receita 60');

-- Par espelhado P (Casa paga à Empresa) e dois títulos soltos que podem virar par.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  (pg_temp.u('7001'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'P', '2026-10-01', '2026-10-10', 1000,
   pg_temp.u('c002'), pg_temp.u('7002'), NULL),
  (pg_temp.u('7002'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'P', '2026-10-01', '2026-10-10', 1000,
   pg_temp.u('c001'), pg_temp.u('7001'), 'accepted');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  (pg_temp.u('7011'), pg_temp.u('c001'), 'payable', pg_temp.u('e002'), pg_temp.u('ca01'), 'Solto', '2026-11-01', '2026-11-10', 1000),
  (pg_temp.u('7012'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'Solto', '2026-11-01', '2026-11-10', 1000);
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'dados base coerentes');

-- 1. Espelho nos dois sentidos ---------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = pg_temp.u('c003') WHERE id = pg_temp.u('7001')$$),
          '23514 titles_mirror_caixa_check', 'trocar a caixa do original sozinho é recusado');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = pg_temp.u('c003') WHERE id = pg_temp.u('7002')$$),
          '23514 titles_mirror_caixa_check', 'trocar a caixa do espelho sozinho é recusado');
SELECT is(pg_temp.err($$UPDATE titles SET caixa_id = pg_temp.u('c003') WHERE id = pg_temp.u('7001');
                       UPDATE titles SET counterparty_caixa_id = pg_temp.u('c003'), entity_id = pg_temp.u('e003')
                        WHERE id = pg_temp.u('7002'); SELECT 1/0$$),
          '22012 -', 'trocar a caixa de um lado com a contraparte e a entidade do outro, junto, passa');
SELECT is(pg_temp.err($$UPDATE titles SET entity_id = pg_temp.u('e003') WHERE id = pg_temp.u('7002')$$),
          '23514 titles_mirror_caixa_check', 'a entidade do espelho é o titular da caixa do original');

-- 2. Titular da caixa ------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c001')$$),
          '23514 caixas_holder_locked_check', 'caixa com títulos: o titular não muda');
DELETE FROM titles WHERE id = pg_temp.u('7012');
SELECT is(pg_temp.err($$DELETE FROM titles WHERE caixa_id = pg_temp.u('c002');
                       UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c002')$$),
          '23514 caixas_holder_locked_check', 'caixa que é contraparte de um título: o titular não muda');
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id, counterparty_caixa_id, status, starts_on) VALUES
  (pg_temp.u('f001'), pg_temp.u('c001'), pg_temp.u('e003'), 'payable', 'Serviço', pg_temp.u('ca01'), pg_temp.u('c003'),
   'draft', '2026-01-01');
SELECT is(pg_temp.err($$UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c003')$$),
          '23514 caixas_holder_locked_check', 'caixa da contraparte de um contrato: o titular não muda');
SELECT is(pg_temp.err($$UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c005'); SELECT 1/0$$),
          '22012 -', 'caixa sem títulos, contratos nem encargos: o titular muda');
SELECT is(pg_temp.err($$UPDATE caixas SET name = 'Casa nova' WHERE id = pg_temp.u('c001'); SELECT 1/0$$),
          '22012 -', 'outros campos da caixa continuam livres');
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date)
SELECT pg_temp.u('a6' || lpad(m::text, 2, '0')), pg_temp.u('c010'), make_date(2026, m, 1), make_date(2026, m, 3), make_date(2026, m, 10)
  FROM generate_series(10, 12) m;
SELECT is(pg_temp.err($$UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c010'); SELECT 1/0$$),
          '22012 -', 'cartão sem encargos nem títulos: o titular (emissor) muda');
INSERT INTO card_purchases (id, card_caixa_id, kind, charge_kind, payer_caixa_id, entity_id, category_id, purchased_on,
                            description, amount_cents) VALUES
  (pg_temp.u('9001'), pg_temp.u('c010'), 'charge', 'fee', pg_temp.u('c001'), pg_temp.u('e004'), pg_temp.u('ca01'),
   '2026-10-01', 'Anuidade', 500);
INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
VALUES (pg_temp.u('a610'), pg_temp.u('9001'), 1, pg_temp.u('c001'), 500);
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'encargo do emissor no cartão');
SELECT is(pg_temp.err($$UPDATE caixas SET holder_entity_id = pg_temp.u('e007') WHERE id = pg_temp.u('c010')$$),
          '23514 caixas_holder_locked_check', 'cartão com encargo do emissor: o titular não muda');

-- 3. A perna do espelho -----------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES (pg_temp.u('7001'), '2026-10-10', 400)$$),
          '23514 settlements_mirror_required_check', 'baixa num título espelhado sem a perna do espelho é recusada');
SELECT is(pg_temp.err($$INSERT INTO settlements (id, title_id, settled_on, amount_cents, mirror_settlement_id) VALUES
                         (pg_temp.u('d001'), pg_temp.u('7001'), '2026-10-10', 400, pg_temp.u('d002')),
                         (pg_temp.u('d002'), pg_temp.u('7002'), '2026-10-10', 400, pg_temp.u('d001'))$$),
          'ok', 'baixa com as duas pernas passa');
SELECT is(pg_temp.err($$UPDATE settlements SET mirror_settlement_id = NULL
                         WHERE id IN (pg_temp.u('d001'), pg_temp.u('d002'))$$),
          '23514 settlements_mirror_required_check', 'soltar as duas pernas da baixa de um par é recusado');
SELECT is(pg_temp.err($$INSERT INTO settlements (title_id, settled_on, amount_cents) VALUES (pg_temp.u('7011'), '2026-11-10', 1000);
                       SELECT 1/0$$),
          '22012 -', 'baixa sem perna em título sem espelho passa');
-- Ligar depois: o solto 7011 com baixa própria e um 7013 novo na Empresa.
INSERT INTO settlements (id, title_id, settled_on, amount_cents) VALUES (pg_temp.u('d011'), pg_temp.u('7011'), '2026-11-05', 300);
CREATE TEMP TABLE link_sql AS SELECT $$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES (pg_temp.u('7013'), pg_temp.u('c002'), 'receivable', pg_temp.u('e001'), pg_temp.u('ca02'), 'Solto', '2026-11-01',
          '2026-11-10', 1000, pg_temp.u('c001'), pg_temp.u('7011'), 'accepted');
  UPDATE titles SET counterparty_caixa_id = pg_temp.u('c002'), mirror_title_id = pg_temp.u('7013') WHERE id = pg_temp.u('7011');
$$::text AS q;
SELECT is(pg_temp.err((SELECT q FROM link_sql)), '23514 settlements_mirror_required_check',
          'ligar como par um título com baixa ativa sem perna é recusado');
UPDATE settlements SET reversed_at = now(), reversal_reason = 'refazer' WHERE id = pg_temp.u('d011');
SELECT is(pg_temp.err((SELECT q FROM link_sql) || '; SELECT 1/0'), '22012 -',
          'com a baixa solta estornada, o par pode ser ligado');

-- 4. Item de fatura conciliado ------------------------------------------------------------------------------------------------
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents,
                            installments_total) VALUES
  (pg_temp.u('9002'), pg_temp.u('c010'), pg_temp.u('c001'), pg_temp.u('e005'), pg_temp.u('ca01'), '2026-10-01', 'Loja', 9000, 3);
INSERT INTO card_invoice_items (id, card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents) VALUES
  (pg_temp.u('8001'), pg_temp.u('a610'), pg_temp.u('9002'), 1, pg_temp.u('c001'), 3000),
  (pg_temp.u('8002'), pg_temp.u('a611'), pg_temp.u('9002'), 2, pg_temp.u('c001'), 3000),
  (pg_temp.u('8003'), pg_temp.u('a612'), pg_temp.u('9002'), 3, pg_temp.u('c001'), 3000);
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  (pg_temp.u('ff01'), 'fatura.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, card_caixa_id, format, attachment_id, period_start, period_end) VALUES
  (pg_temp.u('ab01'), pg_temp.u('c010'), 'ofx', pg_temp.u('ff01'), '2026-09-04', '2026-10-03');
INSERT INTO statement_lines (id, statement_import_id, card_caixa_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, card_invoice_item_id, matched_at) VALUES
  (pg_temp.u('1001'), pg_temp.u('ab01'), pg_temp.u('c010'), 1, '2026-10-01', -3000, 'LOJA 1/3', 'h1', 'matched', pg_temp.u('8001'), now()),
  (pg_temp.u('1002'), pg_temp.u('ab01'), pg_temp.u('c010'), 2, '2026-10-01', -3000, 'LOJA 2/3', 'h2', 'suggested', pg_temp.u('8002'), NULL);
SELECT is(pg_temp.err('SELECT 1'), 'ok', 'compra em três parcelas, a primeira conciliada e a segunda sugerida');
SELECT is(pg_temp.err($$UPDATE card_invoice_items SET amount_cents = amount_cents + 100 WHERE id = pg_temp.u('8001');
                       UPDATE card_invoice_items SET amount_cents = amount_cents - 100 WHERE id = pg_temp.u('8003')$$),
          '23514 statement_lines_card_item_check', 'o item conciliado não muda de valor');
SELECT is(pg_temp.err($$UPDATE card_invoice_items SET card_invoice_id = pg_temp.u('a611') WHERE id = pg_temp.u('8001')$$),
          '23514 statement_lines_card_item_check', 'o item conciliado não muda de fatura');
SELECT is(pg_temp.err($$UPDATE card_invoice_items SET amount_cents = amount_cents + 100 WHERE id = pg_temp.u('8002');
                       UPDATE card_invoice_items SET amount_cents = amount_cents - 100 WHERE id = pg_temp.u('8003'); SELECT 1/0$$),
          '22012 -', 'o item só sugerido muda de valor (redistribuir as parcelas)');
SELECT is(pg_temp.err($$UPDATE card_invoice_items SET payer_caixa_id = pg_temp.u('c001') WHERE id = pg_temp.u('8001'); SELECT 1/0$$),
          '22012 -', 'a pagadora do item conciliado continua editável');

SELECT * FROM finish();
ROLLBACK;
