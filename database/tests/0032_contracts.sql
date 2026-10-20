-- Testes de 0032_contracts: contratos, ciclos, parcelas (títulos origin = contract) e espelho, documentos PDF e
-- markdown versionado, aditivos, tarefas de renovação, eventos de mensagem/notificação e auditoria.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Roda o SQL, força as checagens do COMMIT e devolve "SQLSTATE constraint" do erro (ou 'ok'). Em erro, desfaz.
CREATE FUNCTION pg_temp.violation(p_sql text) RETURNS text
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

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura -----------------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['contracts', 'contract_cycles', 'contract_documents', 'contract_document_versions',
                                      'contract_amendments', 'contract_renewal_tasks']) t;
SELECT columns_are('contracts', ARRAY['id', 'caixa_id', 'entity_id', 'direction', 'name', 'contract_number', 'category_id',
  'counterparty_caixa_id', 'status', 'auto_renew', 'notice_days', 'renewal_lead_days', 'reminder_every_days',
  'readjustment_index', 'readjustment_base_date', 'termination_penalty_text', 'termination_penalty_cents', 'terminated_on',
  'termination_notes', 'notes', 'created_by', 'archived_at', 'created_at', 'updated_at',
  -- 0051 (pagamentos no extrato)
  'payment_account_id', 'transit_account_id', 'late_fee_percent', 'interest_month_percent', 'early_discount_percent',
  'tolerance_cents', 'match_window_days', 'auto_settle']);
SELECT columns_are('contract_cycles', ARRAY['id', 'contract_id', 'seq', 'starts_on', 'duration_months', 'ends_on',
  'periodicity', 'installments_count', 'total_cents', 'due_day', 'due_month_offset', 'readjustment_percent',
  'created_at', 'updated_at']);
SELECT columns_are('contract_documents', ARRAY['id', 'contract_id', 'kind', 'format', 'title', 'description',
  'document_date', 'attachment_id', 'current_version_id', 'source_document_id', 'created_by', 'archived_at',
  'created_at', 'updated_at']);
SELECT columns_are('contract_document_versions', ARRAY['id', 'document_id', 'version', 'content', 'note', 'author_kind',
  'author_user_id', 'ai_run_id', 'restored_from_version_id', 'created_at', 'updated_at']);
SELECT columns_are('contract_amendments', ARRAY['id', 'contract_id', 'contract_cycle_id', 'document_id', 'effective_on',
  'changes', 'affected_title_ids', 'skipped_title_ids', 'notes', 'created_by', 'created_at', 'updated_at']);
SELECT columns_are('contract_renewal_tasks', ARRAY['id', 'contract_id', 'contract_cycle_id', 'status', 'opened_on',
  'due_on', 'decided_at', 'decided_by', 'decision_notes', 'new_cycle_id', 'created_at', 'updated_at']);
SELECT has_column('titles', c) FROM unnest(ARRAY['contract_id', 'contract_cycle_id', 'contract_installment']) c;
SELECT is((SELECT attgenerated::text FROM pg_attribute WHERE attrelid = 'contract_cycles'::regclass AND attname = c), 's',
          c || ' é coluna gerada') FROM unnest(ARRAY['ends_on', 'installments_count']) c;

SELECT fk_ok('contracts', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('contracts', 'entity_id', 'entities', 'id');
SELECT fk_ok('contracts', 'category_id', 'categories', 'id');
SELECT fk_ok('contracts', 'counterparty_caixa_id', 'caixas', 'id');
SELECT fk_ok('contracts', 'created_by', 'users', 'id');
SELECT fk_ok('contract_cycles', 'contract_id', 'contracts', 'id');
SELECT fk_ok('titles', 'contract_id', 'contracts', 'id');
SELECT fk_ok('titles', ARRAY['contract_cycle_id', 'contract_id'], 'contract_cycles', ARRAY['id', 'contract_id']);
SELECT fk_ok('contract_documents', 'contract_id', 'contracts', 'id');
SELECT fk_ok('contract_documents', 'attachment_id', 'attachments', 'id');
SELECT fk_ok('contract_documents', ARRAY['current_version_id', 'id'], 'contract_document_versions', ARRAY['id', 'document_id']);
SELECT fk_ok('contract_documents', ARRAY['source_document_id', 'contract_id'], 'contract_documents', ARRAY['id', 'contract_id']);
SELECT fk_ok('contract_document_versions', 'document_id', 'contract_documents', 'id');
SELECT fk_ok('contract_document_versions', 'ai_run_id', 'ai_runs', 'id');
SELECT fk_ok('contract_document_versions', ARRAY['restored_from_version_id', 'document_id'],
             'contract_document_versions', ARRAY['id', 'document_id']);
SELECT fk_ok('contract_amendments', ARRAY['contract_cycle_id', 'contract_id'], 'contract_cycles', ARRAY['id', 'contract_id']);
SELECT fk_ok('contract_amendments', ARRAY['document_id', 'contract_id'], 'contract_documents', ARRAY['id', 'contract_id']);
SELECT fk_ok('contract_renewal_tasks', ARRAY['contract_cycle_id', 'contract_id'], 'contract_cycles', ARRAY['id', 'contract_id']);
SELECT fk_ok('contract_renewal_tasks', ARRAY['new_cycle_id', 'contract_id'], 'contract_cycles', ARRAY['id', 'contract_id']);

SELECT has_index('contracts', i) FROM unnest(ARRAY['contracts_caixa_id_idx', 'contracts_entity_id_idx',
  'contracts_category_id_idx', 'contracts_counterparty_caixa_id_idx', 'contracts_status_idx', 'contracts_created_by_idx',
  'contracts_contract_number_key']) i;
SELECT has_index('titles', i) FROM unnest(ARRAY['titles_contract_id_idx', 'titles_contract_installment_key']) i;
SELECT has_index('contract_documents', i) FROM unnest(ARRAY['contract_documents_contract_id_idx',
  'contract_documents_attachment_id_idx', 'contract_documents_current_version_id_idx',
  'contract_documents_source_document_id_idx', 'contract_documents_created_by_idx']) i;
SELECT has_index('contract_renewal_tasks', i) FROM unnest(ARRAY['contract_renewal_tasks_contract_id_idx',
  'contract_renewal_tasks_open_key', 'contract_renewal_tasks_new_cycle_id_idx', 'contract_renewal_tasks_decided_by_idx']) i;

-- Toda FK das tabelas novas (e as novas de titles) tem índice começando pelas colunas da FK.
SELECT is_empty($$
  SELECT c.conrelid::regclass::text || '.' || c.conname
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN ('contracts'::regclass, 'contract_cycles'::regclass, 'contract_documents'::regclass,
                        'contract_document_versions'::regclass, 'contract_amendments'::regclass,
                        'contract_renewal_tasks'::regclass, 'titles'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_index i
                      WHERE i.indrelid = c.conrelid AND (i.indkey::int2[])[0] = c.conkey[1])
$$, 'toda FK nova tem índice começando pela sua primeira coluna');

SELECT has_trigger('contracts', t) FROM unnest(ARRAY['contracts_validate', 'contracts_renewal_pending_check',
  'contracts_audit', 'contracts_set_updated_at']) t;
SELECT has_trigger('titles', t) FROM unnest(ARRAY['titles_validate_contract', 'titles_contract_integrity_check',
  'titles_mirror_check']) t;
SELECT has_trigger(t, t || '_audit') FROM unnest(ARRAY['contract_cycles', 'contract_documents', 'contract_document_versions',
  'contract_amendments', 'contract_renewal_tasks']) t;
SELECT ok(has_table_privilege('moneyflow_app', t, 'SELECT, INSERT, UPDATE, DELETE'), 'app tem DML em ' || t)
  FROM unnest(ARRAY['contracts', 'contract_cycles', 'contract_documents', 'contract_document_versions',
                    'contract_amendments', 'contract_renewal_tasks']) t;

-- Dados base -----------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo-123', 'admin');
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-00000000e003', 'company', 'ACME Ltda'),
  ('00000000-0000-7000-8000-00000000e004', 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true),
  ('00000000-0000-7000-8000-0000000c0003', 'ACME', 'general', '00000000-0000-7000-8000-00000000e003', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e004',
   '00000000-0000-7000-8000-0000000c0002', 100000, 3, 10, '1234');
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'income', 'Receita de serviços'),
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Serviços contratados');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'contrato-acme.pdf', 'application/pdf', '\x255044462d'),
  ('00000000-0000-7000-8000-0000000a7002', 'aditivo-01.pdf', 'application/pdf', '\x255044462d31');

