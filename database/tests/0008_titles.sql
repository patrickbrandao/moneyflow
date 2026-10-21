-- Testes de 0008_titles: títulos, recorrência e espelhamento entre caixas.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Dispara agora as checagens deferidas (simula o COMMIT sem encerrar a transação do teste).
CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table('titles');
SELECT columns_are('titles', ARRAY['id', 'caixa_id', 'direction', 'entity_id', 'category_id', 'description',
                                   'competence_date', 'due_date', 'amount_cents', 'status', 'origin',
                                   'recurrence_rule_id', 'occurrence', 'counterparty_caixa_id', 'mirror_title_id',
                                   'mirror_status', 'notes', 'archived_at', 'created_at', 'updated_at',
                                   -- 0012 (entrada de títulos), 0013 (cartão), 0032 (contratos), 0051 (conta prevista; a de passagem saiu na 0052)
                                   'boleto_barcode', 'pix_payload', 'nfe_document_id', 'card_invoice_id',
                                   'contract_id', 'contract_cycle_id', 'contract_installment',
                                   'planned_account_id', 'planned_account_custom']);
SELECT col_type_is('titles', 'amount_cents', 'bigint');
SELECT col_type_is('titles', 'due_date', 'date');
SELECT col_type_is('titles', 'competence_date', 'date');
SELECT col_default_is('titles', 'status', 'open');
SELECT col_default_is('titles', 'origin', 'manual');
SELECT fk_ok('titles', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('titles', 'entity_id', 'entities', 'id');
SELECT fk_ok('titles', 'category_id', 'categories', 'id');
SELECT fk_ok('titles', 'recurrence_rule_id', 'recurrence_rules', 'id');
SELECT fk_ok('titles', 'counterparty_caixa_id', 'caixas', 'id');
SELECT fk_ok('titles', 'mirror_title_id', 'titles', 'id');
SELECT has_index('titles', i) FROM unnest(ARRAY[
  'titles_caixa_id_due_date_idx', 'titles_caixa_id_status_due_date_idx', 'titles_caixa_id_competence_date_idx',
  'titles_due_date_idx', 'titles_entity_id_idx', 'titles_category_id_idx', 'titles_counterparty_caixa_id_idx',
  'titles_mirror_title_id_key', 'titles_recurrence_occurrence_key']) i;
SELECT has_trigger('titles', t) FROM unnest(ARRAY[
  'titles_set_updated_at', 'titles_validate', 'titles_mirror_check', 'titles_validate_status']) t;
SELECT has_trigger('recurrence_rules', 'recurrence_rules_validate');

-- Dados base
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-00000000e003', 'company', 'Nu Pagamentos'),
  ('00000000-0000-7000-8000-00000000e004', 'company', 'Escritório Contábil'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true),
  ('00000000-0000-7000-8000-0000000c0003', 'Contabilidade', 'general', '00000000-0000-7000-8000-00000000e004', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
VALUES ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e003',
        '00000000-0000-7000-8000-0000000c0002', 2000000, 3, 10, '1234');
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca02', 'income', 'Vendas');

-- Título simples ----------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                  VALUES ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable',
                          '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', 'Energia 10/2026',
                          '2026-10-01', '2026-10-15', 25000)$$, 'título a pagar com categoria de despesa');
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'open', 'nasce em aberto');

SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-15', 100)$$,
                 '23514', 'titles: payable title requires expense category, got income', 'a pagar exige categoria de despesa');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'receivable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100)$$,
                 '23514', 'titles: receivable title requires income category, got expense', 'a receber exige categoria de receita');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 0)$$,
                 '23514', NULL, 'valor > 0');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', '  ', '2026-10-01', '2026-10-15', 100)$$,
                 '23514', NULL, 'descrição não vazia');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'transfer', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100)$$,
                 '23514', NULL, 'direção só payable|receivable');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents, origin)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100, 'import')$$,
                 '23514', NULL, 'origem só manual|recurrence|card_invoice');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents, status)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100, 'paid')$$,
                 '23514', 'titles: status paid does not match settlements (expected open)', 'não nasce pago sem baixa');
SELECT throws_ok($$UPDATE titles SET direction = 'receivable', category_id = '00000000-0000-7000-8000-00000000ca02'
                    WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', 'titles: direction cannot change (title 00000000-0000-7000-8000-0000000b0001)', 'direção é imutável');
SELECT throws_ok($$UPDATE titles SET category_id = '00000000-0000-7000-8000-00000000ca02' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', NULL, 'trocar para categoria de kind errado é bloqueado');
SELECT throws_ok($$DELETE FROM categories WHERE id = '00000000-0000-7000-8000-00000000ca01'$$,
                 '23503', NULL, 'categoria em uso não pode ser excluída');
SELECT lives_ok($$UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                'título sem baixa pode ser cancelado');
SELECT lives_ok($$UPDATE titles SET status = 'open' WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                'e reaberto');

-- Caixa de cartão -----------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', 'receivable', '00000000-0000-7000-8000-00000000e002',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-10', 100)$$,
                 '23514', 'titles: credit card caixa 00000000-0000-7000-8000-0000000c0010 only accepts card_invoice titles',
                 'caixa de cartão não recebe título manual');
