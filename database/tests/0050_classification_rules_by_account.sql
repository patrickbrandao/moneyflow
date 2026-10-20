-- Testes de 0050_classification_rules_by_account: regras de classificação por conta ou cartão (spec 032), a cópia
-- entre contas, classification_rule_for pelo alvo da linha e a migração das regras de caixa e globais.
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
SELECT has_column('classification_rules', c) FROM unnest(ARRAY['financial_account_id', 'copied_from_rule_id']) c;
SELECT col_not_null('classification_rules', 'caixa_id');
SELECT fk_ok('classification_rules', 'financial_account_id', 'financial_accounts', 'id');
SELECT fk_ok('classification_rules', 'copied_from_rule_id', 'classification_rules', 'id');
SELECT is((SELECT confdeltype FROM pg_constraint WHERE conname = 'classification_rules_financial_account_id_fkey'), 'c',
          'excluir a conta leva as regras dela');
SELECT is((SELECT confdeltype FROM pg_constraint WHERE conname = 'classification_rules_copied_from_rule_id_fkey'), 'n',
          'excluir a origem solta a cópia');
SELECT has_index('classification_rules', i)
  FROM unnest(ARRAY['classification_rules_pattern_key', 'classification_rules_financial_account_id_idx',
                    'classification_rules_copied_from_rule_id_idx']) i;
SELECT ok(indexdef ~ 'UNIQUE' AND indexdef ~ '\(caixa_id, financial_account_id, match_kind, lower\(pattern\), direction\) NULLS NOT DISTINCT'
          AND indexdef ~ 'archived_at IS NULL', 'unicidade das ativas por conta (cartão com conta nula)')
  FROM pg_indexes WHERE indexname = 'classification_rules_pattern_key';
SELECT has_function('classification_rule_for', ARRAY['uuid', 'uuid', 'text', 'bigint']);
SELECT hasnt_function('classification_rule_for', ARRAY['uuid', 'text', 'bigint'], 'a versão por caixa saiu');
SELECT function_privs_are('classification_rule_for', ARRAY['uuid', 'uuid', 'text', 'bigint'], 'moneyflow_app', ARRAY['EXECUTE']);
SELECT function_privs_are('classification_rules_split_by_target', ARRAY[]::text[], 'moneyflow_app', ARRAY[]::text[]);
SELECT has_trigger('classification_rules', 'classification_rules_validate_target');
SELECT has_trigger('financial_accounts', 'financial_accounts_validate_rules');

-- Dados base ------------------------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000050e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000050e002', 'company', 'Empresa'),
  ('00000000-0000-7000-8000-00000050e003', 'company', 'Nu Pagamentos'),
  ('00000000-0000-7000-8000-00000050e004', 'company', 'Uber');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-000000500c01', 'Casa', 'general', '00000000-0000-7000-8000-00000050e001', true),
  ('00000000-0000-7000-8000-000000500c02', 'Empresa', 'general', '00000000-0000-7000-8000-00000050e002', true),
  ('00000000-0000-7000-8000-000000500c03', 'Só cofre', 'general', '00000000-0000-7000-8000-00000050e001', false);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-000000500c10', 'Nubank', 'credit_card', '00000000-0000-7000-8000-00000050e003',
   '00000000-0000-7000-8000-000000500c01', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-000000500a01', '00000000-0000-7000-8000-000000500c01', 'checking', 'Corrente', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500a02', '00000000-0000-7000-8000-000000500c01', 'savings', 'Poupança', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500a03', '00000000-0000-7000-8000-000000500c01', 'cash', 'Cofre', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500a04', '00000000-0000-7000-8000-000000500c01', 'checking', 'Antiga', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500b01', '00000000-0000-7000-8000-000000500c02', 'checking', 'PJ', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500b02', '00000000-0000-7000-8000-000000500c02', 'checking', 'PJ sem regra', '2026-01-01'),
  ('00000000-0000-7000-8000-000000500d01', '00000000-0000-7000-8000-000000500c03', 'cash', 'Gaveta', '2026-01-01');
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-000000500ca1', 'expense', 'Transporte'),
  ('00000000-0000-7000-8000-000000500ca2', 'expense', 'Mercado');