-- Contrato: regras imediatas -------------------------------------------------------------------------------------------
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id)
  VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000000e003', 'payable', 'X',
          '00000000-0000-7000-8000-00000000ca02')$$), '23514 contracts_caixa_kind_check', 'contrato só em caixa general');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e002', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01')$$), '23514 contracts_entity_check', 'contraparte diferente do titular');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca02')$$), '23514 contracts_category_kind_check', 'receivable exige income');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, counterparty_caixa_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', '00000000-0000-7000-8000-0000000c0001')$$),
          '23514 contracts_counterparty_caixa_check', 'caixa da contraparte é do titular = entidade');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', '  ',
          '00000000-0000-7000-8000-00000000ca01')$$), '23514 contracts_name_check', 'nome obrigatório');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, contract_number)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', repeat('9', 61))$$), '23514 contracts_contract_number_check', 'número ≤ 60');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, notice_days)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', 366)$$), '23514 contracts_notice_days_check', 'aviso prévio 0–365');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, reminder_every_days)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', 31)$$), '23514 contracts_reminder_every_days_check', 'lembrete 1–30');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, readjustment_index)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', 'selic')$$), '23514 contracts_readjustment_index_check', 'índice fechado');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, termination_penalty_cents)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', 0)$$), '23514 contracts_termination_penalty_cents_check', 'multa > 0');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, terminated_on)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003', 'receivable', 'X',
          '00000000-0000-7000-8000-00000000ca01', '2025-05-01')$$), '23514 contracts_terminated_check',
          'terminated_on só com status terminated');

-- Contrato K1: Minha Empresa recebe da ACME (que tem caixa: as parcelas espelham).
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, contract_number, category_id, counterparty_caixa_id,
                       auto_renew, created_by)
VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e003',
        'receivable', 'Suporte mensal ACME', 'CT-001', '00000000-0000-7000-8000-00000000ca01',
        '00000000-0000-7000-8000-0000000c0003', true, '00000000-0000-7000-8000-0000000000a1');
SELECT is((SELECT status || '/' || notice_days || '/' || renewal_lead_days || '/' || reminder_every_days || '/' || readjustment_index
             FROM contracts WHERE id = '00000000-0000-7000-8000-000000000c01'), 'draft/30/60/7/none', 'padrões');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, contract_number)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e001', 'payable', 'Outro',
          '00000000-0000-7000-8000-00000000ca02', 'ct-001')$$), '23505 contracts_contract_number_key',
          'número único por caixa sem distinção de maiúsculas');
SELECT is(pg_temp.violation($$INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, contract_number)
  VALUES ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000e003', 'payable', 'Outro',
          '00000000-0000-7000-8000-00000000ca02', 'CT-001')$$), 'ok', 'mesmo número em outra caixa');
SELECT is(pg_temp.violation($$UPDATE contracts SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000000c01';
  INSERT INTO contracts (caixa_id, entity_id, direction, name, category_id, contract_number)
  VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e001', 'payable', 'Outro',
          '00000000-0000-7000-8000-00000000ca02', 'CT-001');
  SELECT 1/0$$), '22012 -', 'arquivado libera o número (o 1/0 desfaz o bloco)');
SELECT is(pg_temp.violation($$UPDATE contracts SET entity_id = '00000000-0000-7000-8000-00000000e001',
  counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0001' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
  'ok', 'no rascunho a contraparte muda');
UPDATE contracts SET entity_id = '00000000-0000-7000-8000-00000000e003', counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0003'
 WHERE id = '00000000-0000-7000-8000-000000000c01';
SELECT is(pg_temp.violation($$UPDATE contracts SET direction = 'payable', category_id = '00000000-0000-7000-8000-00000000ca02'
  WHERE id = '00000000-0000-7000-8000-000000000c01'$$), '23514 contracts_direction_immutable_check', 'direção imutável');
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'ended' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_status_transition_check', 'rascunho só vai para vigente');

-- Ciclos ---------------------------------------------------------------------------------------------------------------
INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day, due_month_offset)
VALUES ('00000000-0000-7000-8000-000000000d01', '00000000-0000-7000-8000-000000000c01', 1, '2025-03-01', 12, 'monthly',
        6000001, 10, 1);