-- A fatura-título (origin = card_invoice) exige a fatura e o espelho desde 0013; o fluxo completo está em 0013_credit_cards.
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents, origin)
                  VALUES ('00000000-0000-7000-8000-0000000c0010', 'receivable', '00000000-0000-7000-8000-00000000e002',
                          '00000000-0000-7000-8000-00000000ca02', 'Fatura 10/2026', '2026-10-01', '2026-10-10', 100, 'card_invoice')$$,
                 '23514', NULL, 'fatura-título sem fatura nem espelho é rejeitada');

-- Recorrência e parcelamento --------------------------------------------------------------------
INSERT INTO recurrence_rules (id, caixa_id, frequency, anchor_day, starts_on, installments_total) VALUES
  ('00000000-0000-7000-8000-0000000f0001', '00000000-0000-7000-8000-0000000c0001', 'monthly', 10, '2026-10-10', 3);
SELECT lives_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                      origin, recurrence_rule_id, occurrence)
                  SELECT '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                         '00000000-0000-7000-8000-00000000ca01', 'Sofá ' || n || '/3', d, d, 33334, 'recurrence',
                         '00000000-0000-7000-8000-0000000f0001', n
                    FROM (VALUES (1, date '2026-10-10'), (2, date '2026-11-10'), (3, date '2026-12-10')) v (n, d)$$,
                'três parcelas apontam para a regra com n de N');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       origin, recurrence_rule_id, occurrence)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'Sofá 4/3', '2027-01-10', '2027-01-10', 1, 'recurrence',
                           '00000000-0000-7000-8000-0000000f0001', 4)$$,
                 '23514', 'titles: occurrence 4 exceeds installments total 3', 'parcela acima de N');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       origin, recurrence_rule_id, occurrence)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'Sofá 2/3 bis', '2026-11-10', '2026-11-10', 1, 'recurrence',
                           '00000000-0000-7000-8000-0000000f0001', 2)$$,
                 '23505', NULL, 'ocorrência única por série na caixa');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents, origin)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100, 'recurrence')$$,
                 '23514', NULL, 'origem recurrence exige regra e ocorrência');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       recurrence_rule_id, occurrence)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-15', 100,
                           '00000000-0000-7000-8000-0000000f0001', 5)$$,
                 '23514', NULL, 'regra só com origem recurrence');
SELECT throws_ok($$UPDATE recurrence_rules SET installments_total = 2 WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                 '23514', 'recurrence_rules: rule 00000000-0000-7000-8000-0000000f0001 has occurrences above 2',
                 'reduzir N abaixo de uma ocorrência existente');
SELECT lives_ok($$UPDATE recurrence_rules SET installments_total = 4 WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                'aumentar N');
SELECT throws_ok($$DELETE FROM recurrence_rules WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                 '23503', NULL, 'regra com títulos não pode ser excluída');

-- Espelhamento ------------------------------------------------------------------------------------
-- Contabilidade (titular Escritório) tem a receber de Minha Empresa; o espelho é a pagar
-- na caixa Minha Empresa, contraparte Escritório, pendente de aceite.
SELECT lives_ok($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0101', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'Honorários 10/2026',
          '2026-10-01', '2026-10-20', 90000, '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0102');
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0102', '00000000-0000-7000-8000-0000000c0002', 'payable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Honorários 10/2026',
          '2026-10-01', '2026-10-20', 90000, '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0101', 'pending');
  SELECT pg_temp.commit_check();
$$, 'par espelhado nasce na mesma transação (ligação deferida)');

SELECT lives_ok($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
  VALUES ('00000000-0000-7000-8000-0000000b0201', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'Honorários 11/2026',
          '2026-11-01', '2026-11-20', 90000);
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0202', '00000000-0000-7000-8000-0000000c0002', 'payable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'Honorários 11/2026',
          '2026-11-01', '2026-11-20', 90000, '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0201', 'accepted');
  UPDATE titles SET counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0002',
                    mirror_title_id = '00000000-0000-7000-8000-0000000b0202'
   WHERE id = '00000000-0000-7000-8000-0000000b0201';
  SELECT pg_temp.commit_check();
$$, 'par também pode ser ligado depois (insere, insere ligado, atualiza o original)');