-- Alvo obrigatório e coerente ---------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO classification_rules (pattern, entity_id)
                        VALUES ('x', '00000000-0000-7000-8000-00000050e004')$$),
          '23502 ', 'sem caixa: não existe regra global');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, pattern, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c01', 'x', '00000000-0000-7000-8000-00000050e004')$$),
          '23514 classification_rules_account_check', 'caixa geral exige a conta');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c01', '00000000-0000-7000-8000-000000500b01', 'x',
                                '00000000-0000-7000-8000-00000050e004')$$),
          '23514 classification_rules_account_check', 'conta de outra caixa');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c01', '00000000-0000-7000-8000-000000500a03', 'x',
                                '00000000-0000-7000-8000-00000050e004')$$),
          '23514 classification_rules_account_check', 'cofre não tem regra');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c10', '00000000-0000-7000-8000-000000500a01', 'x',
                                '00000000-0000-7000-8000-00000050e004')$$),
          '23514 classification_rules_account_check', 'cartão com conta');
SELECT lives_ok($$INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id, category_id)
                  VALUES ('00000000-0000-7000-8000-000000500e01', '00000000-0000-7000-8000-000000500c01',
                          '00000000-0000-7000-8000-000000500a01', 'contains', 'uber', 'out',
                          '00000000-0000-7000-8000-00000050e004', '00000000-0000-7000-8000-000000500ca1')$$,
                'regra da conta corrente');
SELECT lives_ok($$INSERT INTO classification_rules (id, caixa_id, match_kind, pattern, direction, category_id)
                  VALUES ('00000000-0000-7000-8000-000000500e10', '00000000-0000-7000-8000-000000500c10', 'contains', 'uber', 'out',
                          '00000000-0000-7000-8000-000000500ca1')$$,
                'regra do cartão, sem conta');
SELECT is(pg_temp.err($$UPDATE classification_rules SET financial_account_id = '00000000-0000-7000-8000-000000500b01'
                         WHERE id = '00000000-0000-7000-8000-000000500e01'$$),
          '23514 classification_rules_account_check', 'a regra não vai para conta de outra caixa');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-000000500c02'
                         WHERE id = '00000000-0000-7000-8000-000000500a01'$$),
          '23514 classification_rules_account_check', 'a conta com regras não muda de caixa');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET kind = 'cash'
                         WHERE id = '00000000-0000-7000-8000-000000500a01'$$),
          '23514 classification_rules_account_check', 'a conta com regras não vira cofre');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-000000500c01'
                         WHERE id = '00000000-0000-7000-8000-000000500b02'$$),
          'ok', 'conta sem regras (e sem histórico) muda de caixa');
UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-000000500c02' WHERE id = '00000000-0000-7000-8000-000000500b02';

-- Unicidade por conta -----------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, match_kind, pattern, direction, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c01', '00000000-0000-7000-8000-000000500a01', 'contains', 'UBER',
                                'out', '00000000-0000-7000-8000-00000050e001')$$),
          '23505 classification_rules_pattern_key', 'o mesmo padrão não se repete nas ativas da conta');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, match_kind, pattern, direction, entity_id)
                        VALUES ('00000000-0000-7000-8000-000000500c10', 'contains', 'Uber', 'out',
                                '00000000-0000-7000-8000-00000050e001')$$),
          '23505 classification_rules_pattern_key', 'nem nas do cartão (conta nula)');
SELECT lives_ok($$INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id)
                  VALUES ('00000000-0000-7000-8000-000000500e02', '00000000-0000-7000-8000-000000500c01',
                          '00000000-0000-7000-8000-000000500a02', 'contains', 'UBER', 'out', '00000000-0000-7000-8000-00000050e001')$$,
                'a mesma regra em outra conta da caixa');

-- classification_rule_for pelo alvo ---------------------------------------------------------------------------------------
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500a01', NULL, 'UBER *TRIP', -2500),
          '00000000-0000-7000-8000-000000500e01'::uuid, 'corrente: a regra da corrente');
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500a02', NULL, 'UBER *TRIP', -2500),
          '00000000-0000-7000-8000-000000500e02'::uuid, 'poupança: a da poupança, com o mesmo padrão');
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500b01', NULL, 'UBER *TRIP', -2500), NULL,
          'conta sem regra: nenhuma (nada global)');
SELECT is(classification_rule_for(NULL, '00000000-0000-7000-8000-000000500c10', 'UBER *TRIP', -2500),
          '00000000-0000-7000-8000-000000500e10'::uuid, 'cartão: a regra do cartão');
SELECT is(classification_rule_for(NULL, '00000000-0000-7000-8000-000000500c01', 'UBER *TRIP', -2500), NULL,
          'caixa geral no lugar do cartão não pega as regras das contas');
