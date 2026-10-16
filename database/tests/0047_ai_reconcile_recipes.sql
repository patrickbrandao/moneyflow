-- Testes de 0047_ai_reconcile_recipes (spec 030, F16), simples: estrutura, o alvo (exatamente um, tipo e caixa dona),
-- run_on_import sem alvo no COMMIT, os limites (10 ao importar por conta, 50 por dona), as permissões e a reserva da
-- fila do import respeitando a execução ativa do lote.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

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
-- Executa e roda as checagens deferidas (como no COMMIT); em erro, desfaz tudo.
CREATE FUNCTION pg_temp.commit_err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

-- Estrutura ----------------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['ai_reconcile_recipes', 'ai_reconcile_recipe_targets',
  'ai_reconcile_recipe_runs']) t;
SELECT columns_are('ai_reconcile_recipes', ARRAY['id', 'caixa_id', 'agent_id', 'name', 'description', 'instruction',
  'run_on_import', 'position', 'is_active', 'archived_at', 'created_by_user_id', 'created_at', 'updated_at']);
SELECT columns_are('ai_reconcile_recipe_targets', ARRAY['id', 'recipe_id', 'financial_account_id', 'card_caixa_id',
  'created_at', 'updated_at']);
SELECT columns_are('ai_reconcile_recipe_runs', ARRAY['id', 'recipe_id', 'import_id', 'user_id', 'trigger_kind',
  'position', 'line_ids', 'status', 'skip_reason', 'conversation_id', 'run_id', 'started_at', 'finished_at',
  'created_at', 'updated_at']);
SELECT has_function('ai_reconcile_recipe_claim', ARRAY['uuid']);
SELECT has_function('ai_reconcile_import_busy', ARRAY['uuid']);
SELECT has_function('ai_reconcile_import_lock', ARRAY['uuid']);
SELECT has_function('ai_reconcile_recipe_pending_imports', ARRAY['integer']);
SELECT has_trigger('ai_reconcile_recipes', 'ai_reconcile_recipes_audit');
SELECT has_trigger('ai_reconcile_recipe_targets', 'ai_reconcile_recipe_targets_audit');
SELECT hasnt_trigger('ai_reconcile_recipe_runs', 'ai_reconcile_recipe_runs_audit');
SELECT table_privs_are('ai_reconcile_recipes', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE']);
SELECT table_privs_are('ai_reconcile_recipe_targets', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
SELECT table_privs_are('ai_reconcile_recipe_runs', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE']);

-- Dados base ---------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000047a1', 'bia47', 'bia47@example.com', 'segredo', 'user', true);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000047f1', 'Provedor 47', 'anthropic', 'sk-ant-api03-aaaaaaaa');
INSERT INTO ai_agents (id, name, provider_id, model, is_active) VALUES
  ('00000000-0000-7000-8000-0000000047b1', 'Agente 47', '00000000-0000-7000-8000-0000000047f1', 'claude-sonnet-4-5', true);
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000047e1', 'person', 'Bia 47'),
  ('00000000-0000-7000-8000-0000000047e2', 'company', 'Banco 47');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000047d1', 'Casa 47', 'general', '00000000-0000-7000-8000-0000000047e1', true),
  ('00000000-0000-7000-8000-0000000047d2', 'Outra 47', 'general', '00000000-0000-7000-8000-0000000047e2', false);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day,
                    card_last4) VALUES
  ('00000000-0000-7000-8000-0000000047d3', 'Cartão da Casa', 'credit_card', '00000000-0000-7000-8000-0000000047e2',
   '00000000-0000-7000-8000-0000000047d1', 100000, 3, 10, '4747'),
  ('00000000-0000-7000-8000-0000000047d4', 'Cartão da Outra', 'credit_card', '00000000-0000-7000-8000-0000000047e2',
   '00000000-0000-7000-8000-0000000047d2', 100000, 3, 10, '4748');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000047c1', '00000000-0000-7000-8000-0000000047d1', 'checking', 'Corrente Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000047c2', '00000000-0000-7000-8000-0000000047d1', 'cash', 'Cofre Casa', '2026-01-01'),
  ('00000000-0000-7000-8000-0000000047c3', '00000000-0000-7000-8000-0000000047d2', 'checking', 'Corrente Outra', '2026-01-01');

INSERT INTO ai_reconcile_recipes (id, caixa_id, agent_id, name, instruction) VALUES
  ('00000000-0000-7000-8000-000000047101', NULL, '00000000-0000-7000-8000-0000000047b1', 'Global', 'Concilie as tarifas.'),
  ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-0000000047d1', '00000000-0000-7000-8000-0000000047b1',
   'PIX do condomínio', 'Concilie o PIX do condomínio.');