SELECT is((SELECT ends_on FROM contract_cycles WHERE id = '00000000-0000-7000-8000-000000000d01'), date '2026-02-28',
          '01/03/2025 + 12 meses vai até 28/02/2026');
SELECT is((SELECT installments_count FROM contract_cycles WHERE id = '00000000-0000-7000-8000-000000000d01'), 12::smallint,
          'mensal de 12 meses = 12 parcelas');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 12, 'monthly', 100, 10);
  SELECT 1/0$$), '22012 -', 'ciclo seguinte contíguo passa (desfeito)');

CREATE TEMP TABLE cycle_cases (s date, n int, p text, ends date, cnt int);
INSERT INTO cycle_cases VALUES
  ('2023-03-01', 12, 'annual', '2024-02-29', 1), ('2025-01-31', 1, 'single', '2025-02-28', 1),
  ('2025-03-31', 1, 'monthly', '2025-04-30', 1), ('2025-01-30', 1, 'monthly', '2025-02-28', 1),
  ('2024-01-29', 1, 'single', '2024-02-28', 1), ('2025-03-31', 6, 'quarterly', '2025-09-30', 2),
  ('2025-03-15', 12, 'semiannual', '2026-03-14', 2), ('2025-02-01', 24, 'single', '2027-01-31', 1);
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id)
VALUES ('00000000-0000-7000-8000-000000000c09', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000e004',
        'payable', 'Casos de ciclo', '00000000-0000-7000-8000-00000000ca02');
INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
SELECT '00000000-0000-7000-8000-000000000c09', row_number() OVER (ORDER BY s), s, n, p, 100, 1 FROM cycle_cases;
SELECT is(
  (SELECT count(*)::int FROM contract_cycles y JOIN cycle_cases c ON c.s = y.starts_on AND c.n = y.duration_months
    WHERE y.contract_id = '00000000-0000-7000-8000-000000000c09' AND y.ends_on = c.ends AND y.installments_count = c.cnt),
  8, 'ends_on e parcelas: ano bissexto, fim de mês (31/01+1 → 28/02, 31/03+1 → 30/04, 30/01+1 → 28/02, 29/01/2024+1 → 28/02), trimestral, semestral e parcela única');
SELECT is(pg_temp.violation('SELECT 1'), '23514 contract_cycles_contiguous_check', 'ciclos não contíguos falham no COMMIT');
DELETE FROM contracts WHERE id = '00000000-0000-7000-8000-000000000c09';
SELECT is(pg_temp.violation('SELECT 1'), 'ok', 'rascunho excluído leva os ciclos');
SELECT is(pg_temp.violation($$
  INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id)
  VALUES ('00000000-0000-7000-8000-000000000c08', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000e004',
          'payable', 'Fim de mês', '00000000-0000-7000-8000-00000000ca02');
  INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day) VALUES
    ('00000000-0000-7000-8000-000000000c08', 1, '2025-01-31', 1, 'monthly', 100, 31),
    ('00000000-0000-7000-8000-000000000c08', 2, '2025-03-01', 1, 'monthly', 100, 31);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT 1/0$$), '22012 -', 'ciclo de 31/01 vai até 28/02 e o seguinte começa em 01/03 (desfeito)');

SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 10, 'quarterly', 100, 10)$$),
  '23514 contract_cycles_duration_periodicity_check', 'duração múltipla do período');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 121, 'monthly', 1000, 10)$$),
  '23514 contract_cycles_duration_months_check', 'duração 1–120');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 12, 'monthly', 11, 10)$$),
  '23514 contract_cycles_total_cents_check', 'ao menos 1 centavo por parcela');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day, due_month_offset)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 12, 'monthly', 1200, 10, 4)$$),
  '23514 contract_cycles_due_month_offset_check', 'deslocamento 0–3');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 2, '2026-03-02', 12, 'monthly', 1200, 10)$$),
  '23514 contract_cycles_contiguous_check', 'o ciclo seguinte começa no dia seguinte ao fim');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 3, '2026-03-01', 12, 'monthly', 1200, 10)$$),
  '23514 contract_cycles_contiguous_check', 'seq sem buracos');
SELECT is(pg_temp.violation($$INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000c01', 1, '2026-03-01', 12, 'monthly', 1200, 10)$$),
  '23505 contract_cycles_contract_seq_key', 'seq único no contrato');
SELECT is(pg_temp.violation($$UPDATE contract_cycles SET seq = 2 WHERE id = '00000000-0000-7000-8000-000000000d01'$$),
  '23514 contract_cycles_immutable_check', 'seq imutável');
SELECT is(pg_temp.violation($$UPDATE contract_cycles SET starts_on = '2025-04-01' WHERE id = '00000000-0000-7000-8000-000000000d01';
  SELECT 1/0$$), '22012 -', 'sem títulos, o início do ciclo muda');

-- Títulos do contrato ---------------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.parcel_sql(p_n int, p_extra text DEFAULT '') RETURNS text
LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                       amount_cents, origin, contract_id, contract_cycle_id, contract_installment)
    VALUES (%L, '00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e003',
            '00000000-0000-7000-8000-00000000ca01', %L, %L, %L, %s, 'contract', '00000000-0000-7000-8000-000000000c01',
            '00000000-0000-7000-8000-000000000d01', %s) %s$f$,
    ('00000000-0000-7000-8000-0000000f01' || lpad(p_n::text, 2, '0'))::uuid,
    'Suporte mensal ACME ' || p_n || '/12',
    (date '2025-03-01' + make_interval(months => p_n - 1))::date,
    (date '2025-04-10' + make_interval(months => p_n - 1))::date,
    CASE WHEN p_n = 1 THEN 500012 ELSE 499999 END, p_n, p_extra)