SELECT is(pg_temp.err($$SELECT classification_rule_for(NULL, NULL, 'UBER', -1)$$), '22023 ', 'sem alvo');
SELECT is(pg_temp.err($$SELECT classification_rule_for('00000000-0000-7000-8000-000000500a01', '00000000-0000-7000-8000-000000500c10',
                                                       'UBER', -1)$$), '22023 ', 'dois alvos');
UPDATE classification_rules SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000500e02';
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500a02', NULL, 'UBER *TRIP', -2500), NULL,
          'arquivada não classifica, e a da outra conta não entra no lugar');

-- Cópia --------------------------------------------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id,
                                                    category_id, origin, copied_from_rule_id)
                  VALUES ('00000000-0000-7000-8000-000000500e03', '00000000-0000-7000-8000-000000500c02',
                          '00000000-0000-7000-8000-000000500b01', 'contains', 'uber', 'out', '00000000-0000-7000-8000-00000050e004',
                          '00000000-0000-7000-8000-000000500ca1', 'copy', '00000000-0000-7000-8000-000000500e01')$$,
                'cópia de outra caixa, com o vínculo');
SELECT lives_ok($$INSERT INTO classification_rules (caixa_id, match_kind, pattern, direction, entity_id, origin)
                  VALUES ('00000000-0000-7000-8000-000000500c10', 'exact', 'ifood', 'out', '00000000-0000-7000-8000-00000050e004',
                          'copy')$$,
                'cópia sem o vínculo (origem excluída)');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id, origin, copied_from_rule_id)
                        VALUES ('00000000-0000-7000-8000-000000500c02', '00000000-0000-7000-8000-000000500b02', 'x',
                                '00000000-0000-7000-8000-00000050e004', 'manual', '00000000-0000-7000-8000-000000500e01')$$),
          '23514 classification_rules_copied_from_check', 'vínculo de cópia só com origem copy');
SELECT is(pg_temp.err($$UPDATE classification_rules SET copied_from_rule_id = id WHERE id = '00000000-0000-7000-8000-000000500e03'$$),
          '23514 classification_rules_copied_from_check', 'a cópia não aponta para si mesma');
SELECT is(pg_temp.err($$INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id, origin)
                        VALUES ('00000000-0000-7000-8000-000000500c02', '00000000-0000-7000-8000-000000500b02', 'x',
                                '00000000-0000-7000-8000-00000050e004', 'imported')$$),
          '23514 classification_rules_origin_check', 'origem fora da lista');
DELETE FROM classification_rules WHERE id = '00000000-0000-7000-8000-000000500e01';
SELECT is((SELECT copied_from_rule_id FROM classification_rules WHERE id = '00000000-0000-7000-8000-000000500e03'), NULL,
          'excluir a origem solta o vínculo, a cópia fica');

-- Conta excluída leva as regras.
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-000000500b09', '00000000-0000-7000-8000-000000500c02', 'savings', 'Temporária', '2026-01-01');
INSERT INTO classification_rules (caixa_id, financial_account_id, pattern, entity_id) VALUES
  ('00000000-0000-7000-8000-000000500c02', '00000000-0000-7000-8000-000000500b09', 'temp', '00000000-0000-7000-8000-00000050e004');
DELETE FROM financial_accounts WHERE id = '00000000-0000-7000-8000-000000500b09';
SELECT is((SELECT count(*)::int FROM classification_rules WHERE pattern = 'temp'), 0, 'regras da conta excluída saem junto');

-- Migração dos dados ------------------------------------------------------------------------------------------------------
-- Recria o estado anterior (regras de caixa e globais, sem conta) dentro do teste e roda a função da migração.
DELETE FROM classification_rules;
ALTER TABLE classification_rules DISABLE TRIGGER classification_rules_validate_target;
ALTER TABLE classification_rules ALTER COLUMN caixa_id DROP NOT NULL;