-- Receitas -----------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipes (agent_id, name, instruction)
                         VALUES ('00000000-0000-7000-8000-0000000047b1', 'Longa', repeat('x', 20001))$$),
          '23514 ai_reconcile_recipes_instruction_check', 'instrução até 20 mil');
SELECT is(pg_temp.err($$UPDATE ai_reconcile_recipes SET caixa_id = '00000000-0000-7000-8000-0000000047d2'
                         WHERE id = '00000000-0000-7000-8000-000000047102'$$),
          '23514 ai_reconcile_recipes_owner_immutable_check', 'dona imutável');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_reconcile_recipes'
            AND record_id = '00000000-0000-7000-8000-000000047102'), 1, 'receita auditada');

-- Alvos --------------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id, card_caixa_id)
                         VALUES ('00000000-0000-7000-8000-000000047101', '00000000-0000-7000-8000-0000000047c1',
                                 '00000000-0000-7000-8000-0000000047d3')$$),
          '23514 ai_reconcile_recipe_targets_target_check', 'conta e cartão juntos não');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id)
                         VALUES ('00000000-0000-7000-8000-000000047101')$$),
          '23514 ai_reconcile_recipe_targets_target_check', 'nenhum dos dois não');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, card_caixa_id)
                         VALUES ('00000000-0000-7000-8000-000000047101', '00000000-0000-7000-8000-0000000047d1')$$),
          '23514 ai_reconcile_recipe_targets_kind_check', 'card_caixa_id só cartão');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-0000000047c2')$$),
          '23514 ai_reconcile_recipe_targets_kind_check', 'cofre não importa extrato');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-0000000047c3')$$),
          '23514 ai_reconcile_recipe_targets_owner_check', 'conta de outra caixa não');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, card_caixa_id)
                         VALUES ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-0000000047d4')$$),
          '23514 ai_reconcile_recipe_targets_owner_check', 'cartão de outra pagadora não');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, card_caixa_id)
                         VALUES ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-0000000047d3')$$),
          'ok', 'cartão cuja pagadora padrão é a dona');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047101', '00000000-0000-7000-8000-0000000047c3')$$),
          'ok', 'global vincula qualquer conta');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_reconcile_recipe_targets'
            AND record_id = '00000000-0000-7000-8000-000000047102'), 1, 'alvo auditado no histórico da receita');

-- run_on_import exige alvo no COMMIT ---------------------------------------------------------------------------------
SELECT is(pg_temp.commit_err($$INSERT INTO ai_reconcile_recipes (caixa_id, agent_id, name, instruction, run_on_import)
                               VALUES ('00000000-0000-7000-8000-0000000047d1', '00000000-0000-7000-8000-0000000047b1',
                                       'Sem alvo', 'x', true)$$),
          '23514 ai_reconcile_recipes_run_on_import_check', 'run_on_import sem alvo falha no COMMIT');
SELECT is(pg_temp.commit_err($$UPDATE ai_reconcile_recipes SET run_on_import = true
                               WHERE id = '00000000-0000-7000-8000-000000047102'$$),
          'ok', 'run_on_import com alvo passa');
SELECT is(pg_temp.commit_err($$DELETE FROM ai_reconcile_recipe_targets
                               WHERE recipe_id = '00000000-0000-7000-8000-000000047102'$$),
          '23514 ai_reconcile_recipes_run_on_import_check', 'tirar o último alvo de run_on_import falha no COMMIT');