$$;

SELECT is(pg_temp.violation(pg_temp.parcel_sql(2)), '23514 contracts_draft_titles_check', 'rascunho não tem títulos (no COMMIT)');
SELECT is(pg_temp.violation($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                                  amount_cents, origin)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e003',
          '00000000-0000-7000-8000-00000000ca01', 'X', '2025-03-01', '2025-04-10', 100, 'contract')$$),
  '23514 titles_contract_check', 'origin contract exige o contrato');
SELECT is(pg_temp.violation($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                                  amount_cents, origin, contract_id, contract_cycle_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e003',
          '00000000-0000-7000-8000-00000000ca01', 'X', '2025-03-01', '2025-04-10', 100, 'contract',
          '00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01')$$),
  '23514 titles_contract_check', 'ciclo e número da parcela andam juntos');
SELECT is(pg_temp.violation($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                                  amount_cents, contract_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e003',
          '00000000-0000-7000-8000-00000000ca01', 'X', '2025-03-01', '2025-04-10', 100, '00000000-0000-7000-8000-000000000c01')$$),
  '23514 titles_contract_check', 'contrato exige origin contract');

-- Ativar: status e as 12 parcelas na mesma transação (a 1ª espelhada na caixa da ACME).
SELECT is(pg_temp.violation($$
  UPDATE contracts SET status = 'active' WHERE id = '00000000-0000-7000-8000-000000000c01';
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, contract_id, contract_cycle_id, contract_installment, counterparty_caixa_id, mirror_title_id,
                      mirror_status)
  VALUES ('00000000-0000-7000-8000-0000000f0101', '00000000-0000-7000-8000-0000000c0002', 'receivable',
          '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-00000000ca01', 'Suporte mensal ACME 1/12',
          '2025-03-01', '2025-04-10', 500012, 'contract', '00000000-0000-7000-8000-000000000c01',
          '00000000-0000-7000-8000-000000000d01', 1, '00000000-0000-7000-8000-0000000c0003', '00000000-0000-7000-8000-0000000f0201', NULL),
         ('00000000-0000-7000-8000-0000000f0201', '00000000-0000-7000-8000-0000000c0003', 'payable',
          '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000ca02', 'Suporte mensal ACME 1/12',
          '2025-03-01', '2025-04-10', 500012, 'contract', '00000000-0000-7000-8000-000000000c01',
          '00000000-0000-7000-8000-000000000d01', 1, '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000f0101',
          'pending');
$$), 'ok', 'ativar: vigente com a 1ª parcela espelhada');
SELECT is(pg_temp.violation(string_agg(pg_temp.parcel_sql(n), '; ')), 'ok', 'parcelas 2 a 12')
  FROM generate_series(2, 12) n;
SELECT results_eq($$SELECT count(*)::int, sum(amount_cents)::bigint FROM titles
                     WHERE contract_cycle_id = '00000000-0000-7000-8000-000000000d01' AND mirror_status IS NULL$$,
                  $$VALUES (12, 6000001::bigint)$$, '12 parcelas somando o valor do ciclo');

SELECT is(pg_temp.violation(pg_temp.parcel_sql(13)), '23514 titles_contract_installment_total_check', 'parcela ≤ N do ciclo');
SELECT is(pg_temp.violation(replace(pg_temp.parcel_sql(2), '0000000f0102', '0000000f0199')),
          '23505 titles_contract_installment_key', 'uma parcela n por ciclo em cada caixa');
SELECT is(pg_temp.violation(replace(replace(pg_temp.parcel_sql(3), '0000000f0103', '0000000f0198'),
                                    '0000000c0002', '0000000c0001')),
          '23514 titles_contract_caixa_check', 'lado original fica na caixa do contrato');
SELECT is(pg_temp.violation($$UPDATE titles SET entity_id = '00000000-0000-7000-8000-00000000e001'
                               WHERE id = '00000000-0000-7000-8000-0000000f0105'$$),
          '23514 titles_contract_match_check', 'parcela segue a contraparte do contrato');
SELECT is(pg_temp.violation($$UPDATE titles SET counterparty_caixa_id = '00000000-0000-7000-8000-0000000c0001'
                               WHERE id = '00000000-0000-7000-8000-0000000f0201'$$),
          '23514 titles_contract_caixa_check', 'o espelho aponta para a caixa do contrato');
SELECT is(pg_temp.violation($$UPDATE titles SET contract_installment = 2 WHERE id = '00000000-0000-7000-8000-0000000f0201'$$),
          '23514 titles_mirror_match_check', 'espelho com o mesmo contrato, ciclo e parcela');
SELECT is(pg_temp.violation($$UPDATE titles SET amount_cents = 480000 WHERE id IN ('00000000-0000-7000-8000-0000000f0101',
                                                                                   '00000000-0000-7000-8000-0000000f0201')$$),
          'ok', 'aditivo muda o valor dos dois lados');
-- Título extra (multa) sem ciclo, em qualquer direção.
SELECT is(pg_temp.violation($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date,
                                                  amount_cents, origin, contract_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e003',
          '00000000-0000-7000-8000-00000000ca02', 'Multa rescisória', '2025-06-01', '2025-06-10', 10000, 'contract',
          '00000000-0000-7000-8000-000000000c01')$$), 'ok', 'título extra ligado ao contrato');

SELECT is(pg_temp.violation($$UPDATE contract_cycles SET duration_months = 24 WHERE id = '00000000-0000-7000-8000-000000000d01'$$),
          '23514 contract_cycles_locked_check', 'com títulos, a duração não muda');
SELECT is(pg_temp.violation($$UPDATE contract_cycles SET periodicity = 'single' WHERE id = '00000000-0000-7000-8000-000000000d01'$$),
          '23514 contract_cycles_locked_check', 'com títulos, a periodicidade não muda');
SELECT is(pg_temp.violation($$UPDATE contract_cycles SET total_cents = 5760001, due_day = 15, due_month_offset = 0
                               WHERE id = '00000000-0000-7000-8000-000000000d01'$$), 'ok', 'o aditivo muda valor e vencimento');