-- Conta arquivada e lotes (um provisório que será substituído).
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-00000050a701', 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, card_caixa_id, format, attachment_id, period_start, period_end, provisional) VALUES
  ('00000000-0000-7000-8000-00000050ac01', '00000000-0000-7000-8000-000000500a01', NULL, 'ofx',
   '00000000-0000-7000-8000-00000050a701', '2026-10-01', '2026-10-31', false),
  ('00000000-0000-7000-8000-00000050ac04', '00000000-0000-7000-8000-000000500a04', NULL, 'ofx',
   '00000000-0000-7000-8000-00000050a701', '2026-10-01', '2026-10-31', false),
  ('00000000-0000-7000-8000-00000050ac10', NULL, '00000000-0000-7000-8000-000000500c10', 'csv',
   '00000000-0000-7000-8000-00000050a701', '2026-10-01', '2026-10-31', false),
  ('00000000-0000-7000-8000-00000050ac21', '00000000-0000-7000-8000-000000500a02', NULL, 'ofx',
   '00000000-0000-7000-8000-00000050a701', '2026-10-01', '2026-10-15', true),
  ('00000000-0000-7000-8000-00000050ac22', '00000000-0000-7000-8000-000000500a02', NULL, 'ofx',
   '00000000-0000-7000-8000-00000050a701', '2026-10-01', '2026-10-31', false);


INSERT INTO classification_rules (id, caixa_id, match_kind, pattern, direction, entity_id, category_id, priority, origin,
                                  usage_count, last_used_at, archived_at) VALUES
  -- G1 global: na Casa perde para C2 (prioridade menor), no cartão para K1 (a regra do cartão fica).
  ('00000000-0000-7000-8000-0000005f0001', NULL, 'contains', 'uber', 'out', '00000000-0000-7000-8000-00000050e004',
   '00000000-0000-7000-8000-000000500ca1', 100, 'correction', 9, '2026-10-20 10:00', NULL),
  -- G2 global sem conflito.
  ('00000000-0000-7000-8000-0000005f0002', NULL, 'contains', 'pix', NULL, '00000000-0000-7000-8000-00000050e001',
   NULL, 100, 'manual', 1, NULL, NULL),
  -- C1 da Casa: linhas na corrente, na conta arquivada e no provisório substituído da poupança.
  ('00000000-0000-7000-8000-0000005f0011', '00000000-0000-7000-8000-000000500c01', 'contains', 'mercado', 'out', NULL,
   '00000000-0000-7000-8000-000000500ca2', 100, 'manual', 3, '2026-10-19 10:00', NULL),
  -- C2 da Casa: mesmo padrão da G1, prioridade menor.
  ('00000000-0000-7000-8000-0000005f0012', '00000000-0000-7000-8000-000000500c01', 'contains', 'uber', 'out',
   '00000000-0000-7000-8000-00000050e004', NULL, 50, 'manual', 0, NULL, NULL),
  -- K1 do cartão: fica como está.
  ('00000000-0000-7000-8000-0000005f0021', '00000000-0000-7000-8000-000000500c10', 'contains', 'uber', 'out', NULL,
   '00000000-0000-7000-8000-000000500ca1', 100, 'manual', 4, NULL, NULL),
  -- E1 da Empresa, arquivada e sem linhas: cópias arquivadas nas contas ativas.
  ('00000000-0000-7000-8000-0000005f0031', '00000000-0000-7000-8000-000000500c02', 'contains', 'aluguel', 'out',
   '00000000-0000-7000-8000-00000050e002', NULL, 100, 'agent', 0, NULL, '2026-09-01'),
  -- Z1 de caixa sem conta de extrato e sem linhas: removida.
  ('00000000-0000-7000-8000-0000005f0041', '00000000-0000-7000-8000-000000500c03', 'contains', 'gaveta', NULL,
   '00000000-0000-7000-8000-00000050e001', NULL, 100, 'manual', 0, NULL, NULL);

INSERT INTO statement_lines (id, statement_import_id, financial_account_id, card_caixa_id, line_number, posted_on, amount_cents,
                             description, dedup_hash, classification_rule_id, classification_source) VALUES
  ('00000000-0000-7000-8000-00000050ad01', '00000000-0000-7000-8000-00000050ac01', '00000000-0000-7000-8000-000000500a01', NULL,
   1, '2026-10-05', -2500, 'UBER TRIP', 'h1', '00000000-0000-7000-8000-0000005f0001', 'rule'),
  ('00000000-0000-7000-8000-00000050ad02', '00000000-0000-7000-8000-00000050ac01', '00000000-0000-7000-8000-000000500a01', NULL,
   2, '2026-10-06', -5000, 'MERCADO X', 'h2', '00000000-0000-7000-8000-0000005f0011', 'rule'),
  ('00000000-0000-7000-8000-00000050ad06', '00000000-0000-7000-8000-00000050ac01', '00000000-0000-7000-8000-000000500a01', NULL,
   3, '2026-10-07', 1000, 'PIX FULANO', 'h6', '00000000-0000-7000-8000-0000005f0002', 'rule'),
  ('00000000-0000-7000-8000-00000050ad03', '00000000-0000-7000-8000-00000050ac04', '00000000-0000-7000-8000-000000500a04', NULL,
   1, '2026-10-06', -5000, 'MERCADO Y', 'h3', '00000000-0000-7000-8000-0000005f0011', 'rule'),
  ('00000000-0000-7000-8000-00000050ad04', '00000000-0000-7000-8000-00000050ac10', NULL, '00000000-0000-7000-8000-000000500c10',
   1, '2026-10-05', -3000, 'UBER', 'h4', '00000000-0000-7000-8000-0000005f0001', 'rule'),
  ('00000000-0000-7000-8000-00000050ad05', '00000000-0000-7000-8000-00000050ac21', '00000000-0000-7000-8000-000000500a02', NULL,
   1, '2026-10-08', -4000, 'MERCADO Z', 'h5', '00000000-0000-7000-8000-0000005f0011', 'rule');