-- Limite de 10 ao importar por conta ---------------------------------------------------------------------------------
INSERT INTO ai_reconcile_recipes (id, caixa_id, agent_id, name, instruction, run_on_import, position)
SELECT ('00000000-0000-7000-8000-0000000472' || lpad(i::text, 2, '0'))::uuid, '00000000-0000-7000-8000-0000000047d1',
       '00000000-0000-7000-8000-0000000047b1', 'Import ' || i, 'x', true, i
  FROM generate_series(1, 11) i;
INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
SELECT ('00000000-0000-7000-8000-0000000472' || lpad(i::text, 2, '0'))::uuid, '00000000-0000-7000-8000-0000000047c1'
  FROM generate_series(1, 10) i;
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047211', '00000000-0000-7000-8000-0000000047c1')$$),
          '23514 ai_reconcile_recipe_targets_import_limit_check', 'a 11ª receita ao importar na conta não entra');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047101', '00000000-0000-7000-8000-0000000047c1')$$),
          'ok', 'sem run_on_import não conta no limite');
SELECT is(pg_temp.err($$UPDATE ai_reconcile_recipes SET run_on_import = true
                         WHERE id = '00000000-0000-7000-8000-000000047101'$$),
          '23514 ai_reconcile_recipe_targets_import_limit_check', 'ligar run_on_import também confere o limite');
UPDATE ai_reconcile_recipes SET is_active = false, archived_at = now() WHERE id = '00000000-0000-7000-8000-000000047201';
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
                         VALUES ('00000000-0000-7000-8000-000000047211', '00000000-0000-7000-8000-0000000047c1')$$),
          'ok', 'arquivada libera a vaga');
SELECT is(pg_temp.commit_err('SELECT 1'), 'ok', 'receitas ao importar com alvo passam no COMMIT');

-- Limite de 50 por dona ----------------------------------------------------------------------------------------------
INSERT INTO ai_reconcile_recipes (agent_id, name, instruction)
SELECT '00000000-0000-7000-8000-0000000047b1', 'Global ' || i, 'x' FROM generate_series(2, 50) i;
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipes (agent_id, name, instruction)
                         VALUES ('00000000-0000-7000-8000-0000000047b1', 'Global 51', 'x')$$),
          '23514 ai_reconcile_recipes_active_limit_check', 'no máximo 50 globais');

-- Permissões ---------------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is(pg_temp.err($$DELETE FROM ai_reconcile_recipes WHERE id = '00000000-0000-7000-8000-000000047102'$$),
          '42501 ', 'receita não é excluída pela aplicação (arquive)');
RESET ROLE;

-- Fila do import -----------------------------------------------------------------------------------------------------
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000047a9', 'extrato.ofx', 'application/x-ofx', '\x4f4658');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-000000047301', '00000000-0000-7000-8000-0000000047c1', 'ofx',
   '00000000-0000-7000-8000-0000000047a9', '2026-10-01', '2026-10-31');
INSERT INTO ai_reconcile_recipe_runs (id, recipe_id, import_id, user_id, trigger_kind, position, status) VALUES
  ('00000000-0000-7000-8000-000000047401', '00000000-0000-7000-8000-000000047202', '00000000-0000-7000-8000-000000047301',
   '00000000-0000-7000-8000-0000000047a1', 'import', 2, 'queued'),
  ('00000000-0000-7000-8000-000000047402', '00000000-0000-7000-8000-000000047203', '00000000-0000-7000-8000-000000047301',
   '00000000-0000-7000-8000-0000000047a1', 'import', 3, 'queued');
SELECT is(pg_temp.err($$INSERT INTO ai_reconcile_recipe_runs (recipe_id, import_id, user_id, trigger_kind, status)
                         VALUES ('00000000-0000-7000-8000-000000047102', '00000000-0000-7000-8000-000000047301',
                                 '00000000-0000-7000-8000-0000000047a1', 'manual', 'queued')$$),
          '23514 ai_reconcile_recipe_runs_queued_check', 'só a fila do import fica queued');