SELECT is(pg_temp.violation($$UPDATE contracts SET caixa_id = '00000000-0000-7000-8000-0000000c0001'
                               WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_party_immutable_check', 'caixa imutável fora do rascunho');
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'draft' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_status_transition_check', 'nada volta para rascunho');
SELECT is(pg_temp.violation($$DELETE FROM contracts WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_delete_check', 'só rascunho é excluído');
SELECT is(pg_temp.violation($$UPDATE contracts SET name = 'Suporte ACME', notes = 'renegociado', notice_days = 45
                               WHERE id = '00000000-0000-7000-8000-000000000c01'$$), 'ok', 'descrição e avisos livres');

-- Renovação ------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'renewal_pending' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_renewal_pending_check', 'renovação pendente exige tarefa aberta');
SELECT is(pg_temp.violation($$INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, opened_on, due_on)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01', '2025-12-30', '2026-02-28')$$),
          '23514 contracts_renewal_pending_check', 'tarefa aberta exige contrato em renovação pendente');
SELECT is(pg_temp.violation($$INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, opened_on, due_on)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01', '2025-12-30', '2026-03-01')$$),
          '23514 contract_renewal_tasks_due_on_check', 'due_on = fim do ciclo');
SELECT is(pg_temp.violation($$INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, opened_on, due_on, status, decided_at)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01', '2025-12-30', '2026-02-28',
          'approved', now())$$), '23514 contract_renewal_tasks_decision_check', 'aprovada exige o novo ciclo');
SELECT is(pg_temp.violation($$
  INSERT INTO contract_renewal_tasks (id, contract_id, contract_cycle_id, opened_on, due_on)
  VALUES ('00000000-0000-7000-8000-000000000e01', '00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01',
          '2025-12-30', '2026-02-28');
  UPDATE contracts SET status = 'renewal_pending' WHERE id = '00000000-0000-7000-8000-000000000c01'$$), 'ok',
  'worker abre a tarefa e o contrato fica em renovação pendente');
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'terminated', terminated_on = '2025-12-31'
                               WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_renewal_pending_check', 'rescindir exige fechar a tarefa aberta');
SELECT is(pg_temp.violation($$UPDATE contract_renewal_tasks SET status = 'declined', decided_at = now()
                               WHERE id = '00000000-0000-7000-8000-000000000e01'$$),
          '23514 contracts_renewal_pending_check', 'recusar também tira o contrato de renovação pendente');
SELECT is(pg_temp.violation($$UPDATE contract_renewal_tasks SET contract_cycle_id = '00000000-0000-7000-8000-000000000d01',
                                                                   contract_id = '00000000-0000-7000-8000-000000000c01',
                                                                   opened_on = '2025-12-31'
                               WHERE id = '00000000-0000-7000-8000-000000000e01'$$), 'ok', 'tarefa aberta é editável');

-- Aprovar: ciclo 2 (reajuste de 4,5%), tarefa aprovada e contrato de volta a vigente.
SELECT is(pg_temp.violation($$
  INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day,
                               due_month_offset, readjustment_percent)
  VALUES ('00000000-0000-7000-8000-000000000d02', '00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 12, 'monthly',
          6270001, 10, 1, 4.5);
  INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day)
  VALUES ('00000000-0000-7000-8000-000000000d03', '00000000-0000-7000-8000-000000000c01', 3, '2027-03-01', 12, 'monthly', 1200, 10);
  UPDATE contract_renewal_tasks SET status = 'approved', decided_at = now(), new_cycle_id = '00000000-0000-7000-8000-000000000d03'
   WHERE id = '00000000-0000-7000-8000-000000000e01'$$),
  '23514 contract_renewal_tasks_new_cycle_check', 'o novo ciclo é o seguinte (seq + 1)');
SELECT is(pg_temp.violation($$
  INSERT INTO contract_cycles (id, contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day,
                               due_month_offset, readjustment_percent)
  VALUES ('00000000-0000-7000-8000-000000000d02', '00000000-0000-7000-8000-000000000c01', 2, '2026-03-01', 12, 'monthly',
          6270001, 10, 1, 4.5);
  UPDATE contract_renewal_tasks SET status = 'approved', decided_at = now(), decided_by = '00000000-0000-7000-8000-0000000000a1',
                                    new_cycle_id = '00000000-0000-7000-8000-000000000d02'
   WHERE id = '00000000-0000-7000-8000-000000000e01';
  UPDATE contracts SET status = 'active' WHERE id = '00000000-0000-7000-8000-000000000c01'$$), 'ok', 'renovar');
SELECT is((SELECT ends_on FROM contract_cycles WHERE id = '00000000-0000-7000-8000-000000000d02'), date '2027-02-28',
          'ciclo 2 até 28/02/2027');
SELECT is(pg_temp.violation($$UPDATE contract_renewal_tasks SET decision_notes = 'reajuste IPCA'
                               WHERE id = '00000000-0000-7000-8000-000000000e01'$$), 'ok', 'nota da decisão editável');
SELECT is(pg_temp.violation($$UPDATE contract_renewal_tasks SET status = 'declined', new_cycle_id = NULL
                               WHERE id = '00000000-0000-7000-8000-000000000e01'$$),
          '23514 contract_renewal_tasks_final_check', 'decidida é final');
SELECT is(pg_temp.violation($$INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, opened_on, due_on)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01', '2026-01-01', '2026-02-28')$$),
          '23505 contract_renewal_tasks_contract_cycle_id_key', 'uma tarefa por ciclo');
SELECT is(pg_temp.violation($$
  INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, opened_on, due_on)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d02', '2026-12-30', '2027-02-28');
  UPDATE contracts SET status = 'renewal_pending' WHERE id = '00000000-0000-7000-8000-000000000c01';
  UPDATE contracts SET status = 'ended' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
  '23514 contracts_renewal_pending_check', 'encerrado com tarefa aberta falha');
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'terminated', terminated_on = '2026-06-30'
                               WHERE id = '00000000-0000-7000-8000-000000000c01';
                             UPDATE contracts SET status = 'active', terminated_on = NULL
                               WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          '23514 contracts_status_transition_check', 'rescindido é final');