SELECT throws_like($$
  UPDATE titles SET counterparty_caixa_id = NULL, mirror_title_id = NULL WHERE id = '00000000-0000-7000-8000-0000000b0101';
  SELECT pg_temp.commit_check();
$$, '%is not reciprocal%', 'ligação não recíproca é rejeitada no COMMIT');
SELECT throws_like($$
  UPDATE titles SET amount_cents = 95000 WHERE id = '00000000-0000-7000-8000-0000000b0101';
  SELECT pg_temp.commit_check();
$$, '%opposite direction, same amount and due date%', 'mudar o valor de um lado só');
SELECT throws_like($$
  UPDATE titles SET due_date = '2026-10-21' WHERE id = '00000000-0000-7000-8000-0000000b0102';
  SELECT pg_temp.commit_check();
$$, '%opposite direction, same amount and due date%', 'mudar o vencimento de um lado só');
SELECT lives_ok($$
  UPDATE titles SET amount_cents = 95000, due_date = '2026-10-21'
   WHERE id IN ('00000000-0000-7000-8000-0000000b0101', '00000000-0000-7000-8000-0000000b0102');
  SELECT pg_temp.commit_check();
$$, 'mudar valor e vencimento dos dois lados juntos');
SELECT throws_like($$
  UPDATE titles SET mirror_status = NULL WHERE id = '00000000-0000-7000-8000-0000000b0102';
  SELECT pg_temp.commit_check();
$$, '%exactly one title of pair%', 'um lado do par precisa ser o espelho');
SELECT throws_like($$
  UPDATE titles SET mirror_status = 'accepted' WHERE id = '00000000-0000-7000-8000-0000000b0101';
  SELECT pg_temp.commit_check();
$$, '%exactly one title of pair%', 'só um lado do par é o espelho');
SELECT lives_ok($$
  UPDATE titles SET mirror_status = 'disputed' WHERE id = '00000000-0000-7000-8000-0000000b0102';
  SELECT pg_temp.commit_check();
$$, 'espelho contestado');
SELECT throws_like($$
  DELETE FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0102';
  SELECT pg_temp.commit_check();
$$, '%violates foreign key constraint%', 'excluir um lado só do par');
SELECT lives_ok($$
  UPDATE titles SET counterparty_caixa_id = NULL, mirror_title_id = NULL, mirror_status = NULL
   WHERE id IN ('00000000-0000-7000-8000-0000000b0201', '00000000-0000-7000-8000-0000000b0202');
  SELECT pg_temp.commit_check();
$$, 'desfazer o espelho dos dois lados juntos');

-- Pares inválidos (cada um na própria transação simulada)
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0301', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0302');
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0302', '00000000-0000-7000-8000-0000000c0002', 'receivable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0301', 'pending');
  SELECT pg_temp.commit_check();
$$, '%opposite direction%', 'espelho precisa ter direção oposta');
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0301', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000b0302');
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0302', '00000000-0000-7000-8000-0000000c0001', 'payable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0301', 'pending');
  SELECT pg_temp.commit_check();
$$, '%is not held by entity%', 'espelho fica na caixa cujo titular é a contraparte');
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0301', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0302');
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0302', '00000000-0000-7000-8000-0000000c0002', 'payable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000b0301', 'pending');
  SELECT pg_temp.commit_check();
$$, '%is not in counterparty caixa%', 'counterparty_caixa_id aponta para a caixa do outro título');
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0301', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          'recurrence', '00000000-0000-7000-8000-0000000f0001', 1,
          '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0302');
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000b0302', '00000000-0000-7000-8000-0000000c0002', 'payable',
          '00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000ca01', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0301', 'pending');
  SELECT pg_temp.commit_check();
$$, '%must share origin, recurrence occurrence%', 'espelho de ocorrência repete origem, regra e número');
SELECT throws_like($$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000b0301', '00000000-0000-7000-8000-0000000c0003', 'receivable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
          '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0399');
  SELECT pg_temp.commit_check();
$$, '%violates foreign key constraint%', 'espelho inexistente');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       counterparty_caixa_id)
                   VALUES ('00000000-0000-7000-8000-0000000c0003', 'receivable', '00000000-0000-7000-8000-00000000e002',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
                           '00000000-0000-7000-8000-0000000c0002')$$,
                 '23514', NULL, 'caixa da contraparte só junto com o título espelho');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       mirror_status)
                   VALUES ('00000000-0000-7000-8000-0000000c0003', 'receivable', '00000000-0000-7000-8000-00000000e002',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100, 'pending')$$,
                 '23514', NULL, 'mirror_status só com espelho');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       counterparty_caixa_id, mirror_title_id, mirror_status)
                   VALUES ('00000000-0000-7000-8000-0000000c0003', 'receivable', '00000000-0000-7000-8000-00000000e002',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
                           '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0101', 'unknown')$$,
                 '23514', NULL, 'mirror_status só pending|accepted|disputed');
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                                       counterparty_caixa_id, mirror_title_id)
                   VALUES ('00000000-0000-7000-8000-0000000c0003', 'receivable', '00000000-0000-7000-8000-00000000e002',
                           '00000000-0000-7000-8000-00000000ca02', 'X', '2026-10-01', '2026-10-20', 100,
                           '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000b0101')$$,
                 '23514', NULL, 'caixa da contraparte diferente da própria');
SELECT throws_ok($$UPDATE titles SET mirror_title_id = id, counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0002'
                    WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23514', NULL, 'título não é espelho de si mesmo');
SELECT throws_ok($$UPDATE titles SET mirror_title_id = '00000000-0000-7000-8000-0000000b0102',
                                     counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0002'
                    WHERE id = '00000000-0000-7000-8000-0000000b0001'$$,
                 '23505', NULL, 'um título tem no máximo um espelho');

-- Privilégios
SELECT table_privs_are('titles', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

SELECT * FROM finish();
ROLLBACK;