-- Uma conciliação do lote com execução ativa segura a fila.
INSERT INTO ai_conversations (id, user_id, agent_id, purpose, title, screen_context) VALUES
  ('00000000-0000-7000-8000-000000047501', '00000000-0000-7000-8000-0000000047a1', '00000000-0000-7000-8000-0000000047b1',
   'reconcile_statement', 'Conciliação', '{"importId": "00000000-0000-7000-8000-000000047301"}');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000047601', '00000000-0000-7000-8000-000000047501', '00000000-0000-7000-8000-0000000047a1',
   '00000000-0000-7000-8000-0000000047b1');
SELECT is(ai_reconcile_import_busy('00000000-0000-7000-8000-000000047301'), true, 'lote ocupado');
SELECT is((SELECT count(*)::int FROM ai_reconcile_recipe_pending_imports()), 0, 'lote ocupado não aparece para o worker');
SELECT is((SELECT count(*)::int FROM ai_reconcile_recipe_claim('00000000-0000-7000-8000-000000047301')), 0,
          'com execução ativa no lote, nada é reservado');

UPDATE ai_runs SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-000000047601';
SELECT is((SELECT import_id FROM ai_reconcile_recipe_pending_imports()), '00000000-0000-7000-8000-000000047301'::uuid,
          'lote livre com fila aparece para o worker');
SET LOCAL ROLE moneyflow_app;
SELECT results_eq($$SELECT recipe_run_id, "position" FROM ai_reconcile_recipe_claim('00000000-0000-7000-8000-000000047301')$$,
                  $$VALUES ('00000000-0000-7000-8000-000000047401'::uuid, 2)$$,
                  'reserva a próxima por position (pela aplicação)');
RESET ROLE;
SELECT is((SELECT status FROM ai_reconcile_recipe_runs WHERE id = '00000000-0000-7000-8000-000000047401'), 'started',
          'a reservada fica started');
SELECT is((SELECT count(*)::int FROM ai_reconcile_recipe_claim('00000000-0000-7000-8000-000000047301')), 0,
          'a recém-reservada (sem execução ainda) segura a fila');

-- A reservada começa e liga sessão e execução; enquanto a execução está ativa, a fila espera.
INSERT INTO ai_conversations (id, user_id, agent_id, purpose, title, screen_context) VALUES
  ('00000000-0000-7000-8000-000000047502', '00000000-0000-7000-8000-0000000047a1', '00000000-0000-7000-8000-0000000047b1',
   'reconcile_statement', 'Receita', '{"importId": "00000000-0000-7000-8000-000000047301"}');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000047602', '00000000-0000-7000-8000-000000047502', '00000000-0000-7000-8000-0000000047a1',
   '00000000-0000-7000-8000-0000000047b1');
UPDATE ai_reconcile_recipe_runs
   SET conversation_id = '00000000-0000-7000-8000-000000047502', run_id = '00000000-0000-7000-8000-000000047602',
       line_ids = ARRAY['00000000-0000-7000-8000-000000047701'::uuid]
 WHERE id = '00000000-0000-7000-8000-000000047401';
SELECT is((SELECT count(*)::int FROM ai_reconcile_recipe_claim('00000000-0000-7000-8000-000000047301')), 0,
          'execução da receita ativa segura a fila');
UPDATE ai_runs SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-000000047602';
UPDATE ai_reconcile_recipe_runs SET status = 'failed', skip_reason = 'canceled'
 WHERE id = '00000000-0000-7000-8000-000000047401';
SELECT is((SELECT recipe_run_id FROM ai_reconcile_recipe_claim('00000000-0000-7000-8000-000000047301')),
          '00000000-0000-7000-8000-000000047402'::uuid, 'terminada a anterior, reserva a seguinte');
SELECT is(pg_temp.err($$UPDATE ai_reconcile_recipe_runs SET status = 'started'
                         WHERE id = '00000000-0000-7000-8000-000000047401'$$),
          '23514 ai_reconcile_recipe_runs_status_transition_check', 'failed é final');

SELECT * FROM finish();
ROLLBACK;