SELECT is(pg_temp.violation($$UPDATE contracts SET status = 'ended' WHERE id = '00000000-0000-7000-8000-000000000c01';
                             UPDATE contracts SET status = 'active' WHERE id = '00000000-0000-7000-8000-000000000c01'$$),
          'ok', 'encerrado volta a vigente (renovação tardia)');

-- Documentos ------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.violation($$INSERT INTO contract_documents (contract_id, kind, format, title)
  VALUES ('00000000-0000-7000-8000-000000000c01', 'contract', 'pdf', 'Contrato')$$),
  '23514 contract_documents_format_fields_check', 'PDF exige o anexo');
SELECT is(pg_temp.violation($$INSERT INTO contract_documents (contract_id, kind, format, title, attachment_id)
  VALUES ('00000000-0000-7000-8000-000000000c01', 'contract', 'markdown', 'Contrato', '00000000-0000-7000-8000-0000000a7001')$$),
  '23514 contract_documents_format_fields_check', 'markdown não tem anexo');
SELECT is(pg_temp.violation($$INSERT INTO contract_documents (contract_id, kind, format, title, attachment_id)
  VALUES ('00000000-0000-7000-8000-000000000c01', 'memo', 'pdf', 'Contrato', '00000000-0000-7000-8000-0000000a7001')$$),
  '23514 contract_documents_kind_check', 'tipo fechado');
INSERT INTO contract_documents (id, contract_id, kind, format, title, document_date, attachment_id, created_by) VALUES
  ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-000000000c01', 'contract', 'pdf', 'contrato-acme.pdf',
   '2025-03-01', '00000000-0000-7000-8000-0000000a7001', '00000000-0000-7000-8000-0000000000a1'),
  ('00000000-0000-7000-8000-00000000d002', '00000000-0000-7000-8000-000000000c01', 'amendment', 'pdf', 'aditivo-01.pdf',
   '2025-08-01', '00000000-0000-7000-8000-0000000a7002', NULL);
SELECT results_eq($$SELECT target_kind, target_id FROM attachment_links WHERE attachment_id = '00000000-0000-7000-8000-0000000a7001'$$,
                  $$VALUES ('contract_document', '00000000-0000-7000-8000-00000000d001'::uuid)$$,
                  'o PDF do documento aparece em attachment_links');
SELECT is(pg_temp.violation($$UPDATE contract_documents SET attachment_id = '00000000-0000-7000-8000-0000000a7002'
                               WHERE id = '00000000-0000-7000-8000-00000000d001'$$),
          '23514 contract_documents_immutable_check', 'anexo imutável');
SELECT is(pg_temp.violation($$DELETE FROM attachments WHERE id = '00000000-0000-7000-8000-0000000a7001'$$),
          '23503 contract_documents_attachment_id_fkey', 'anexo de documento não é excluído');
SELECT is(pg_temp.violation($$UPDATE contract_documents SET title = 'Contrato assinado', archived_at = now()
                               WHERE id = '00000000-0000-7000-8000-00000000d001'; SELECT 1/0$$), '22012 -',
          'título e arquivamento livres');

-- Markdown: versão 1 gerada por IA a partir do PDF, depois edições e restauração.
SELECT is(pg_temp.violation($$INSERT INTO contract_documents (contract_id, kind, format, title)
  VALUES ('00000000-0000-7000-8000-000000000c01', 'contract', 'markdown', 'contrato-acme.md')$$),
  '23514 contract_documents_current_version_check', 'markdown precisa de versão atual no COMMIT');
SELECT is(pg_temp.violation($$
  INSERT INTO contract_documents (id, contract_id, kind, format, title, source_document_id)
  VALUES ('00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-000000000c01', 'contract', 'markdown',
          'contrato-acme.md', '00000000-0000-7000-8000-00000000d001');
  INSERT INTO contract_document_versions (id, document_id, content, author_kind)
  VALUES ('00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000d003', '# Contrato ACME', 'agent');
  UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-00000000f001'
   WHERE id = '00000000-0000-7000-8000-00000000d003'$$), 'ok', 'markdown gerado do PDF com a versão 1');
SELECT is((SELECT version FROM contract_document_versions WHERE id = '00000000-0000-7000-8000-00000000f001'), 1, 'versão 1');
INSERT INTO contract_document_versions (id, document_id, content, note, author_user_id) VALUES
  ('00000000-0000-7000-8000-00000000f002', '00000000-0000-7000-8000-00000000d003', '# Contrato ACME\n\nCláusula 1', 'revisão',
   '00000000-0000-7000-8000-0000000000a1');
INSERT INTO contract_document_versions (id, document_id, version, content, author_user_id, restored_from_version_id) VALUES
  ('00000000-0000-7000-8000-00000000f003', '00000000-0000-7000-8000-00000000d003', 3, '# Contrato ACME',
   '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-00000000f001');
UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-00000000f003'
 WHERE id = '00000000-0000-7000-8000-00000000d003';
SELECT results_eq($$SELECT version, author_kind FROM contract_document_versions
                     WHERE document_id = '00000000-0000-7000-8000-00000000d003' ORDER BY version$$,
                  $$VALUES (1, 'agent'), (2, 'human'), (3, 'human')$$, 'versões numeradas pelo banco');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, version, content)
  VALUES ('00000000-0000-7000-8000-00000000d003', 5, 'x')$$), '23514 contract_document_versions_version_check',
  'versão informada tem de ser a próxima');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, content)
  VALUES ('00000000-0000-7000-8000-00000000d001', 'x')$$), '23514 contract_document_versions_document_check',
  'PDF não tem versões');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, content)
  VALUES ('00000000-0000-7000-8000-00000000d003', repeat('a', 1048577))$$), '23514 contract_document_versions_content_check',
  'conteúdo até 1 MB');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, content)
  VALUES ('00000000-0000-7000-8000-00000000d003', '')$$), 'ok', 'conteúdo vazio vale');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, content, author_kind, ai_run_id)
  VALUES ('00000000-0000-7000-8000-00000000d003', 'x', 'human', '00000000-0000-7000-8000-0000000b2001')$$),
  '23514 contract_document_versions_author_check', 'execução de agente só em versão do agente');