UPDATE financial_accounts SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000500a04';
UPDATE statement_imports SET superseded_by_import_id = '00000000-0000-7000-8000-00000050ac22', superseded_at = now()
 WHERE id = '00000000-0000-7000-8000-00000050ac21';
UPDATE statement_lines SET status = 'superseded', supersede_outcome = 'dropped' WHERE id = '00000000-0000-7000-8000-00000050ad05';
SELECT pg_temp.commit_check();
ALTER TABLE classification_rules ENABLE TRIGGER classification_rules_validate_target;

CREATE TEMP TABLE lines_before AS SELECT id, updated_at FROM statement_lines;
CREATE TEMP TABLE audit_before AS SELECT count(*) AS n FROM audit_log WHERE table_name = 'statement_lines';

SELECT lives_ok($$SELECT classification_rules_split_by_target()$$, 'migração dos dados');

SELECT is((SELECT count(*)::int FROM classification_rules WHERE caixa_id IS NULL), 0, 'nenhuma regra global sobrou');
SELECT lives_ok($$ALTER TABLE classification_rules ALTER COLUMN caixa_id SET NOT NULL$$, 'caixa_id volta a NOT NULL');
SELECT lives_ok($$UPDATE classification_rules SET financial_account_id = financial_account_id$$,
                'todas as regras com alvo coerente');

SELECT results_eq($$
  SELECT coalesce(a.name, c.name), r.pattern, r.priority::int, r.origin, r.usage_count,
         r.archived_at IS NOT NULL, r.last_used_at IS NOT NULL
    FROM classification_rules r
    JOIN caixas c ON c.id = r.caixa_id
    LEFT JOIN financial_accounts a ON a.id = r.financial_account_id
   ORDER BY r.pattern, coalesce(a.name, c.name) COLLATE "C", r.priority, r.origin
$$, $$VALUES
  ('PJ'::text, 'aluguel'::text, 100, 'agent'::text, 0, true, false),
  ('PJ sem regra', 'aluguel', 100, 'agent', 0, true, false),
  ('Antiga', 'mercado', 100, 'manual', 1, false, true),
  ('Corrente', 'mercado', 100, 'manual', 1, false, true),
  ('Poupança', 'mercado', 100, 'manual', 1, false, true),
  ('Corrente', 'pix', 100, 'manual', 1, false, false),
  ('Nubank', 'pix', 100, 'manual', 0, false, false),
  ('PJ', 'pix', 100, 'manual', 0, false, false),
  ('PJ sem regra', 'pix', 100, 'manual', 0, false, false),
  ('Poupança', 'pix', 100, 'manual', 0, false, false),
  ('Corrente', 'uber', 50, 'manual', 0, false, false),
  ('Corrente', 'uber', 100, 'correction', 1, true, true),
  ('Nubank', 'uber', 100, 'correction', 1, true, true),
  ('Nubank', 'uber', 100, 'manual', 4, false, false),
  ('PJ', 'uber', 100, 'correction', 0, false, false),
  ('PJ sem regra', 'uber', 100, 'correction', 0, false, false),
  ('Poupança', 'uber', 50, 'manual', 0, false, false)
$$, 'uma regra por alvo: contas ativas (e as com linha), cartões ativos na global, conflito arquivado, uso por alvo');

SELECT is((SELECT financial_account_id FROM classification_rules WHERE id = '00000000-0000-7000-8000-0000005f0001'),
          '00000000-0000-7000-8000-000000500a01'::uuid, 'a global fica com o alvo de mais linhas (a corrente)');