SELECT is(pg_temp.violation($$INSERT INTO contract_document_versions (document_id, content, restored_from_version_id)
  VALUES ('00000000-0000-7000-8000-00000000d003', 'x', '00000000-0000-7000-8000-00000000f999')$$),
  '23503 contract_document_versions_restored_from_version_id_fkey', 'restaura uma versão do mesmo documento');
SELECT is(pg_temp.violation($$UPDATE contract_document_versions SET content = 'editado'
                               WHERE id = '00000000-0000-7000-8000-00000000f002'$$),
          '23514 contract_document_versions_immutable_check', 'versão imutável');
SELECT is(pg_temp.violation($$DELETE FROM contract_document_versions WHERE id = '00000000-0000-7000-8000-00000000f002'$$),
          '23514 contract_document_versions_immutable_check', 'versão não é excluída sozinha');
SELECT is(pg_temp.violation($$UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-00000000f003'
                               WHERE id = '00000000-0000-7000-8000-00000000d002'$$),
          '23514 contract_documents_format_fields_check', 'PDF não tem versão atual');
SELECT is(pg_temp.violation($$UPDATE contract_documents SET format = 'pdf' WHERE id = '00000000-0000-7000-8000-00000000d003'$$),
          '23514 contract_documents_immutable_check', 'formato imutável');
SELECT is(pg_temp.violation($$UPDATE contract_documents SET source_document_id = '00000000-0000-7000-8000-00000000d003'
                               WHERE id = '00000000-0000-7000-8000-00000000d003'$$),
          '23514 contract_documents_source_check', 'o markdown não é a própria origem');
SELECT is(pg_temp.violation($$
  INSERT INTO contract_documents (id, contract_id, kind, format, title, source_document_id)
  VALUES ('00000000-0000-7000-8000-00000000d004', '00000000-0000-7000-8000-000000000c01', 'other', 'markdown', 'nota',
          '00000000-0000-7000-8000-00000000d003')$$), '23514 contract_documents_source_check', 'a origem é um PDF');

-- Usuário removido: as FKs SET NULL passam pela imutabilidade da versão.
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo-456', 'user');
INSERT INTO contract_document_versions (id, document_id, content, author_user_id) VALUES
  ('00000000-0000-7000-8000-00000000f004', '00000000-0000-7000-8000-00000000d003', 'v4', '00000000-0000-7000-8000-0000000000a2');
SELECT is(pg_temp.violation($$DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000a2'$$), 'ok',
          'excluir o autor anula author_user_id');
DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000a2';
SELECT is((SELECT author_user_id FROM contract_document_versions WHERE id = '00000000-0000-7000-8000-00000000f004'), NULL,
          'autor anulado');

-- Excluir o documento markdown leva as versões.
SELECT is(pg_temp.violation($$
  INSERT INTO contract_documents (id, contract_id, kind, format, title)
  VALUES ('00000000-0000-7000-8000-00000000d005', '00000000-0000-7000-8000-000000000c01', 'other', 'markdown', 'rascunho');
  INSERT INTO contract_document_versions (id, document_id, content)
  VALUES ('00000000-0000-7000-8000-00000000f051', '00000000-0000-7000-8000-00000000d005', 'a'),
         ('00000000-0000-7000-8000-00000000f052', '00000000-0000-7000-8000-00000000d005', 'b');
  UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-00000000f052'
   WHERE id = '00000000-0000-7000-8000-00000000d005';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  DELETE FROM contract_documents WHERE id = '00000000-0000-7000-8000-00000000d005'$$), 'ok',
  'excluir o documento leva as versões (cascata)');
SELECT is((SELECT count(*)::int FROM contract_document_versions WHERE document_id = '00000000-0000-7000-8000-00000000d005'), 0,
          'nenhuma versão órfã');

-- Aditivos ---------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.violation($$INSERT INTO contract_amendments (contract_id, contract_cycle_id, effective_on, changes)
  VALUES ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01', '2025-08-01', '{"after": {}}')$$),
  '23514 contract_amendments_changes_check', 'changes com before e after');
INSERT INTO contract_amendments (id, contract_id, contract_cycle_id, document_id, effective_on, changes, affected_title_ids,
                                 skipped_title_ids, created_by)
VALUES ('00000000-0000-7000-8000-0000000ad001', '00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000d01',
        '00000000-0000-7000-8000-00000000d002', '2025-08-01',
        '{"before": {"amount_cents": 499999, "due_day": 10}, "after": {"amount_cents": 480000, "due_day": 15}}',
        ARRAY['00000000-0000-7000-8000-0000000f0106'::uuid], ARRAY['00000000-0000-7000-8000-0000000f0101'::uuid],
        '00000000-0000-7000-8000-0000000000a1');
SELECT is(pg_temp.violation($$UPDATE contract_amendments SET effective_on = '2025-09-01'
                               WHERE id = '00000000-0000-7000-8000-0000000ad001'$$),
          '23514 contract_amendments_immutable_check', 'aditivo imutável');
SELECT is(pg_temp.violation($$UPDATE contract_amendments SET notes = 'assinado', document_id = NULL
                               WHERE id = '00000000-0000-7000-8000-0000000ad001'$$), 'ok', 'documento e notas mudam');
INSERT INTO contracts (id, caixa_id, entity_id, direction, name, category_id)
VALUES ('00000000-0000-7000-8000-000000000c02', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000e004',
        'payable', 'Internet', '00000000-0000-7000-8000-00000000ca02');
SELECT is(pg_temp.violation($$INSERT INTO contract_amendments (contract_id, contract_cycle_id, effective_on, changes)
  VALUES ('00000000-0000-7000-8000-000000000c02', '00000000-0000-7000-8000-000000000d01', '2025-08-01',
          '{"before": {}, "after": {}}')$$), '23503 contract_amendments_contract_cycle_id_fkey', 'ciclo do mesmo contrato');
SELECT is(pg_temp.violation($$INSERT INTO contract_documents (contract_id, kind, format, title, source_document_id)
  VALUES ('00000000-0000-7000-8000-000000000c02', 'other', 'markdown', 'x', '00000000-0000-7000-8000-00000000d001')$$),
  '23503 contract_documents_source_document_id_fkey', 'origem do mesmo contrato');

-- Mensagens e notificações -------------------------------------------------------------------------------------------
SELECT ok(message_subscription_params_valid('contract_ending', '{"days_before": [90, 30, 0], "send_at": "09:00"}'),
          'contract_ending com dias até 180');
SELECT ok(message_subscription_params_valid('contract_notice_deadline', '{"days_before": [180], "send_at": "08:30"}'),
          'contract_notice_deadline com 180');
SELECT ok(NOT message_subscription_params_valid('contract_ending', '{"days_before": [181], "send_at": "09:00"}'), 'máximo 180');
SELECT ok(NOT message_subscription_params_valid('contract_ending', '{"days_before": [30]}'), 'send_at obrigatório');
SELECT ok(NOT message_subscription_params_valid('contract_notice_deadline', '{"send_at": "09:00"}'), 'days_before obrigatório');
SELECT ok(NOT message_subscription_params_valid('due_reminder', '{"days_before": [90], "send_at": "09:00"}'),
          'due_reminder continua até 60');
SELECT ok(message_subscription_params_valid('contract_renewal_pending', '{"send_at": "09:00", "repeat_every_days": 7}'),
          'renovação pendente com repetição');
SELECT ok(message_subscription_params_valid('contract_renewal_pending', '{"send_at": "09:00"}'), 'repetição opcional');
SELECT ok(NOT message_subscription_params_valid('contract_renewal_pending', '{"send_at": "09:00", "repeat_every_days": 31}'),
          'repetição 1–30');
SELECT ok(message_subscription_params_valid('contract_readjustment', '{"send_at": "07:00"}'), 'reajuste');
SELECT ok(NOT message_subscription_params_valid('contract_readjustment', '{"send_at": "07:00", "days_before": [1]}'),
          'reajuste só com send_at');
INSERT INTO message_destinations (id, name, bot_token, chat_id, owner_user_id) VALUES
  ('00000000-0000-7000-8000-0000000d0001', 'Meu Telegram', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '987654321',
   '00000000-0000-7000-8000-0000000000a1');
SELECT lives_ok($$INSERT INTO message_subscriptions (destination_id, event_kind, params) VALUES
  ('00000000-0000-7000-8000-0000000d0001', 'contract_notice_deadline', '{"days_before": [60, 30], "send_at": "09:00"}'),
  ('00000000-0000-7000-8000-0000000d0001', 'contract_ending', '{"days_before": [30], "send_at": "09:00"}'),
  ('00000000-0000-7000-8000-0000000d0001', 'contract_renewal_pending', '{"send_at": "09:00", "repeat_every_days": 7}'),
  ('00000000-0000-7000-8000-0000000d0001', 'contract_readjustment', '{"send_at": "09:00"}')$$, 'assinaturas dos eventos de contrato');
SELECT lives_ok($$INSERT INTO message_outbox (destination_id, event_kind, dedup_key, payload) VALUES
  ('00000000-0000-7000-8000-0000000d0001', 'contract_ending',
   'contract_ending:00000000-0000-7000-8000-000000000c01:00000000-0000-7000-8000-000000000d01:D-30', '{"text": "x"}')$$,
  'outbox aceita o evento');
SELECT lives_ok($$INSERT INTO notifications (user_id, kind, title, link, dedup_key)
  SELECT '00000000-0000-7000-8000-0000000000a1', k, 'Contrato', '/contracts/00000000-0000-7000-8000-000000000c01', k
    FROM unnest(ARRAY['contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment']) k$$,
  'sino aceita os eventos');
SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title) VALUES ('00000000-0000-7000-8000-0000000000a1', 'contract_x', 'X')$$,
                 '23514', NULL, 'tipo de notificação fechado');

-- Auditoria ---------------------------------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = t), 'auditado: ' || t)
  FROM unnest(ARRAY['contracts', 'contract_cycles', 'contract_documents', 'contract_document_versions',
                    'contract_amendments', 'contract_renewal_tasks']) t;
SELECT ok(NOT EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'contract_document_versions'
                         AND (new_data ? 'content' OR old_data ? 'content')), 'conteúdo das versões fora do log');
SELECT is((SELECT (new_data ->> 'content_bytes')::int FROM audit_log
            WHERE table_name = 'contract_document_versions' AND record_id = '00000000-0000-7000-8000-00000000f001'),
          octet_length('# Contrato ACME'), 'log registra o tamanho do conteúdo');
SELECT is((SELECT changed_columns FROM audit_log
            WHERE table_name = 'contract_document_versions' AND record_id = '00000000-0000-7000-8000-00000000f004'
              AND action = 'update'), ARRAY['author_user_id'], 'SET NULL do autor fica no log');

-- O papel da aplicação ---------------------------------------------------------------------------------------------------
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO contract_document_versions (id, document_id, content, author_user_id)
  VALUES ('00000000-0000-7000-8000-00000000f010', '00000000-0000-7000-8000-00000000d003', 'pelo app',
          '00000000-0000-7000-8000-0000000000a1');
  UPDATE contract_documents SET current_version_id = '00000000-0000-7000-8000-00000000f010'
   WHERE id = '00000000-0000-7000-8000-00000000d003';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED$$, 'app salva uma versão');
SELECT is((SELECT version FROM contract_document_versions WHERE id = '00000000-0000-7000-8000-00000000f010'), 6, 'app: próxima versão');
SELECT lives_ok($$UPDATE contracts SET notes = 'app' WHERE id = '00000000-0000-7000-8000-000000000c01'$$, 'app edita o contrato');
SELECT lives_ok($$DELETE FROM contracts WHERE id = '00000000-0000-7000-8000-000000000c02';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED$$, 'app exclui rascunho');
SELECT throws_ok($$UPDATE contract_document_versions SET note = 'x' WHERE id = '00000000-0000-7000-8000-00000000f010'$$,
                 '23514', NULL, 'app: versão imutável');
RESET ROLE;
SELECT is((SELECT user_id FROM audit_log WHERE table_name = 'contract_document_versions'
            AND record_id = '00000000-0000-7000-8000-00000000f010'), '00000000-0000-7000-8000-0000000000a1'::uuid,
          'ator do app no log');

SELECT * FROM finish();
ROLLBACK;