SELECT is((SELECT financial_account_id FROM classification_rules WHERE id = '00000000-0000-7000-8000-0000005f0011'),
          '00000000-0000-7000-8000-000000500a01'::uuid, 'a de caixa fica numa das contas');
SELECT results_eq($$SELECT caixa_id, financial_account_id, usage_count FROM classification_rules
                     WHERE id = '00000000-0000-7000-8000-0000005f0021'$$,
                  $$VALUES ('00000000-0000-7000-8000-000000500c10'::uuid, NULL::uuid, 4)$$, 'a do cartão fica como está');
SELECT is((SELECT count(*)::int FROM classification_rules WHERE id = '00000000-0000-7000-8000-0000005f0041'
                                                            OR pattern = 'gaveta'), 0, 'sem alvo e sem linha: removida');
SELECT is((SELECT count(*)::int FROM classification_rules WHERE origin = 'copy' OR copied_from_rule_id IS NOT NULL), 0,
          'cópias da migração mantêm a origem da original');

-- Linhas reapontadas para a regra do alvo delas.
SELECT is((SELECT count(*)::int FROM statement_lines l JOIN classification_rules r ON r.id = l.classification_rule_id
            WHERE l.financial_account_id IS NOT DISTINCT FROM r.financial_account_id
              AND r.caixa_id = coalesce((SELECT a.caixa_id FROM financial_accounts a WHERE a.id = l.financial_account_id),
                                        l.card_caixa_id)), 6, 'as seis linhas apontam para a regra do próprio alvo');
SELECT results_eq($$SELECT l.id, r.pattern FROM statement_lines l JOIN classification_rules r ON r.id = l.classification_rule_id
                     WHERE l.id::text LIKE '00000000-0000-7000-8000-00000050ad0%' ORDER BY l.id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000050ad01'::uuid, 'uber'::text),
                           ('00000000-0000-7000-8000-00000050ad02'::uuid, 'mercado'),
                           ('00000000-0000-7000-8000-00000050ad03'::uuid, 'mercado'),
                           ('00000000-0000-7000-8000-00000050ad04'::uuid, 'uber'),
                           ('00000000-0000-7000-8000-00000050ad05'::uuid, 'mercado'),
                           ('00000000-0000-7000-8000-00000050ad06'::uuid, 'pix')$$, 'cada linha com a cópia da mesma regra');
SELECT is((SELECT financial_account_id FROM classification_rules
            WHERE id = (SELECT classification_rule_id FROM statement_lines WHERE id = '00000000-0000-7000-8000-00000050ad05')),
          '00000000-0000-7000-8000-000000500a02'::uuid, 'a linha do lote substituído também foi reapontada');
SELECT is((SELECT financial_account_id FROM classification_rules
            WHERE id = (SELECT classification_rule_id FROM statement_lines WHERE id = '00000000-0000-7000-8000-00000050ad03')),
          '00000000-0000-7000-8000-000000500a04'::uuid, 'a conta arquivada com linha ganhou a cópia');
SELECT is((SELECT count(*)::int FROM statement_lines l JOIN lines_before b ON b.id = l.id WHERE l.updated_at <> b.updated_at), 0,
          'reapontar não mexe no updated_at das linhas');
SELECT is((SELECT count(*) FROM audit_log WHERE table_name = 'statement_lines'), (SELECT n FROM audit_before),
          'reapontar não gera auditoria das linhas');
SELECT ok((SELECT count(*) FROM audit_log WHERE table_name = 'classification_rules' AND action = 'insert') > 0,
          'as cópias ficam na auditoria das regras');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'statement_lines'::regclass AND NOT tgisinternal AND tgenabled <> 'O'),
          0, 'os triggers das linhas voltam ligados');

-- Depois da migração, cada conta classifica com as suas.
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500b01', NULL, 'UBER *TRIP', -2500),
          (SELECT id FROM classification_rules WHERE financial_account_id = '00000000-0000-7000-8000-000000500b01' AND pattern = 'uber'),
          'a cópia da global classifica na conta da Empresa');
SELECT is(classification_rule_for('00000000-0000-7000-8000-000000500a01', NULL, 'UBER *TRIP', -2500),
          '00000000-0000-7000-8000-0000005f0012'::uuid, 'na corrente vence a que já vencia (C2)');

SELECT * FROM finish();
ROLLBACK;
